/**
 * Installed Phase 2 proof. A release build must ignore both development-only
 * executable overrides while still opening a real project through packaged
 * Core. The positive `Live` assertion prevents a broken launch from satisfying
 * either negative override assertion.
 */
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Builder, Capabilities, logging } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedCoreCli = path.join(installedRoot, "core", "dist", "src", "cli.js");
const installedVersion = (
  await readFile(path.resolve("src-tauri", "gen", "app-version.txt"), "utf8")
).trim();
const evidenceDir = path.resolve(
  "..",
  "docs",
  "evidence",
  `remediation-phase2-${installedVersion}`
);
const recentProjectsPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const sourceCoreCli = path.resolve("..", "dist", "src", "cli.js");

let repo;
let daemonPid;
let cliMarker;
let recentProjectsBefore = null;
let recentProjectsExisted = false;
const evidence = {
  installedBinary,
  installedVersion,
  viewport: { width: 1440, height: 900 },
  paidProviderCalls: 0,
  cliOverride: {},
  nodeOverride: {},
  browserSevereLogs: [],
  recentProjects: {},
  screenshots: [],
  error: null
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  assert.ok(existsSync(installedCoreCli), `installed Core missing: ${installedCoreCli}`);
  await rm(evidenceDir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidenceDir, { recursive: true });

  if (existsSync(recentProjectsPath)) {
    recentProjectsExisted = true;
    recentProjectsBefore = await readFile(recentProjectsPath);
    evidence.recentProjects.beforeSha256 = sha256(recentProjectsBefore);
  }

  repo = await createFixtureProject();
  await setFixtureAsRecent(repo);
  const marker = path.join(repo, "release-cli-override-executed.jsonl");
  cliMarker = marker;
  const override = path.join(repo, "release-cli-override.js");
  await writeFile(
    override,
    [
      'const { appendFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      `appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      "const env = { ...process.env };",
      "delete env.HIVEMIND_CLI_PATH;",
      "delete env.HIVEMIND_NODE_PATH;",
      `const result = spawnSync(process.execPath, [${JSON.stringify(installedCoreCli)}, ...process.argv.slice(2)], { cwd: process.cwd(), env, stdio: "inherit" });`,
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      ""
    ].join("\n"),
    "utf8"
  );

  const cliSession = await runInstalledSession(
    repo,
    {
      HIVEMIND_CLI_PATH: override,
      HIVEMIND_NODE_PATH: process.execPath
    },
    "cli-override"
  );
  const markerCreated = existsSync(marker);
  const invocations = markerCreated
    ? (await readFile(marker, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse)
    : [];
  evidence.cliOverride = {
    projectReachedLive: cliSession.live,
    selectedProjectVisible: cliSession.selectedProjectVisible,
    markerCreated,
    invocations
  };
  evidence.browserSevereLogs.push(...cliSession.severeLogs);
  evidence.screenshots.push(cliSession.screenshot);
  assert.equal(
    markerCreated,
    false,
    `release executed HIVEMIND_CLI_PATH before trusting packaged Core: ${JSON.stringify(invocations)}`
  );

  const impossibleNode = path.join(repo, "does-not-exist", "node.exe");
  const nodeSession = await runInstalledSession(
    repo,
    { HIVEMIND_NODE_PATH: impossibleNode },
    "node-override"
  );
  evidence.nodeOverride = {
    configuredPathExists: existsSync(impossibleNode),
    projectReachedLive: nodeSession.live,
    selectedProjectVisible: nodeSession.selectedProjectVisible
  };
  evidence.browserSevereLogs.push(...nodeSession.severeLogs);
  evidence.screenshots.push(nodeSession.screenshot);
  assert.equal(nodeSession.live, true);
  assert.equal(existsSync(impossibleNode), false);
  assert.deepEqual(evidence.browserSevereLogs, []);
} catch (error) {
  if (cliMarker !== undefined) {
    const markerCreated = existsSync(cliMarker);
    evidence.cliOverride = {
      ...evidence.cliOverride,
      markerCreatedBeforeFailure: markerCreated,
      invocationsBeforeFailure: markerCreated
        ? (await readFile(cliMarker, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse)
        : []
    };
  }
  evidence.error = error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: String(error), stack: null };
  throw error;
} finally {
  if (repo !== undefined) {
    const statePath = path.join(repo, ".hivemind", "daemon.json");
    if (existsSync(statePath)) {
      try {
        daemonPid = Number(JSON.parse(await readFile(statePath, "utf8")).pid);
      } catch {
        daemonPid = undefined;
      }
    }
  }
  if (Number.isSafeInteger(daemonPid) && daemonPid > 0) {
    spawnSync("taskkill", ["/PID", String(daemonPid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
  }
  if (recentProjectsExisted && recentProjectsBefore !== null) {
    await mkdir(path.dirname(recentProjectsPath), { recursive: true });
    await writeFile(recentProjectsPath, recentProjectsBefore);
    const restored = await readFile(recentProjectsPath);
    evidence.recentProjects.afterSha256 = sha256(restored);
    evidence.recentProjects.restoredExactly = sha256(restored) === sha256(recentProjectsBefore);
  } else {
    await rm(recentProjectsPath, { force: true }).catch(() => undefined);
    evidence.recentProjects.restoredExactly = !existsSync(recentProjectsPath);
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(evidenceDir, "result.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  ).catch(() => undefined);
  if (repo !== undefined) {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

assert.equal(evidence.recentProjects.restoredExactly, true);
assert.equal(evidence.error, null);
console.log(`installed release runtime provenance passed for ${installedVersion}`);
console.log(`evidence: ${evidenceDir}`);

async function runInstalledSession(project, overrides, label) {
  let driver;
  let tauriDriver;
  const transport = [];
  try {
    tauriDriver = spawn("tauri-driver", [], {
      env: { ...process.env, ...overrides },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    tauriDriver.stdout.on("data", (chunk) => transport.push(`stdout ${String(chunk)}`));
    tauriDriver.stderr.on("data", (chunk) => transport.push(`stderr ${String(chunk)}`));
    await waitForDriver(tauriDriver);

    const capabilities = new Capabilities();
    capabilities.setBrowserName("wry");
    capabilities.set("tauri:options", { application: installedBinary });
    capabilities.setLoggingPrefs({ browser: "ALL" });
    driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
    await driver.manage().window().setRect({ x: -1800, y: 0, width: 1440, height: 900 });
    try {
      await driver.wait(
        async () => driver.executeScript(
          `return [...document.querySelectorAll('[aria-live="polite"]')]
            .some((element) => (element.textContent ?? '').trim().toLowerCase() === 'live');`
        ),
        30_000,
        `${label}: installed project never reached Live`
      );
    } catch (error) {
      const body = String(await driver.executeScript("return document.body?.innerText ?? ''"));
      const diagnostic = path.join(
        evidenceDir,
        `installed-${label}-failure-${installedVersion}-1440x900.png`
      );
      await writeFile(diagnostic, await driver.takeScreenshot(), "base64");
      evidence.screenshots.push(diagnostic);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; visible body: ${body.slice(0, 1200)}`
      );
    }
    const body = await driver.executeScript("return document.body?.innerText ?? ''");
    assert.ok(String(body).includes(path.basename(project)), `${label}: selected project not visible`);
    const screenshot = path.join(
      evidenceDir,
      `installed-${label}-${installedVersion}-1440x900.png`
    );
    await writeFile(screenshot, await driver.takeScreenshot(), "base64");
    const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER);
    const severeLogs = browserLogs.filter((entry) => entry.level?.name === "SEVERE");
    return {
      live: true,
      selectedProjectVisible: true,
      screenshot,
      severeLogs
    };
  } finally {
    await driver?.quit().catch(() => undefined);
    if (tauriDriver !== undefined) {
      tauriDriver.kill();
      await Promise.race([
        new Promise((resolve) => tauriDriver.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    assert.equal(
      transport.some((line) => /HIVEMIND_(?:CLI|NODE)_PATH/u.test(line)),
      false,
      `${label}: driver logs exposed override environment details`
    );
  }
}

async function createFixtureProject() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hivemind-phase2-runtime-"));
  await run("git", ["init", "-q"], { cwd: fixture, windowsHide: true });
  await run("git", ["config", "user.name", "Hivemind Phase 2"], {
    cwd: fixture,
    windowsHide: true
  });
  await run("git", ["config", "user.email", "phase2@example.test"], {
    cwd: fixture,
    windowsHide: true
  });
  await writeFile(path.join(fixture, "README.md"), "# Phase 2 release runtime fixture\n");
  await run("git", ["add", "README.md"], { cwd: fixture, windowsHide: true });
  await run("git", ["commit", "-q", "-m", "fixture"], { cwd: fixture, windowsHide: true });
  await run(process.execPath, [sourceCoreCli, "init"], { cwd: fixture, windowsHide: true });
  return fixture;
}

async function setFixtureAsRecent(project) {
  await mkdir(path.dirname(recentProjectsPath), { recursive: true });
  await writeFile(
    recentProjectsPath,
    `${JSON.stringify([{ path: project, opened_at: String(Math.floor(Date.now() / 1000)) }], null, 2)}\n`,
    "utf8"
  );
}

async function waitForDriver(processHandle) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`tauri-driver exited before accepting sessions (${processHandle.exitCode})`);
    }
    try {
      const response = await fetch(`${driverUrl}/status`);
      if (response.ok) return;
    } catch {
      // Read-only readiness retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("tauri-driver did not become ready within 20 seconds");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
