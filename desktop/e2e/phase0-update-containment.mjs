import assert from "node:assert/strict";
import "./protect-recent-projects.mjs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Builder, Capabilities, logging } from "selenium-webdriver";

const driverUrl = "http://127.0.0.1:4444";
const run = promisify(execFile);
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = process.env.HIVEMIND_E2E_BINARY
  ? path.resolve(process.env.HIVEMIND_E2E_BINARY)
  : path.join(installedRoot, "hivemind_desktop.exe");
const installedCore = path.join(installedRoot, "core", "dist", "src");
const registryPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const evidenceDir = process.env.HIVEMIND_E2E_EVIDENCE
  ? path.resolve(process.env.HIVEMIND_E2E_EVIDENCE)
  : path.join(os.tmpdir(), "hivemind-phase10-trust-perimeter");

let tauriDriver;
let driver;
let fixtureRoot;
const transport = [];

try {
  await mkdir(evidenceDir, { recursive: true });
  fixtureRoot = await createFixture();
  const markerPath = path.join(fixtureRoot, "update-command-ran.txt");
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify([{ path: fixtureRoot, opened_at: String(Math.floor(Date.now() / 1000)) }], null, 2)}\n`,
    "utf8"
  );

  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  tauriDriver.stdout.on("data", (chunk) => transport.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => transport.push(`stderr ${chunk}`));
  await waitForDriver();

  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await driver.manage().window().setRect({ width: 1440, height: 900 });
  await waitForSelector('.app-connection-readout[aria-label="live"]', 45_000);
  await waitForSelector('button[aria-label^="Switch project, currently ai.hivemind.desktop-spoof-"]', 45_000);

  const commandAttempts = {};
  for (const command of ["newer_version", "take_newer_version", "build_and_install"]) {
    commandAttempts[command] = await driver.executeScript(
      `return window.__TAURI_INTERNALS__.invoke(arguments[0], { projectPath: arguments[1] })
        .then((value) => ({ resolved: true, value }), (error) => ({ resolved: false, error: String(error) }));`,
      command,
      fixtureRoot
    );
    assert.equal(
      commandAttempts[command].resolved,
      false,
      `${command} unexpectedly retained update authority: ${JSON.stringify(commandAttempts[command])}`
    );
    assert.match(commandAttempts[command].error ?? "", /not found|unknown/iu);
  }

  await new Promise((resolve) => setTimeout(resolve, 750));
  await assert.rejects(access(markerPath), "the spoof repository's build command executed");

  const updateSurface = await driver.executeScript(
    `return [...document.querySelectorAll("button, [role='status'], [role='alert']")]
      .map((element) => (element.textContent ?? "").trim())
      .filter((text) => /update|newer version|build and restart|install and restart/i.test(text));`
  );
  assert.deepEqual(updateSurface, [], "the installed UI still exposes an update surface");

  const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER);
  const severe = browserLogs.filter((entry) => entry.level?.name === "SEVERE");
  assert.deepEqual(severe, [], `the installed WebView logged errors: ${JSON.stringify(severe)}`);

  const buildNumber = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-Item -LiteralPath '${installedBinary.replaceAll("'", "''")}').VersionInfo.FileVersion`
    ],
    { encoding: "utf8" }
  ).trim();
  assert.match(buildNumber, /^\d+\.\d+\.\d+$/u);

  const screenshotPath = path.join(evidenceDir, "installed-1440x900.png");
  await writeFile(screenshotPath, await driver.takeScreenshot(), "base64");
  const result = {
    installedBinary,
    fixtureRoot,
    healthyClient: true,
    markerAbsent: true,
    commandAttempts,
    updateSurface,
    buildNumber,
    severe,
    screenshotPath
  };
  await writeFile(path.join(evidenceDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`installed trust-perimeter proof passed: ${installedBinary}`);
  console.log(`evidence: ${evidenceDir}`);
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  if (fixtureRoot !== undefined) {
    await stopFixtureDaemon(fixtureRoot);
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(
      () => undefined
    );
  }
  await writeFile(path.join(evidenceDir, "driver.log"), transport.join(""), "utf8").catch(
    () => undefined
  );
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai.hivemind.desktop-spoof-"));
  const markerPath = path.join(root, "update-command-ran.txt");
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "ai.hivemind.desktop-spoof",
      scripts: { build: "node write-marker.mjs" }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, "write-marker.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "ran");\n`,
    "utf8"
  );
  await run("git", ["init"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.name", "Hivemind Fixture"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.email", "fixture@invalid.local"], {
    cwd: root,
    windowsHide: true
  });
  await run("git", ["remote", "add", "origin", "https://example.invalid/ai.hivemind.desktop-spoof.git"], {
    cwd: root,
    windowsHide: true
  });
  await run("git", ["add", "-A"], { cwd: root, windowsHide: true });
  await run("git", ["commit", "-m", "spoof fixture"], { cwd: root, windowsHide: true });
  const init = await import(pathToFileURL(path.join(installedCore, "init.js")).href);
  assert.equal(await init.initProject(root), 0, "installed Core could not initialize the fixture");
  return root;
}

async function stopFixtureDaemon(root) {
  const statePath = path.join(root, ".hivemind", "daemon.json");
  if (!existsSync(statePath)) return;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await fetch(`${state.url}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.auth_token}` }
    });
  } catch {
    // The fixture is disposable and cleanup is best effort after the proof.
  }
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tauriDriver.exitCode !== null) {
      throw new Error(`tauri-driver exited before accepting sessions (${tauriDriver.exitCode})`);
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

async function waitForSelector(selector, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await driver.executeScript(
      "return document.querySelector(arguments[0]) !== null;",
      selector
    );
    if (found === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the installed application did not expose ${selector}`);
}
