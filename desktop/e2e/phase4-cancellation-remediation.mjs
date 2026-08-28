/**
 * No-cost installed-artifact proof for manager ownership and cancellation.
 *
 * The provider is a fixture-owned Node process that deliberately waits for
 * thirty seconds. The proof starts it through the Core bundled beside the
 * installed executable, cancels it, and verifies the exact process, event
 * order, terminal projection, and installed UI. No provider account is used.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const evidenceDir = path.resolve("..", "docs", "evidence", `remediation-phase4-${installedVersion}`);

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
  cancellation: {},
  terminalMonotonicity: {},
  completedRun: {},
  installedPresentation: {},
  browserSevereLogs: [],
  recentProjects: {}
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  for (const moduleName of ["events.js", "manager.js", "run.js", "run-state.js"]) {
    assert.ok(existsSync(path.join(installedCore, moduleName)), `installed Core module missing: ${moduleName}`);
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

  const fixture = await import(pathToFileURL(path.resolve("..", "dist", "test", "support", "manager-fixture.js")).href);
  const eventsModule = await installedModule("events.js");
  const managerModule = await installedModule("manager.js");
  const runModule = await installedModule("run.js");
  const runStateModule = await installedModule("run-state.js");

  await fixture.withTempRepo(async ({ repo }) => {
    project = repo;
    try {
    await fixture.prepareConcurrentManagerFixture(repo, 1, 1, "sequence", 10, 500_000);
    const delayedAgent = await fixture.writeAgent(repo, "phase4-delayed-manager.mjs", [
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "await new Promise((resolve) => setTimeout(resolve, 30_000));",
      `console.log(${JSON.stringify(JSON.stringify(fixture.proposalFor([{ type: "get_status" }])))});`
    ]);
    await fixture.writeProfile(repo, "manager", delayedAgent, "strong", 1, 60_000);

    const startPromise = managerModule.startManagerSession(repo, "Begin the approved work.", { tool: "manager" });
    const started = await waitForEvent(eventsModule, repo, "manager.worker_process_started", 15_000);
    const sessionId = started.data.session_id;
    const callId = started.data.call_id;
    const pid = started.data.pid;
    assert.equal(typeof sessionId, "string");
    assert.equal(typeof callId, "string");
    assert.equal(Number.isSafeInteger(pid) && pid > 0, true);

    const during = await managerModule.inspectManagerSessionHistory(repo);
    assert.equal(during.ok, true, during.ok ? undefined : during.reason);
    const duringRun = during.value.find((entry) => entry.session_id === sessionId);
    assert.equal(duringRun?.status, "active");
    assert.equal(duringRun?.continuation_available, false);

    const cancelled = await managerModule.cancelManagerRun(repo, {
      session_id: sessionId,
      reason: "Installed Phase 4 cancellation proof"
    });
    assert.equal(cancelled.ok, true, cancelled.ok ? undefined : cancelled.reason);
    const startResult = await startPromise;
    assert.equal(startResult.ok, false, "a cancelled provider result must not create a manager session");

    const after = await requiredEvents(eventsModule, repo);
    const stoppedIndex = after.findIndex((entry) =>
      entry.type === "manager.worker_process_stopped" && entry.data.session_id === sessionId && entry.data.call_id === callId
    );
    const cancelledIndex = after.findIndex((entry) =>
      entry.type === "scheduler.run_cancelled" && entry.data.session_id === sessionId
    );
    const completedAfterCancel = after.some((entry) => entry.type === "manager.run_completed" && entry.data.session_id === sessionId);
    assert.ok(stoppedIndex >= 0, "the owned provider process never acknowledged its stopped boundary");
    assert.ok(cancelledIndex > stoppedIndex, "terminal cancellation was recorded before provider execution ended");
    assert.equal(await isPidRunning(pid), false, "the exact provider pid remained alive after cancellation returned");
    assert.equal(completedAfterCancel, false, "a late provider callback completed a cancelled run");
    assert.equal(existsSync(path.join(repo, ".hivemind", "orchestrator", "sessions", `${sessionId}.json`)), false);

    const history = await managerModule.inspectManagerSessionHistory(repo);
    assert.equal(history.ok, true, history.ok ? undefined : history.reason);
    const cancelledRun = history.value.find((entry) => entry.session_id === sessionId);
    assert.equal(cancelledRun?.status, "stopped");
    assert.equal(cancelledRun?.continuation_available, false);
    evidence.cancellation = {
      sessionId,
      callId,
      pid,
      processAliveAfterCancellation: false,
      stoppedEventIndex: stoppedIndex,
      cancelledEventIndex: cancelledIndex,
      stoppedBeforeTerminalCancellation: stoppedIndex < cancelledIndex,
      providerResultConsumed: false,
      sessionArtifactCreated: false,
      projectedStatus: cancelledRun?.status,
      continuationAvailable: cancelledRun?.continuation_available
    };

    await runInstalledPresentationProbe(repo);

    const terminalTask = "T-PHASE4-CANCELLED";
    await eventsModule.appendEvent(repo, {
      type: "task.started",
      task_id: terminalTask,
      data: { run_id: "phase4-late-callback", tool: "fixture-worker" }
    });
    await eventsModule.appendEvent(repo, {
      type: "task.cancelled",
      task_id: terminalTask,
      data: { version: 1, reason: "cancelled before late failure", terminal: true }
    });
    const lateFailure = await runModule.markRunFailed(repo, terminalTask, "late background failure", { source: "phase4-proof" });
    assert.equal(lateFailure.ok, true, lateFailure.ok ? undefined : lateFailure.reason);
    const terminalEvents = await requiredEvents(eventsModule, repo);
    const state = runStateModule.latestTaskRunState(terminalEvents, terminalTask);
    assert.equal(lateFailure.value.status, "already_cancelled");
    assert.equal(state.state, "cancelled");
    assert.equal(terminalEvents.some((entry) => entry.type === "task.failed" && entry.task_id === terminalTask), false);
    evidence.terminalMonotonicity = {
      markRunFailedStatus: lateFailure.value.status,
      stateAfterLateFailure: state.state,
      taskFailedEventWritten: false
    };

    const completedAgent = await fixture.writeAgent(repo, "phase4-completed-manager.mjs", [
      "for await (const _chunk of process.stdin) {}",
      `console.log(${JSON.stringify(JSON.stringify(fixture.proposalFor([])))});`
    ]);
    await fixture.writeProfile(repo, "manager", completedAgent, "strong", 1, 15_000);
    const completed = await managerModule.startManagerSession(repo, "Return no work.", { tool: "manager" });
    assert.equal(completed.ok, true, completed.ok ? undefined : completed.reason);
    const falseStop = await managerModule.cancelManagerRun(repo, {
      session_id: completed.value.session_id,
      reason: "must be refused"
    });
    assert.equal(falseStop.ok, false, "completed history was falsely cancelled");
    const completedEvents = await requiredEvents(eventsModule, repo);
    assert.equal(completedEvents.some((entry) =>
      entry.type === "scheduler.run_cancel_requested" && entry.data.session_id === completed.value.session_id
    ), false);
    evidence.completedRun = {
      sessionId: completed.value.session_id,
      stopAccepted: false,
      reason: falseStop.reason,
      cancellationEventWritten: false
    };
    } finally {
      await driver?.quit().catch(() => undefined);
      driver = undefined;
      tauriDriver?.kill();
      tauriDriver = undefined;
      await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
      await stopFixtureDaemon(repo);
      /* WebView2 and the daemon can release their last Windows directory
         handles just after process exit. Remove the disposable fixture here,
         with a bounded retry, so that helper cleanup cannot mask the behavior
         assertion that caused an installed proof to fail. */
      let removed = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await fixture.cleanupTempRepo(repo);
          removed = true;
          break;
        } catch (error) {
          if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      assert.equal(removed, true, `temporary proof repository remained locked: ${repo}`);
    }
  });
} finally {
  await driver?.quit().catch(() => undefined);
  tauriDriver?.kill();
  await waitForProcessExit("hivemind_desktop.exe", 15_000).catch(() => undefined);
  if (project !== undefined) await stopFixtureDaemon(project);
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
  await writeFile(path.join(evidenceDir, "phase4-cancellation-remediation.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8").catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), driverLog.join(""), "utf8").catch(() => undefined);
}

assert.equal(evidence.recentProjects.restoredExactly, true);
assert.deepEqual(evidence.browserSevereLogs, []);
console.log(JSON.stringify(evidence, null, 2));
console.log(`evidence: ${evidenceDir}`);

async function installedModule(name) {
  return import(pathToFileURL(path.join(installedCore, name)).href);
}

async function requiredEvents(eventsModule, repo) {
  const result = await eventsModule.readEvents(repo);
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return result.value;
}

async function waitForEvent(eventsModule, repo, type, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await requiredEvents(eventsModule, repo);
    const found = events.find((entry) => entry.type === type);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${type}`);
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
  await driver.wait(until.elementLocated(By.id("work-composer")), 45_000);
  try {
    await driver.wait(async () =>
      (await driver.findElements(By.xpath('//h2[normalize-space(.)="1 agent in this run"]'))).length === 1,
    30_000, "the exact work status heading did not settle to the fixture's one waiting agent");
  } catch (error) {
    const observedHeadings = await driver.findElements(By.css("h2"));
    const headingText = await Promise.all(observedHeadings.map((element) => element.getText()));
    const image = await driver.takeScreenshot();
    const failureShot = `phase4-unexpected-status-${installedVersion}-1440x900.png`;
    await writeFile(path.join(evidenceDir, failureShot), Buffer.from(image, "base64"));
    throw new Error(`installed status headings were ${JSON.stringify(headingText)}; screenshot ${failureShot}`, { cause: error });
  }
  const stopButtons = await driver.findElements(By.xpath('//button[normalize-space(.)="Stop"]'));
  assert.equal(stopButtons.length, 0, "a terminally cancelled run still exposed the run Stop control");
  const waitingLabels = await driver.findElements(By.xpath('//*[normalize-space(.)="Waiting to start"]'));
  assert.equal(waitingLabels.length, 1, "the unstarted fixture task was not presented as waiting to start");
  const screenshotName = `phase4-cancelled-run-${installedVersion}-1440x900.png`;
  const image = await driver.takeScreenshot();
  await writeFile(path.join(evidenceDir, screenshotName), Buffer.from(image, "base64"));
  evidence.installedPresentation = {
    build: installedVersion,
    screenshot: screenshotName,
    exactStatusHeading: "1 agent in this run",
    exactStatusHeadingCount: 1,
    exactRunStopControlCount: 0,
    exactWaitingToStartCount: 1
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
  await driver.wait(async () => (await driver.findElements(By.id("project-path"))).length === 0, 30_000);
}

async function waitForDriver() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (tauriDriver.exitCode !== null) throw new Error(`tauri-driver exited early (${tauriDriver.exitCode})`);
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

async function isProcessRunning(name) {
  const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], { windowsHide: true });
  return stdout.toLowerCase().includes(name.toLowerCase());
}

async function isPidRunning(pid) {
  const { stdout } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
  return stdout.includes(`"${pid}"`);
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
    if (!Number.isSafeInteger(state.pid) || state.pid <= 0) return;
    await run("taskkill", ["/PID", String(state.pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
  } catch {
    // The exact temporary fixture is removed by the fixture helper.
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
