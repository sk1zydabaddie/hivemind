/** No-cost installed-artifact proof for the Phase 5 crash/recovery matrix. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Builder, By, Capabilities, logging, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedVersion = (await readFile(path.resolve("src-tauri", "gen", "app-version.txt"), "utf8")).trim();
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedCore = path.join(installedRoot, "core", "dist", "src");
const recentProjectsPath = path.join(process.env.APPDATA ?? "", "ai.hivemind.desktop", "recent-projects.json");
const evidenceDir = path.resolve("..", "docs", "evidence", `remediation-phase5-${installedVersion}`);

let driver;
let tauriDriver;
let project;
let recentProjectsBefore = null;
let recentProjectsExisted = false;
const driverLog = [];
const evidence = {
  installedVersion,
  installedBinary,
  viewport: { width: 1440, height: 900 },
  paidProviderCalls: 0,
  roundIdentity: {},
  orphanReservation: {},
  interruptedResume: {},
  installedPresentation: {},
  browserSevereLogs: [],
  recentProjects: {}
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  for (const name of ["events.js", "open-rounds.js", "resource-ledger.js", "task-control.js", "workspace-inspection.js"]) {
    assert.ok(existsSync(path.join(installedCore, name)), `installed Core module missing: ${name}`);
  }
  assert.equal(await isProcessRunning("hivemind_desktop.exe"), false, "close the installed Hivemind app before this proof");
  assert.equal(await isProcessRunning("tauri-driver.exe"), false, "another tauri-driver session is already running");
  await rm(evidenceDir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(evidenceDir, { recursive: true });
  if (existsSync(recentProjectsPath)) {
    recentProjectsExisted = true;
    recentProjectsBefore = await readFile(recentProjectsPath);
    evidence.recentProjects.beforeSha256 = sha256(recentProjectsBefore);
  }

  const eventsModule = await installedModule("events.js");
  const fixture = await import(pathToFileURL(path.resolve("..", "dist", "test", "support", "manager-fixture.js")).href);
  const initModule = await installedModule("init.js");
  const roundsModule = await installedModule("open-rounds.js");
  const ledgerModule = await installedModule("resource-ledger.js");
  const taskControlModule = await installedModule("task-control.js");
  const workspaceModule = await installedModule("workspace-inspection.js");

  project = await createFixtureRepo(initModule);
  const repo = project;
  await fixture.prepareConcurrentManagerFixture(repo, 1, 1, "sequence", 10, 500_000);
    const now = Date.now();
    const roundEvents = [
      event("quality.draft_started", { quality_run_id: "Q-PHASE5", draft_id: "D-001" }, "T-PHASE5"),
      event("quality.draft_started", { quality_run_id: "Q-PHASE5", draft_id: "D-002" }, "T-PHASE5"),
      event("quality.cancel_failed", { quality_run_id: "Q-PHASE5", retryable: true }, "T-PHASE5"),
      event("quality.draft_disposed", { quality_run_id: "Q-PHASE5", draft_id: "D-001" }, "T-PHASE5"),
      event("scheduler.wave_started", { wave_id: "W-PHASE5-A", session_id: "M-PHASE5" }),
      event("scheduler.wave_started", { wave_id: "W-PHASE5-B", session_id: "M-PHASE5" }),
      event("scheduler.wave_completed", { wave_id: "W-PHASE5-A", session_id: "M-PHASE5" })
    ];
    const open = roundsModule.openRounds(roundEvents, { now });
    assert.deepEqual(open.map((round) => round.id).sort(), ["Q-PHASE5/D-002", "W-PHASE5-B"]);
    evidence.roundIdentity = { openIds: open.map((round) => round.id).sort(), distinctOpenRounds: open.length };

    const reserved = await ledgerModule.reserveMeteredCall(repo, {
      provider: "codex",
      session_id: "phase5-orphan-session",
      run_id: "phase5-orphan-run",
      task_id: "T-PHASE5-ORPHAN",
      daemon_instance_id: "daemon-before-crash",
      estimated_input_tokens: 1
    });
    assert.equal(reserved.ok, true, reserved.ok ? undefined : reserved.reason);
    const reconciled = await ledgerModule.reconcileMeteredCallReservations(repo, {
      currentDaemonInstanceId: "daemon-after-restart",
      probeLiveness: () => "unknown"
    });
    assert.deepEqual(reconciled, { ok: true, value: { retained: 0, settled: 1, fully_charged: 1 } });
    const ledger = await ledgerModule.readQuotaLedgerState(repo);
    assert.equal(ledger.ok, true, ledger.ok ? undefined : ledger.reason);
    const orphan = Object.values(ledger.value.reservations).find((entry) => entry.session_id === "phase5-orphan-session");
    assert.equal(orphan?.status, "settled");
    assert.equal(orphan?.settlement?.reason, "orphaned_unbound_full_charge");
    evidence.orphanReservation = {
      status: orphan?.status,
      reason: orphan?.settlement?.reason,
      accountingSource: orphan?.settlement?.accounting_source,
      activeReservationCount: Object.values(ledger.value.reservations).filter((entry) => entry.status === "active").length
    };

    await append(eventsModule, repo, "task.resumed", {
      tool: "fixture",
      snapshot_path: ".hivemind/resource/checkpoints/T-PHASE5-RESUME.snapshot.json"
    }, "T-PHASE5-RESUME");
    const resumed = await taskControlModule.reconcileTaskRunOnStartup(repo, "T-PHASE5-RESUME");
    assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.reason);

    await append(eventsModule, repo, "scheduler.wave_started", {
      wave_id: "W-PHASE5-ABANDONED",
      session_id: "M-PHASE5-ABANDONED",
      process_identity: { pid: 2_000_000_000 }
    });
    await append(eventsModule, repo, "scheduler.run_cancel_failed", {
      session_id: "M-PHASE5-STOP",
      reason: "a worker could not be confirmed stopped",
      retryable: true,
      cleanup_complete: false
    });

    const inspection = await workspaceModule.inspectWorkspace(repo, {
      now: new Date(),
      processLiveness: () => "dead"
    });
    assert.equal(inspection.ok, true, inspection.ok ? undefined : inspection.reason);
    const resumeItem = inspection.value.needs_you.find((item) => item.task_id === "T-PHASE5-RESUME");
    const recoveryItem = inspection.value.needs_you.find((item) => item.kind === "recovery_required");
    const failedStopItem = inspection.value.needs_you.find((item) => item.kind === "run_cancel_failed");
    assert.equal(resumeItem?.action?.type, "task.resume");
    assert.equal(recoveryItem?.id, "recovery:scheduler.wave_started:W-PHASE5-ABANDONED");
    assert.equal(failedStopItem?.action?.type, "run.stop");
    evidence.interruptedResume = {
      queueKind: resumeItem?.kind,
      action: resumeItem?.action?.type,
      detail: resumeItem?.detail
    };

  await runInstalledPresentationProbe(repo);
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
  if (project !== undefined) await stopFixtureDaemon(project);
  if (project !== undefined) await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined);
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
  await writeFile(path.join(evidenceDir, "phase5-crash-recovery-remediation.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8").catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), driverLog.join(""), "utf8").catch(() => undefined);
}

assert.equal(evidence.recentProjects.restoredExactly, true);
assert.deepEqual(evidence.browserSevereLogs, []);
console.log(JSON.stringify(evidence, null, 2));
console.log(`evidence: ${evidenceDir}`);

function event(type, data, taskId = null) {
  return { ts: new Date().toISOString(), type, task_id: taskId, data };
}

async function installedModule(name) {
  return import(pathToFileURL(path.join(installedCore, name)).href);
}

async function createFixtureRepo(initModule) {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-phase5-remediation-"));
  await run("git", ["init", "-b", "master"], { cwd: repo, windowsHide: true });
  await run("git", ["config", "user.email", "phase5@example.invalid"], { cwd: repo, windowsHide: true });
  await run("git", ["config", "user.name", "Phase 5 Fixture"], { cwd: repo, windowsHide: true });
  await writeFile(path.join(repo, "README.md"), "# Phase 5 recovery fixture\n", "utf8");
  await run("git", ["add", "README.md"], { cwd: repo, windowsHide: true });
  await run("git", ["commit", "-m", "fixture"], { cwd: repo, windowsHide: true });
  const initialized = await initModule.initProject(repo);
  assert.equal(initialized, 0);
  return repo;
}

async function append(eventsModule, repo, type, data, taskId = null) {
  const result = await eventsModule.appendEvent(repo, { type, task_id: taskId, data });
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
}

async function runInstalledPresentationProbe(repo) {
  tauriDriver = spawn("tauri-driver", [], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  tauriDriver.stdout.on("data", (chunk) => driverLog.push(`stdout ${chunk}`));
  tauriDriver.stderr.on("data", (chunk) => driverLog.push(`stderr ${chunk}`));
  await waitForDriver();
  const capabilities = new Capabilities();
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application: installedBinary });
  capabilities.setLoggingPrefs({ browser: "ALL" });
  driver = await new Builder().usingServer(driverUrl).withCapabilities(capabilities).build();
  await waitForBody();
  await driver.manage().window().setRect({ x: 40, y: 40, width: 1440, height: 900 });
  await openProjectDialog(repo);
  try {
    await driver.wait(until.elementLocated(By.id("work-composer")), 45_000);
  } catch (error) {
    const body = await driver.executeScript("return document.body?.innerText ?? ''");
    const headings = await driver.findElements(By.css("h1, h2, h3"));
    const headingText = await Promise.all(headings.map((element) => element.getText()));
    const failureShot = `phase5-composer-missing-${installedVersion}-1440x900.png`;
    await writeFile(path.join(evidenceDir, failureShot), Buffer.from(await driver.takeScreenshot(), "base64"));
    evidence.installedPresentation = {
      build: installedVersion,
      composerLocated: false,
      screenshot: failureShot,
      headings: headingText,
      body
    };
    throw new Error(
      `installed composer was absent after the shell selected ${path.basename(repo)}; ` +
        `headings were ${JSON.stringify(headingText)}; screenshot ${failureShot}`,
      { cause: error }
    );
  }
  await driver.wait(until.elementLocated(By.xpath('//*[@aria-label="Needs you"]')), 30_000);
  const more = await driver.findElements(By.xpath('//button[contains(normalize-space(.), "more after this")]'));
  if (more.length > 0) await more[0].click();
  await driver.wait(until.elementLocated(By.xpath('//*[normalize-space(.)="Recorded work stopped reporting"]')), 30_000);
  await driver.wait(until.elementLocated(By.xpath('//*[normalize-space(.)="This run did not stop cleanly"]')), 30_000);
  const recoveryCount = (await driver.findElements(By.xpath('//*[normalize-space(.)="Recorded work stopped reporting"]'))).length;
  const failedStopCount = (await driver.findElements(By.xpath('//*[normalize-space(.)="This run did not stop cleanly"]'))).length;
  assert.equal(recoveryCount, 1);
  assert.equal(failedStopCount, 1);
  const screenshotName = `phase5-recovery-needs-you-${installedVersion}-1440x900.png`;
  await writeFile(path.join(evidenceDir, screenshotName), Buffer.from(await driver.takeScreenshot(), "base64"));
  evidence.installedPresentation = {
    build: installedVersion,
    screenshot: screenshotName,
    exactRecoveryTitleCount: recoveryCount,
    exactFailedStopTitleCount: failedStopCount
  };
  const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER).catch(() => []);
  evidence.browserSevereLogs = browserLogs.filter((entry) => entry.level?.name === "SEVERE").map((entry) => entry.message);
  await driver.quit();
  driver = undefined;
  tauriDriver.kill();
  tauriDriver = undefined;
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
  await stopFixtureDaemon(repo);
}

async function openProjectDialog(wantedPath) {
  await driver.findElement(By.css('button[aria-label^="Switch project"]')).click();
  const openAnother = await driver.wait(until.elementLocated(By.xpath('//*[@role="menuitem" and contains(normalize-space(.), "Open another project")]')), 10_000);
  await openAnother.click();
  await driver.wait(until.elementLocated(By.id("project-path")), 10_000);
  await driver.executeScript(`const input=document.getElementById("project-path");const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;setter.call(input,arguments[0]);input.dispatchEvent(new Event("input",{bubbles:true}));`, wantedPath);
  await driver.findElement(By.xpath('//button[contains(normalize-space(.), "Open project")]')).click();
  await driver.wait(async () => (await driver.findElements(By.id("project-path"))).length === 0, 30_000);
  const wantedName = path.basename(wantedPath);
  try {
    await driver.wait(async () => {
      const switcher = await driver.findElement(By.css('button[aria-label^="Switch project"]'));
      return (await switcher.getAttribute("aria-label")).includes(wantedName);
    }, 30_000, `the shell did not switch to ${wantedName}`);
  } catch (error) {
    const switcher = await driver.findElement(By.css('button[aria-label^="Switch project"]'));
    const actualLabel = await switcher.getAttribute("aria-label");
    const body = await driver.executeScript("return document.body?.innerText ?? ''");
    const failureShot = `phase5-project-switch-failed-${installedVersion}-1440x900.png`;
    await writeFile(path.join(evidenceDir, failureShot), Buffer.from(await driver.takeScreenshot(), "base64"));
    evidence.installedPresentation = {
      build: installedVersion,
      projectSelected: false,
      wantedProject: wantedName,
      actualProjectLabel: actualLabel,
      screenshot: failureShot,
      body
    };
    throw new Error(
      `the dialog closed without selecting ${wantedName}; shell label was ${JSON.stringify(actualLabel)}; ` +
        `screenshot ${failureShot}`,
      { cause: error }
    );
  }
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tauriDriver.exitCode !== null) throw new Error(`tauri-driver exited early (${tauriDriver.exitCode})`);
    try { if ((await fetch(`${driverUrl}/status`)).ok) return; } catch { /* readiness poll */ }
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

async function isProcessRunning(name) {
  const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], { windowsHide: true });
  return stdout.toLowerCase().includes(name.toLowerCase());
}

async function waitForProcessExit(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not exit within ${timeoutMs}ms`);
}

async function stopFixtureDaemon(root) {
  const statePath = path.join(root, ".hivemind", "daemon.json");
  if (!existsSync(statePath)) return;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (Number.isSafeInteger(state.pid) && state.pid > 0) {
      await run("taskkill", ["/PID", String(state.pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    }
  } catch { /* exact temporary fixture is removed by its owner */ }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
