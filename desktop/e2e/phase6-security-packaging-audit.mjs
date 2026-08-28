/**
 * No-cost Phase 6 audit probe for installed trust boundaries, daemon access,
 * packaging provenance, and updater state. No provider is invoked and no
 * updater/install action is taken. Temporary projects are fixture-owned and
 * the user's recent-project list is restored byte-for-byte in `finally`.
 *
 * Usage (from desktop/): node e2e/phase6-security-packaging-audit.mjs
 */
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Builder, By, Capabilities, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedCoreCli = path.join(installedRoot, "core", "dist", "src", "cli.js");
const installedVersion = (
  await readFile(path.resolve("src-tauri", "gen", "app-version.txt"), "utf8")
).trim();
const installer = path.resolve(
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `Hivemind AI_${installedVersion}_x64-setup.exe`
);
const evidenceDir = path.resolve(
  "..",
  "docs",
  "evidence",
  `full-audit-phase6-${installedVersion}`
);
const recentProjectsPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const signingKey = path.join(
  process.env.APPDATA ?? "",
  "Hivemind AI",
  "updater",
  "hivemind-updater.key"
);
const helperPidPath = path.join(installedRoot, "update-helper.pid");

let driver;
let tauriDriver;
let directApp;
let activeRepo;
let recentProjectsBefore = null;
let recentProjectsExisted = false;
const transport = [];
const evidence = {
  installedBinary,
  installedVersion,
  installer,
  paidProviderCalls: 0,
  unauthenticatedDaemonAction: {},
  noBundledNodeRuntime: {},
  productionCliOverride: {},
  spoofedOwnSource: {},
  packageContents: {},
  signatures: {},
  signingKey: {},
  updaterHelper: {},
  publicUpdater: {},
  rustAdvisoryGate: {},
  browserSevereLogs: [],
  recentProjects: {},
  error: null
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  assert.ok(existsSync(installedCoreCli), `installed Core missing: ${installedCoreCli}`);
  assert.ok(existsSync(installer), `built installer missing: ${installer}`);
  assert.equal(
    await isProcessRunning("hivemind_desktop.exe"),
    false,
    "close the installed Hivemind app before this isolated audit probe"
  );
  assert.equal(
    await isProcessRunning("tauri-driver.exe"),
    false,
    "another tauri-driver session is already running"
  );

  await rm(evidenceDir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidenceDir, { recursive: true });
  if (existsSync(recentProjectsPath)) {
    recentProjectsExisted = true;
    recentProjectsBefore = await readFile(recentProjectsPath);
    evidence.recentProjects.beforeSha256 = sha256(recentProjectsBefore);
  }

  await collectStaticPackageEvidence();
  const fixture = await import(
    pathToFileURL(path.resolve("..", "dist", "test", "support", "manager-fixture.js")).href
  );
  await fixture.withTempRepo(async ({ repo }) => {
    activeRepo = repo;
    await probeUnauthenticatedDaemon(repo, fixture);
    await probeInstalledWithoutNode(repo);
    await probeProductionCliOverride(repo);
    await probeSpoofedOwnSource(repo);
  });
  validateObservedFindings();
} catch (error) {
  evidence.error = error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: String(error), stack: null };
  throw error;
} finally {
  await closeInstalledSession();
  await closeDirectApp();
  if (activeRepo !== undefined) await stopFixtureDaemon(activeRepo);
  if (recentProjectsExisted && recentProjectsBefore !== null) {
    await mkdir(path.dirname(recentProjectsPath), { recursive: true });
    await writeFile(recentProjectsPath, recentProjectsBefore);
    const restored = await readFile(recentProjectsPath);
    evidence.recentProjects.afterSha256 = sha256(restored);
    evidence.recentProjects.restoredExactly = sha256(restored) === sha256(recentProjectsBefore);
  } else if (!recentProjectsExisted) {
    await rm(recentProjectsPath, { force: true }).catch(() => undefined);
    evidence.recentProjects.restoredExactly = !existsSync(recentProjectsPath);
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(evidenceDir, "phase6-security-packaging-audit.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  ).catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), transport.join(""), "utf8").catch(
    () => undefined
  );
}

assert.equal(evidence.recentProjects.restoredExactly, true);
console.log(JSON.stringify(evidence, null, 2));
console.log(`evidence: ${evidenceDir}`);

async function collectStaticPackageEvidence() {
  const packageStats = await treeStats(path.join(installedRoot, "core"));
  const bundledNodeExecutables = await findNames(installedRoot, new Set(["node.exe", "node"]));
  const devDependencyExamples = [
    path.join(installedRoot, "core", "node_modules", "typescript"),
    path.join(installedRoot, "core", "node_modules", "@types"),
    path.join(installedRoot, "core", "node_modules", ".bin")
  ].filter((entry) => existsSync(entry));
  evidence.packageContents = {
    coreFiles: packageStats.files,
    coreBytes: packageStats.bytes,
    coreMiB: Number((packageStats.bytes / 1024 / 1024).toFixed(1)),
    bundledNodeExecutables,
    devDependencyExamples
  };

  evidence.signatures.installedExecutable = await authenticode(installedBinary);
  evidence.signatures.builtInstaller = await authenticode(installer);

  evidence.signingKey = {
    exists: existsSync(signingKey),
    ...(existsSync(signingKey)
      ? {
          bytes: (await stat(signingKey)).size,
          acl: await runText("icacls", [signingKey])
        }
      : {})
  };

  if (existsSync(helperPidPath)) {
    const pidText = (await readFile(helperPidPath, "utf8")).trim();
    const pid = Number(pidText);
    evidence.updaterHelper = {
      pidPath: helperPidPath,
      pidText,
      pidIsInteger: Number.isSafeInteger(pid) && pid > 0,
      processCurrentlyPresent: Number.isSafeInteger(pid) && pid > 0
        ? await processIdExists(pid)
        : false,
      lastWriteTime: (await stat(helperPidPath)).mtime.toISOString()
    };
  } else {
    evidence.updaterHelper = { pidPath: helperPidPath, exists: false };
  }

  const config = JSON.parse(await readFile(path.resolve("src-tauri", "tauri.conf.json"), "utf8"));
  const endpoint = config.plugins?.updater?.endpoints?.[0];
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json", "User-Agent": "Hivemind-Phase6-Audit" },
    redirect: "follow"
  });
  const manifest = response.ok ? await response.json() : null;
  evidence.publicUpdater = {
    endpoint,
    httpStatus: response.status,
    publicVersion: manifest?.version ?? null,
    localVersion: installedVersion,
    matchesLocalVersion: manifest?.version === installedVersion
  };

  const cargoAudit = spawnSync("cargo", ["audit", "-V"], {
    cwd: path.resolve("src-tauri"),
    windowsHide: true,
    encoding: "utf8"
  });
  evidence.rustAdvisoryGate = {
    cargoAuditExitCode: cargoAudit.status,
    stdout: cargoAudit.stdout?.trim() ?? "",
    stderr: cargoAudit.stderr?.trim() ?? ""
  };
}

async function probeUnauthenticatedDaemon(repo, fixture) {
  const marker = path.join(repo, "phase6-unauthenticated-action.txt");
  const daemon = await fixture.startDaemon(repo);
  try {
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('phase6-unauthenticated-action.txt','executed')"`;
    const response = await fetch(`${daemon.url}/workspace/action`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://untrusted.example"
      },
      body: JSON.stringify({ type: "checks.try", payload: { command } })
    });
    const body = await response.json();
    evidence.unauthenticatedDaemonAction = {
      url: daemon.url,
      sentAuthorizationHeader: false,
      sentOrigin: "https://untrusted.example",
      sentContentType: "text/plain",
      httpStatus: response.status,
      responseOk: body.ok,
      responseBody: {
        ok: body.ok,
        reason: body.reason ?? null,
        trial: body.value?.trial ?? null
      },
      markerCreated: existsSync(marker),
      markerContents: existsSync(marker) ? await readFile(marker, "utf8") : null
    };
  } finally {
    await fixture.stopDaemon(daemon);
  }
}

async function probeInstalledWithoutNode(repo) {
  const restrictedPath = [
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
    path.dirname((await commandPath("git"))),
    path.dirname((await commandPath("tauri-driver"))),
    path.dirname((await commandPath("msedgedriver")))
  ].filter((entry, index, all) => all.indexOf(entry) === index).join(path.delimiter);
  assert.equal(restrictedPath.toLowerCase().includes(path.dirname(process.execPath).toLowerCase()), false);

  await startInstalledSession({ Path: restrictedPath, PATH: restrictedPath });
  await driver.manage().window().setRect({ x: -1800, y: 0, width: 1440, height: 900 });
  await submitProjectDialog(repo);
  await driver.wait(
    async () => /node|query Hivemind Core|start Hivemind daemon/iu.test(await bodyText()),
    30_000,
    "the installed app did not report its missing Node runtime"
  );
  const body = await bodyText();
  evidence.noBundledNodeRuntime = {
    restrictedPath,
    nodeDirectoryExcluded: true,
    errorText: body.split(/\r?\n/u).filter((line) => /node|Hivemind Core|daemon/iu.test(line)).slice(0, 8)
  };
  await capture("01-installed-without-node-1440x900");
  await closeInstalledSession();
}

async function probeProductionCliOverride(repo) {
  const marker = path.join(repo, "phase6-cli-override.log");
  const override = path.join(repo, "phase6-cli-override.js");
  await writeFile(
    override,
    [
      'const { appendFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      `appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      "const env = { ...process.env };",
      "delete env.HIVEMIND_CLI_PATH;",
      `const result = spawnSync(process.execPath, [${JSON.stringify(installedCoreCli)}, ...process.argv.slice(2)], { cwd: process.cwd(), env, stdio: "inherit" });`,
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      ""
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    recentProjectsPath,
    `${JSON.stringify([{ path: repo, opened_at: String(Math.floor(Date.now() / 1000)) }], null, 2)}\n`,
    "utf8"
  );
  directApp = spawn(installedBinary, [], {
    env: {
      ...process.env,
      HIVEMIND_CLI_PATH: override,
      HIVEMIND_NODE_PATH: process.execPath
    },
    windowsHide: true,
    stdio: "ignore"
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(marker), "the configured production CLI override was never executed");
  const invocations = (await readFile(marker, "utf8")).trim().split(/\r?\n/u).map(JSON.parse);
  evidence.productionCliOverride = {
    configuredPath: override,
    markerCreated: true,
    invocations,
    shellIdentityInvocationObserved: invocations.some((args) => args[0] === "shell-build-id"),
    daemonInvocationObserved: invocations.some((args) => args[0] === "daemon"),
    installedExecutableLaunchedDirectly: true
  };
  await closeDirectApp();
  await stopFixtureDaemon(repo);
}

async function probeSpoofedOwnSource(repo) {
  const configDir = path.join(repo, "desktop", "src-tauri");
  const sourceDir = path.join(repo, "src");
  const sourceFile = path.join(sourceDir, "phase6-future-source.ts");
  await mkdir(configDir, { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    path.join(configDir, "tauri.conf.json"),
    JSON.stringify({ note: "not Hivemind source; contains ai.hivemind.desktop only to test identity" }),
    "utf8"
  );
  await writeFile(sourceFile, "export const notHivemind = true;\n", "utf8");
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await utimes(sourceFile, future, future);

  await startInstalledSession();
  await driver.manage().window().setRect({ x: -1800, y: 0, width: 1440, height: 900 });
  await driver.wait(
    async () => (await bodyText()).includes("A newer version is ready to build"),
    45_000,
    "the spoofed source tree was not accepted as Hivemind's own source"
  );
  const body = await bodyText();
  evidence.spoofedOwnSource = {
    configContainsOnlyIdentifierSubstring: true,
    futureSourceMtime: future.toISOString(),
    sourceUpdateOffered: body.includes("A newer version is ready to build"),
    buildAndRestartOffered: body.includes("Build and restart"),
    buildButtonPressed: false
  };
  await capture("03-spoofed-own-source-offer-1440x900");
  await closeInstalledSession();
  await stopFixtureDaemon(repo);
}

function validateObservedFindings() {
  assert.equal(evidence.unauthenticatedDaemonAction.httpStatus, 200);
  assert.equal(evidence.unauthenticatedDaemonAction.responseOk, true);
  assert.equal(evidence.unauthenticatedDaemonAction.markerCreated, true);
  assert.equal(evidence.unauthenticatedDaemonAction.markerContents, "executed");
  assert.deepEqual(evidence.packageContents.bundledNodeExecutables, []);
  assert.ok(evidence.noBundledNodeRuntime.errorText.length > 0);
  assert.equal(evidence.productionCliOverride.markerCreated, true);
  assert.equal(evidence.productionCliOverride.shellIdentityInvocationObserved, true);
  assert.equal(evidence.spoofedOwnSource.sourceUpdateOffered, true);
  assert.equal(evidence.spoofedOwnSource.buildAndRestartOffered, true);
  assert.equal(evidence.spoofedOwnSource.buildButtonPressed, false);
  assert.equal(evidence.signatures.installedExecutable.Status, "NotSigned");
  assert.equal(evidence.signatures.builtInstaller.Status, "NotSigned");
  assert.ok(evidence.packageContents.devDependencyExamples.length >= 3);
  assert.equal(evidence.updaterHelper.pidIsInteger, true);
  assert.equal(evidence.updaterHelper.processCurrentlyPresent, false);
  assert.equal(evidence.publicUpdater.httpStatus, 200);
  assert.equal(evidence.publicUpdater.matchesLocalVersion, false);
  assert.notEqual(evidence.rustAdvisoryGate.cargoAuditExitCode, 0);
  assert.equal(evidence.paidProviderCalls, 0);
}

async function startInstalledSession(extraEnv = {}) {
  tauriDriver = spawn("tauri-driver", [], {
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  tauriDriver.stdout.on("data", (chunk) => transport.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => transport.push(`stderr ${chunk}`));
  await waitForDriver();
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await waitForBody();
}

async function closeInstalledSession() {
  await driver?.quit().catch(() => undefined);
  driver = undefined;
  tauriDriver?.kill();
  tauriDriver = undefined;
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
}

async function closeDirectApp() {
  if (directApp === undefined) return;
  directApp.kill();
  directApp = undefined;
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
}

async function submitProjectDialog(wantedPath) {
  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  const openAnother = await driver.wait(
    until.elementLocated(By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')),
    10_000
  );
  await openAnother.click();
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  await driver.executeScript(
    `const input = document.getElementById("project-path");
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
     setter.call(input, arguments[0]);
     input.dispatchEvent(new Event("input", { bubbles: true }));`,
    wantedPath
  );
  await driver.findElement(By.xpath('//button[contains(normalize-space(.), "Open project")]')).click();
}

async function openProjectAndWait(wantedPath) {
  await submitProjectDialog(wantedPath);
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000,
    "the project dialog did not close"
  );
}

async function waitForBody() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await bodyText()).trim() !== "") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the installed application rendered no readable body within 30 seconds");
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tauriDriver.exitCode !== null) {
      throw new Error(`tauri-driver exited before accepting sessions (${tauriDriver.exitCode})`);
    }
    try {
      if ((await fetch(`${driverUrl}/status`)).ok) return;
    } catch {
      // Read-only readiness poll.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("tauri-driver did not become ready within 20 seconds");
}

async function capture(name) {
  const image = await driver.takeScreenshot();
  await writeFile(path.join(evidenceDir, `${name}.png`), Buffer.from(image, "base64"));
}

async function bodyText() {
  return driver.executeScript("return document.body?.innerText ?? ''");
}

async function authenticode(file) {
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}' | Select-Object @{n='Status';e={$_.Status.ToString()}},StatusMessage,Path | ConvertTo-Json -Compress`;
  const raw = await runText("pwsh.exe", ["-NoProfile", "-Command", script]);
  return JSON.parse(raw);
}

async function commandPath(name) {
  const script = `(Get-Command '${name.replaceAll("'", "''")}').Source`;
  return (await runText("pwsh.exe", ["-NoProfile", "-Command", script])).trim();
}

async function runText(file, args) {
  const result = await run(file, args, { windowsHide: true, encoding: "utf8" });
  return result.stdout.trim();
}

async function treeStats(root) {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await treeStats(target);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await stat(target)).size;
    }
  }
  return { files, bytes };
}

async function findNames(root, wanted) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await findNames(target, wanted));
    else if (entry.isFile() && wanted.has(entry.name.toLowerCase())) found.push(target);
  }
  return found;
}

async function processIdExists(pid) {
  const output = await runText("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  return !output.toLowerCase().includes("no tasks are running") && output.includes(`\"${pid}\"`);
}

async function isProcessRunning(name) {
  const output = await runText("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"]);
  return output.toLowerCase().includes(name.toLowerCase());
}

async function waitForProcessExit(name, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not exit within ${timeout}ms`);
}

async function stopFixtureDaemon(root) {
  const statePath = path.join(root, ".hivemind", "daemon.json");
  if (!existsSync(statePath)) return;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (!Number.isSafeInteger(state.pid) || state.pid <= 0) return;
    await run("taskkill", ["/PID", String(state.pid), "/T", "/F"], {
      windowsHide: true
    }).catch(() => undefined);
  } catch {
    // The fixture helper removes the exact temporary project.
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
