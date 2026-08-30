import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Builder, By, Capabilities } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedCore = path.join(installedRoot, "core", "dist", "src");
const configRoot = path.join(process.env.APPDATA ?? "", "ai.hivemind.desktop");
const stateFiles = [
  "recent-projects.json",
  "project-daemons.json",
  "update-lease.json",
  "pending-update-relaunch.json",
  "last-verified-update.json"
];
const evidenceDir = process.env.HIVEMIND_E2E_EVIDENCE
  ? path.resolve(process.env.HIVEMIND_E2E_EVIDENCE)
  : path.join(os.tmpdir(), "hivemind-phase11-update-lifecycle");

const originalState = new Map();
let driver;
let tauriDriver;
let firstRepo;
let secondRepo;
let oldApp;

try {
  await mkdir(configRoot, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  for (const name of stateFiles) {
    const file = path.join(configRoot, name);
    originalState.set(name, existsSync(file) ? await readFile(file) : null);
  }
  firstRepo = await createFixture("first");
  secondRepo = await createFixture("second");
  await writeFile(
    path.join(configRoot, "recent-projects.json"),
    `${JSON.stringify([{ path: firstRepo, opened_at: String(Math.floor(Date.now() / 1_000)) }], null, 2)}\n`
  );
  for (const name of stateFiles.slice(1)) await rm(path.join(configRoot, name), { force: true, recursive: true });

  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  await waitForDriver();
  driver = await createDriver();
  await driver.manage().window().setRect({ width: 1440, height: 900 });
  await waitForSelector('.app-connection-readout[aria-label="live"]', 45_000);
  const secondConnection = await invoke("select_project", { projectPath: secondRepo });
  assert.equal(comparableWindowsPath(secondConnection.project_root), comparableWindowsPath(secondRepo));

  const firstState = await daemonState(firstRepo);
  const secondState = await daemonState(secondRepo);
  assert.notEqual(firstState.pid, secondState.pid, "the two projects did not own separate daemons");

  oldApp = await installedProcess();
  const expected = await installedIdentity();
  const now = Date.now();
  const leaseNonce = `phase11-${oldApp.pid}-${now}`;
  await writeFile(path.join(configRoot, "project-daemons.json"), `${JSON.stringify([firstRepo, secondRepo], null, 2)}\n`);
  await writeFile(path.join(configRoot, "update-lease.json"), `${JSON.stringify({
    version: 1,
    nonce: leaseNonce,
    owner_pid: oldApp.pid,
    owner_started_at_ms: oldApp.startedAtMs,
    acquired_at_ms: now
  }, null, 2)}\n`);
  await writeFile(path.join(configRoot, "pending-update-relaunch.json"), `${JSON.stringify({
    version: 1,
    nonce: `relaunch-${now}`,
    lease_nonce: leaseNonce,
    requested_by_pid: oldApp.pid,
    requested_by_started_at_ms: oldApp.startedAtMs,
    expected
  }, null, 2)}\n`);

  await mkdir(path.join(secondRepo, ".hivemind", "resource"), { recursive: true });
  await writeFile(path.join(secondRepo, ".hivemind", "resource", "ledger.json"), `${JSON.stringify({
    reservations: [{ status: "active", session_id: "phase11-busy", pid: secondState.pid }]
  }, null, 2)}\n`);

  const workRefusals = [];
  const readOnlyObservations = [];
  for (const state of [firstState, secondState]) {
    const observation = await postDaemon(state, "/workspace/action", {
      type: "files.list",
      payload: { path: "." }
    });
    readOnlyObservations.push(observation);
    assert.equal(observation.ok, true, "the update lease blocked read-only project inspection");
    const response = await postDaemon(state, "/workspace/action", {
      type: "conversation.submit",
      payload: { prompt: "must not start", tool: "planner", request_id: crypto.randomUUID() }
    });
    workRefusals.push(response);
    assert.equal(response.ok, false);
    assert.equal(response.reason, "Hivemind is being updated; new work is paused until the app restarts");
  }
  const busyRefusal = await invokeResult("restart_after_update", {});
  assert.equal(busyRefusal.resolved, false, "the update restarted while one project owned work");
  assert.match(busyRefusal.error, /active provider call|still running|Update was not started/iu);

  await writeFile(path.join(secondRepo, ".hivemind", "resource", "ledger.json"), '{"reservations":[]}\n');
  await waitForSelector("button", 10_000, "Restart Hivemind");
  let button;
  for (const candidate of await driver.findElements(By.css("button"))) {
    if ((await candidate.getText()).trim() === "Restart Hivemind") {
      button = candidate;
      break;
    }
  }
  assert.ok(button, "the admitted update did not expose its restart control");
  const screenshot = path.join(evidenceDir, `installed-${expected.version}-1440x900.png`);
  await writeFile(screenshot, await driver.takeScreenshot(), "base64");
  await button.click();

  const completionFile = path.join(configRoot, "last-verified-update.json");
  await waitForFile(completionFile, 30_000);
  const completed = JSON.parse(await readFile(completionFile, "utf8"));
  assert.deepEqual(completed.identity, expected);
  const relaunched = await waitForNewInstalledProcess(oldApp.pid, 30_000);
  assert.notEqual(relaunched.pid, oldApp.pid);
  await assert.rejects(access(path.join(configRoot, "pending-update-relaunch.json")));
  await assert.rejects(access(path.join(configRoot, "update-lease.json")));

  const evidence = {
    installedBinary,
    buildNumber: expected.version,
    projectDaemons: [firstState.pid, secondState.pid],
    readOnlyObservations,
    workRefusals,
    busyRefusal,
    oldProcess: oldApp,
    relaunchedProcess: relaunched,
    expectedIdentity: expected,
    completedIdentity: completed.identity,
    screenshot
  };
  await writeFile(path.join(evidenceDir, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`installed update lifecycle proof passed for build ${expected.version}`);
  console.log(`evidence: ${evidenceDir}`);
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  for (const repo of [firstRepo, secondRepo]) {
    if (repo) {
      await stopFixtureDaemon(repo);
      await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined);
    }
  }
  for (const [name, bytes] of originalState) {
    const file = path.join(configRoot, name);
    if (bytes === null) await rm(file, { recursive: true, force: true }).catch(() => undefined);
    else await writeFile(file, bytes).catch(() => undefined);
  }
}

async function createFixture(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `hivemind-phase11-${label}-`));
  await writeFile(path.join(root, "README.md"), `# ${label}\n`);
  await run("git", ["init"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.name", "Hivemind Fixture"], { cwd: root, windowsHide: true });
  await run("git", ["config", "user.email", "fixture@invalid.local"], { cwd: root, windowsHide: true });
  await run("git", ["add", "-A"], { cwd: root, windowsHide: true });
  await run("git", ["commit", "-m", "initial"], { cwd: root, windowsHide: true });
  const init = await import(pathToFileURL(path.join(installedCore, "init.js")).href);
  assert.equal(await init.initProject(root), 0);
  return root;
}

function comparableWindowsPath(value) {
  return path.resolve(value.replace(/^\\\\\?\\/u, "")).toLocaleLowerCase();
}

async function createDriver() {
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  return new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
}

async function invoke(command, args) {
  return driver.executeScript("return window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]);", command, args);
}

async function invokeResult(command, args) {
  return driver.executeScript(
    "return window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => ({resolved:true,value}), error => ({resolved:false,error:String(error)}));",
    command,
    args
  );
}

async function daemonState(repo) {
  const state = JSON.parse(await readFile(path.join(repo, ".hivemind", "daemon.json"), "utf8"));
  assert.match(state.auth_token, /^[A-Za-z0-9_-]{43}$/u);
  return state;
}

async function postDaemon(state, route, payload) {
  const response = await fetch(`${state.url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.auth_token}`, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return response.json();
}

async function installedIdentity() {
  const runtimeManifest = JSON.parse(await readFile(path.join(installedRoot, "runtime", "node-runtime.json"), "utf8"));
  return {
    version: execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${installedBinary.replaceAll("'", "''")}').VersionInfo.FileVersion`], { encoding: "utf8" }).trim(),
    core_build_id: (await readFile(path.join(installedRoot, "core", "core-build-id.txt"), "utf8")).trim(),
    shell_build_id: (await readFile(path.join(installedRoot, "core", "shell-build-id.txt"), "utf8")).trim(),
    runtime_version: runtimeManifest.version,
    runtime_sha256: createHash("sha256").update(await readFile(path.join(installedRoot, "runtime", "node.exe"))).digest("hex")
  };
}

async function installedProcess() {
  const escaped = installedBinary.replaceAll("'", "''");
  const script = `$p=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' } | Sort-Object CreationDate -Descending | Select-Object -First 1; if(-not $p){exit 3}; $started=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds(); [pscustomobject]@{pid=[int]$p.ProcessId;startedAtMs=[long]$started} | ConvertTo-Json -Compress`;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true });
  return JSON.parse(stdout);
}

async function waitForNewInstalledProcess(oldPid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await installedProcess().catch(() => null);
    if (current && current.pid !== oldPid) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the installed app did not relaunch into a new process");
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${driverUrl}/status`)).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("tauri-driver did not become ready");
}

async function waitForSelector(selector, timeout, text) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await driver.executeScript(
      "return [...document.querySelectorAll(arguments[0])].some(element => arguments[1] == null || (element.textContent ?? '').trim() === arguments[1]);",
      selector,
      text ?? null
    );
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`installed app did not expose ${text ?? selector}`);
}

async function waitForFile(file, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function stopFixtureDaemon(root) {
  try {
    const state = await daemonState(root);
    await run("taskkill.exe", ["/pid", String(state.pid), "/t", "/f"], { windowsHide: true });
  } catch { /* fixture cleanup */ }
}
