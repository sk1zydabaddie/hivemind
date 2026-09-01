/**
 * No-cost Phase 2 audit probe for the INSTALLED application.
 *
 * This is deliberately a finding probe rather than a passing acceptance test:
 * it records the current installed behavior at the exact controls under test.
 * It never starts a provider or model. The temporary projects and the user's
 * recent-project registry are restored in `finally`.
 *
 * Usage: node e2e/phase2-lifecycle-audit.mjs
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Builder, By, Capabilities, logging, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedBinary = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Hivemind AI",
  "hivemind_desktop.exe"
);
const installedCore = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Hivemind AI",
  "core",
  "dist",
  "src",
  "config-actions.js"
);
const installedProviderAuthentication = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Hivemind AI",
  "core",
  "dist",
  "src",
  "provider-auth-status.js"
);
const recentProjectsPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const evidenceDir = path.resolve(
  "..",
  "docs",
  "evidence",
  "full-audit-phase2-26.826.1622"
);

let tauriDriver;
let driver;
let fixtureRoot;
let recentProjectsBefore = null;
const transport = [];
const evidence = {
  installedBinary,
  installedVersion: "26.826.1622",
  paidProviderCalls: 0,
  recentProjects: {},
  missingCliProbe: {},
  manualInvalidPath: {},
  nestedSource: {},
  gitSafety: {},
  automaticCheck: {},
  providers: {},
  gitSetup: {},
  corruptArtifacts: {},
  browserSevereLogs: []
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  assert.ok(existsSync(installedCore), `installed Core missing: ${installedCore}`);
  assert.ok(
    existsSync(installedProviderAuthentication),
    `installed provider authentication module missing: ${installedProviderAuthentication}`
  );
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
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "hivemind-phase2-audit-"));
  assert.equal(
    path.dirname(fixtureRoot),
    path.resolve(os.tmpdir()),
    "the audit fixture must stay inside the system temporary directory"
  );

  const nestedSource = path.join(fixtureRoot, "nested-source-only");
  const secretPattern = path.join(fixtureRoot, "secret-pattern");
  const nestedDependencies = path.join(fixtureRoot, "nested-dependencies");
  const automaticCheck = path.join(fixtureRoot, "automatic-check");
  const oneClickGit = path.join(fixtureRoot, "one-click-git");
  const invalidPath = path.join(fixtureRoot, "does-not-exist");
  await createFixtures({
    nestedSource,
    secretPattern,
    nestedDependencies,
    automaticCheck,
    oneClickGit
  });

  if (existsSync(recentProjectsPath)) {
    recentProjectsBefore = await readFile(recentProjectsPath);
    const parsed = JSON.parse(recentProjectsBefore.toString("utf8"));
    evidence.recentProjects = {
      beforeSha256: sha256(recentProjectsBefore),
      entries: Array.isArray(parsed) ? parsed : parsed.entries,
      pathsThatLookLikeTestFixtures: (Array.isArray(parsed) ? parsed : parsed.entries ?? [])
        .map((entry) => entry?.path)
        .filter((entry) => typeof entry === "string" && /hivemind.*(?:e2e|fresh|walk|check)/iu.test(entry))
    };
  }

  const missingCliScript = `
    const module = await import(${JSON.stringify(pathToFileUrl(installedProviderAuthentication))});
    const view = await module.inspectProviderAuthentication(${JSON.stringify(process.cwd())});
    console.log(JSON.stringify(view));
  `;
  const { stdout: missingCliOutput } = await run(
    process.execPath,
    ["--input-type=module", "-e", missingCliScript],
    {
      windowsHide: true,
      env: { ...process.env, PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") }
    }
  );
  evidence.missingCliProbe = JSON.parse(missingCliOutput);

  tauriDriver = spawn("tauri-driver", [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  tauriDriver.stdout.on("data", (chunk) => transport.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => transport.push(`stderr ${chunk}`));
  await waitForDriver();

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await waitForBody();
  /* Keep the installed window off the active screen. WebDriver addresses the
     WebView directly and does not synthesize Windows keyboard/mouse input. */
  await driver.manage().window().setRect({ x: -1800, y: 0, width: 1440, height: 900 }).catch(
    () => undefined
  );

  /* A failed manual path is not thrown by the session. App.tsx therefore
     closes the dialog and clears its input as if opening had succeeded. */
  await openProjectDialog(invalidPath);
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    15_000,
    "manual invalid-path dialog did not settle"
  );
  const invalidBody = await bodyText();
  evidence.manualInvalidPath = {
    attemptedPath: invalidPath,
    dialogStillOpen: (await driver.findElements(By.id("project-path"))).length > 0,
    displayedFailure: invalidBody.includes("There is nothing at that path") || invalidBody.includes("does not exist")
  };
  await capture("01-manual-invalid-path-closes");

  /* A real project can consist solely of nested source. The current top-level
     classifier ignores directories, so the installed app refuses it. */
  await openProjectDialog(nestedSource);
  await waitForText("This folder has no source files in it", 30_000);
  evidence.nestedSource = {
    path: nestedSource,
    nestedFile: path.join(nestedSource, "src", "index.js"),
    nestedFileExists: existsSync(path.join(nestedSource, "src", "index.js")),
    refusedAsNoSource: true,
    offeredGitSetup: (await bodyText()).includes("Set up git for me")
  };
  await capture("02-nested-source-refused");

  /* The safety scan is shallow in two independent ways: its secret denylist
     covers only six exact root names, and generated-directory handling only
     sees root directories. Record both against fake data. */
  await openProjectDialog(secretPattern);
  await waitForText("Set up git for me", 30_000);
  evidence.gitSafety.secretVariant = {
    path: path.join(secretPattern, ".env.production"),
    exists: existsSync(path.join(secretPattern, ".env.production")),
    gitSetupOffered: true
  };
  await capture("03-secret-variant-offered-for-commit");

  await openProjectDialog(nestedDependencies);
  await waitForText("Set up git for me", 30_000);
  await clickButton("Set up git for me");
  await driver.wait(
    async () => existsSync(path.join(nestedDependencies, ".git")),
    30_000,
    "nested-dependency fixture was not initialized"
  );
  const { stdout: nestedTracked } = await run("git", ["ls-files"], {
    cwd: nestedDependencies,
    windowsHide: true
  });
  evidence.gitSafety.nestedGeneratedDirectory = {
    trackedFiles: nestedTracked.trim().split(/\r?\n/u).filter(Boolean),
    dependencyTracked: nestedTracked.includes("packages/app/node_modules/dep.js"),
    buildOutputTracked: nestedTracked.includes("packages/app/dist/bundle.js")
  };
  await capture("04-nested-generated-files-committed");

  /* Setup detects a repository command and runs it as soon as project.init
     returns. This fixture makes the side effect visible without network or a
     provider call. */
  await openProjectDialog(automaticCheck);
  await waitForText("Set up this folder", 30_000);
  await clickButton("Set up this folder");
  const marker = path.join(automaticCheck, "auto-check-ran.txt");
  await driver.wait(
    async () => existsSync(marker),
    30_000,
    "the detected check did not run during setup"
  );
  evidence.automaticCheck = {
    marker,
    markerContents: await readFile(marker, "utf8"),
    userPressedRunCheck: false,
    ranDuringSetup: true
  };
  await waitForText("Which providers do you have?", 30_000);
  await capture("05-detected-check-ran-automatically");

  const providerState = await driver.executeScript(`
    const checkbox = document.querySelector('[aria-label="Include Grok Build when connecting"]');
    const rowText = (control) => control?.closest(".border-b")?.innerText ?? null;
    const continueButton = [...document.querySelectorAll("button")].find((node) =>
      node.textContent?.trim() === "Continue"
    );
    return {
      grok: {
        checked: checkbox?.getAttribute("aria-checked") ?? null,
        disabled: checkbox?.hasAttribute("disabled") ?? null,
        rowText: rowText(checkbox)
      },
      continueDisabled: continueButton?.hasAttribute("disabled") ?? null,
      spendCopy: [...document.querySelectorAll("span")]
        .map((node) => node.innerText)
        .find((text) => text?.includes("tokens on your own subscription")) ?? null
    };
  `);
  evidence.providers = providerState;
  await capture("06-provider-selection-state");

  /* Complete both one-click steps, then inspect what the first commit did not
     include. No provider row is continued and no provider process is run. */
  await openProjectDialog(oneClickGit);
  await waitForText("Set up git for me", 30_000);
  await clickButton("Set up git for me");
  await waitForText("Set up this folder", 30_000);
  await clickButton("Set up this folder");
  await driver.wait(
    async () => existsSync(path.join(oneClickGit, ".hivemind", "config.json")),
    30_000,
    "Hivemind project setup did not write config.json"
  );
  const { stdout: gitStatus } = await run("git", ["status", "--porcelain"], {
    cwd: oneClickGit,
    windowsHide: true
  });
  evidence.gitSetup = {
    path: oneClickGit,
    gitStatus: gitStatus.trim().split(/\r?\n/u).filter(Boolean),
    hivemindFactsTracked: !gitStatus.split(/\r?\n/u).some((line) => line.includes(".hivemind"))
  };
  await capture("07-one-click-leaves-hivemind-untracked");

  /* Installed Core collapses malformed profiles and connection records into
     absence, so the setup surface cannot distinguish corruption from a role
     that was never installed or checked. */
  const adapters = path.join(oneClickGit, ".hivemind", "adapters");
  await mkdir(adapters, { recursive: true });
  await writeFile(path.join(adapters, "planner.profile.json"), "{ broken", "utf8");
  await writeFile(path.join(adapters, "planner.connection.json"), "{ broken", "utf8");
  const core = await import(pathToFileUrl(installedCore));
  const corrupted = await core.inspectProjectConfig(oneClickGit);
  const planner = corrupted.value.adapters.find((entry) => entry.role === "planner");
  evidence.corruptArtifacts = {
    malformedProfileExists: true,
    malformedConnectionExists: true,
    reportedPlanner: planner ?? null
  };

  const logs = await driver.manage().logs().get(logging.Type.BROWSER);
  evidence.browserSevereLogs = logs
    .filter((entry) => entry.level?.name === "SEVERE")
    .map((entry) => ({ level: entry.level?.name, message: entry.message }));
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
  if (recentProjectsBefore !== null) {
    await writeFile(recentProjectsPath, recentProjectsBefore);
    const restored = await readFile(recentProjectsPath);
    evidence.recentProjects.afterSha256 = sha256(restored);
    evidence.recentProjects.restoredExactly = sha256(restored) === sha256(recentProjectsBefore);
  }
  if (fixtureRoot !== undefined) {
    await stopFixtureDaemons(fixtureRoot);
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(evidenceDir, "phase2-lifecycle-audit.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  ).catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), transport.join(""), "utf8").catch(
    () => undefined
  );
}

console.log(JSON.stringify(evidence, null, 2));
console.log(`evidence: ${evidenceDir}`);

async function createFixtures({
  nestedSource,
  secretPattern,
  nestedDependencies,
  automaticCheck,
  oneClickGit
}) {
  await mkdir(path.join(nestedSource, "src"), { recursive: true });
  await writeFile(
    path.join(nestedSource, "src", "index.js"),
    "export function nestedProject() { return true; }\n",
    "utf8"
  );

  await mkdir(secretPattern, { recursive: true });
  await writeFile(path.join(secretPattern, "index.js"), "export default true;\n", "utf8");
  await writeFile(
    path.join(secretPattern, ".env.production"),
    "DEMO_SECRET=not-a-real-secret\n",
    "utf8"
  );

  await mkdir(path.join(nestedDependencies, "packages", "app", "node_modules"), {
    recursive: true
  });
  await mkdir(path.join(nestedDependencies, "packages", "app", "dist"), { recursive: true });
  await writeFile(
    path.join(nestedDependencies, "package.json"),
    '{"name":"nested-dependencies","private":true}\n',
    "utf8"
  );
  await writeFile(
    path.join(nestedDependencies, "packages", "app", "index.js"),
    "export default true;\n",
    "utf8"
  );
  await writeFile(
    path.join(nestedDependencies, "packages", "app", "node_modules", "dep.js"),
    "generated dependency\n",
    "utf8"
  );
  await writeFile(
    path.join(nestedDependencies, "packages", "app", "dist", "bundle.js"),
    "generated build\n",
    "utf8"
  );

  await mkdir(path.join(automaticCheck, "scripts"), { recursive: true });
  await writeFile(
    path.join(automaticCheck, "package.json"),
    `${JSON.stringify({
      name: "hivemind-phase2-auto-check",
      private: true,
      scripts: { test: "node scripts/audit-marker.mjs" }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(automaticCheck, "scripts", "audit-marker.mjs"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync("auto-check-ran.txt", "ran without a Run check click\\n");\n',
    "utf8"
  );
  await gitInitAndCommit(automaticCheck);

  await mkdir(oneClickGit, { recursive: true });
  await writeFile(path.join(oneClickGit, "index.js"), "export default true;\n", "utf8");
  await writeFile(path.join(oneClickGit, "README.md"), "# one-click audit\n", "utf8");
}

async function gitInitAndCommit(root) {
  await run("git", ["init"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.name", "Hivemind Audit"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.email", "audit@invalid.local"], { cwd: root, windowsHide: true });
  await run("git", ["add", "-A"], { cwd: root, windowsHide: true });
  await run("git", ["commit", "-m", "audit fixture"], { cwd: root, windowsHide: true });
}

async function openProjectDialog(wantedPath) {
  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  const openAnother = await driver.wait(
    until.elementLocated(
      By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')
    ),
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
  await clickButton("Open project");
  await driver.wait(
    async () => (await driver.findElements(By.id("project-path"))).length === 0,
    30_000,
    "the project dialog did not close"
  );
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

async function waitForBody() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const body = await driver.executeScript("return document.body?.innerText ?? ''");
    if (typeof body === "string" && body.trim() !== "") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the installed application rendered no readable body within 30 seconds");
}

async function bodyText() {
  return driver.executeScript("return document.body?.innerText ?? ''");
}

async function waitForText(text, timeout) {
  await driver.wait(async () => (await bodyText()).includes(text), timeout, `did not see ${text}`);
}

async function clickButton(label) {
  const button = await driver.wait(
    until.elementLocated(By.xpath(`//button[contains(normalize-space(.), ${JSON.stringify(label)})]`)),
    15_000
  );
  await driver.wait(until.elementIsEnabled(button), 15_000);
  await button.click();
}

async function capture(name) {
  const image = await driver.takeScreenshot();
  await writeFile(path.join(evidenceDir, `${name}.png`), Buffer.from(image, "base64"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathToFileUrl(value) {
  return new URL(`file:///${value.replaceAll("\\", "/")}`).href;
}

async function isProcessRunning(name) {
  const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], {
    windowsHide: true
  });
  return stdout.toLowerCase().includes(name.toLowerCase());
}

async function waitForProcessExit(name, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not exit within ${timeout}ms`);
}

async function stopFixtureDaemons(root) {
  const candidates = [
    path.join(root, "automatic-check", ".hivemind", "daemon.json"),
    path.join(root, "one-click-git", ".hivemind", "daemon.json")
  ];
  for (const recordPath of candidates) {
    if (!existsSync(recordPath)) continue;
    try {
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      if (!Number.isSafeInteger(record.pid) || record.pid <= 0) continue;
      await run("taskkill", ["/PID", String(record.pid), "/T", "/F"], { windowsHide: true }).catch(
        () => undefined
      );
    } catch {
      // The exact fixture directory is deleted below; an absent/stale record needs no action.
    }
  }
}
