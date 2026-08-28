/**
 * Installed Phase 3 proof. The consumer app must open a real project when its
 * inherited PATH contains no Node installation, and the durable daemon owner
 * must be the pinned runtime inside the installed application directory.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Builder, Capabilities, logging } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const desktopRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedRuntime = path.join(installedRoot, "runtime", "node.exe");
const installedRuntimeManifest = path.join(installedRoot, "runtime", "node-runtime.json");
const installedVersion = (
  await readFile(path.join(desktopRoot, "src-tauri", "gen", "app-version.txt"), "utf8")
).trim();
const evidenceDir = path.join(
  repoRoot,
  "docs",
  "evidence",
  `remediation-phase3-${installedVersion}`
);
const recentProjectsPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const sourceCoreCli = path.join(repoRoot, "dist", "src", "cli.js");
const tauriDriverPath = resolveExecutable("tauri-driver");
const nodeFreePath = makeNodeFreePath();
const nodeFreeEnvironment = { ...process.env, PATH: nodeFreePath };

let repo;
let daemonPid;
let recentProjectsBefore = null;
let recentProjectsExisted = false;
const evidence = {
  installedBinary,
  installedVersion,
  viewport: { width: 1440, height: 900 },
  paidProviderCalls: 0,
  ambientNodeAvailable: commandExists("node", nodeFreeEnvironment),
  runtime: {},
  projectReachedLive: false,
  selectedProjectVisible: false,
  daemon: {},
  browserSevereLogs: [],
  recentProjects: {},
  screenshots: [],
  error: null
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  assert.equal(evidence.ambientNodeAvailable, false, "the proof PATH still resolves ambient Node");
  await rm(evidenceDir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidenceDir, { recursive: true });

  if (existsSync(recentProjectsPath)) {
    recentProjectsExisted = true;
    recentProjectsBefore = await readFile(recentProjectsPath);
    evidence.recentProjects.beforeSha256 = sha256(recentProjectsBefore);
  }

  repo = await createFixtureProject();
  await setFixtureAsRecent(repo);
  const session = await runInstalledSession(repo);
  evidence.projectReachedLive = session.live;
  evidence.selectedProjectVisible = session.selectedProjectVisible;
  evidence.browserSevereLogs = session.severeLogs;
  evidence.screenshots.push(session.screenshot);
  daemonPid = session.daemonPid;
  evidence.daemon = { pid: daemonPid, executable: session.daemonExecutable };

  assert.ok(existsSync(installedRuntime), `installed pinned runtime missing: ${installedRuntime}`);
  assert.ok(
    existsSync(installedRuntimeManifest),
    `installed runtime manifest missing: ${installedRuntimeManifest}`
  );
  const manifest = JSON.parse(await readFile(installedRuntimeManifest, "utf8"));
  const runtimeBytes = await readFile(installedRuntime);
  const runtimeSha256 = sha256(runtimeBytes);
  const runtimeVersion = execFileSync(installedRuntime, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    env: nodeFreeEnvironment
  }).trim();
  evidence.runtime = {
    path: installedRuntime,
    version: runtimeVersion,
    sha256: runtimeSha256,
    manifest
  };
  assert.equal(runtimeVersion, `v${manifest.version}`);
  assert.equal(runtimeSha256, manifest.sha256);

  assert.equal(
    normalizeWindowsPath(session.daemonExecutable),
    normalizeWindowsPath(installedRuntime)
  );
  assert.deepEqual(evidence.browserSevereLogs, []);
} catch (error) {
  evidence.error = error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: String(error), stack: null };
  throw error;
} finally {
  if (repo !== undefined && !Number.isSafeInteger(daemonPid)) {
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
console.log(`installed pinned runtime passed for ${installedVersion}`);
console.log(`evidence: ${evidenceDir}`);

async function runInstalledSession(project) {
  let driver;
  let tauriDriver;
  try {
    tauriDriver = spawn(tauriDriverPath, [], {
      env: nodeFreeEnvironment,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const transport = [];
    tauriDriver.stderr.on("data", (chunk) => transport.push(String(chunk)));
    await waitForDriver(tauriDriver, transport);

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
        "installed project did not reach Live without ambient Node"
      );
    } catch (error) {
      const body = String(await driver.executeScript("return document.body?.innerText ?? ''"));
      const diagnostic = path.join(
        evidenceDir,
        `installed-no-ambient-node-failure-${installedVersion}-1440x900.png`
      );
      await writeFile(diagnostic, await driver.takeScreenshot(), "base64");
      evidence.screenshots.push(diagnostic);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; visible body: ${body.slice(0, 1200)}`
      );
    }
    const body = String(await driver.executeScript("return document.body?.innerText ?? ''"));
    assert.ok(body.includes(path.basename(project)), "selected fixture project is not visible");
    const screenshot = path.join(
      evidenceDir,
      `installed-pinned-runtime-${installedVersion}-1440x900.png`
    );
    await writeFile(screenshot, await driver.takeScreenshot(), "base64");
    const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER);
    const daemonState = JSON.parse(
      await readFile(path.join(project, ".hivemind", "daemon.json"), "utf8")
    );
    const liveDaemonPid = Number(daemonState.pid);
    const daemonExecutable = await processExecutable(liveDaemonPid);
    return {
      live: true,
      selectedProjectVisible: true,
      screenshot,
      severeLogs: browserLogs.filter((entry) => entry.level?.name === "SEVERE"),
      daemonPid: liveDaemonPid,
      daemonExecutable
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
  }
}

async function createFixtureProject() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hivemind-phase3-runtime-"));
  await run("git", ["init", "-q"], { cwd: fixture, windowsHide: true });
  await run("git", ["config", "user.name", "Hivemind Phase 3"], {
    cwd: fixture,
    windowsHide: true
  });
  await run("git", ["config", "user.email", "phase3@example.test"], {
    cwd: fixture,
    windowsHide: true
  });
  await writeFile(path.join(fixture, "README.md"), "# Phase 3 pinned runtime fixture\n");
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

async function processExecutable(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid daemon PID: ${pid}`);
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ExecutablePath`
    ],
    { windowsHide: true }
  );
  const executable = stdout.trim();
  assert.notEqual(executable, "", `daemon ${pid} has no executable path`);
  return executable;
}

async function waitForDriver(processHandle, transport) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `tauri-driver exited before accepting sessions (${processHandle.exitCode}): ${transport.join("")}`
      );
    }
    try {
      const response = await fetch(`${driverUrl}/status`);
      if (response.ok) return;
    } catch {
      // Read-only readiness retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`tauri-driver did not become ready within 20 seconds: ${transport.join("")}`);
}

function makeNodeFreePath() {
  const nodeDirectory = path.dirname(process.execPath).toLowerCase();
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => {
      const normalized = path.resolve(entry).toLowerCase();
      return normalized !== nodeDirectory && !/(?:^|[\\/])(?:nodejs|nvm[^\\/]*)$/iu.test(normalized);
    })
    .join(path.delimiter);
}

function resolveExecutable(name) {
  const output = execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
  const executable = output.split(/\r?\n/u).find(Boolean);
  assert.ok(executable, `could not resolve ${name}`);
  return executable;
}

function commandExists(name, environment) {
  return spawnSync("where.exe", [name], {
    env: environment,
    windowsHide: true,
    stdio: "ignore"
  }).status === 0;
}

function normalizeWindowsPath(value) {
  return path.resolve(value).replace(/^\\\\\?\\/u, "").toLowerCase();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
