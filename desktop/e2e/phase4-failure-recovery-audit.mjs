/**
 * No-cost Phase 4 audit probe for failure, recovery, interruption, and
 * persistence. It exercises the installed application plus the exact Core
 * bundled beside it. Provider calls are replaced by fixture-owned Node
 * processes; the user's recent-project registry is restored in `finally`.
 *
 * Usage: npm run build --prefix .. && node e2e/phase4-failure-recovery-audit.mjs
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Builder, By, Capabilities, logging, until } from "selenium-webdriver";

const run = promisify(execFile);
const driverUrl = "http://127.0.0.1:4444";
const installedVersion = "26.826.1622";
const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedBinary = path.join(installedRoot, "hivemind_desktop.exe");
const installedCore = path.join(installedRoot, "core", "dist", "src");
const recentProjectsPath = path.join(
  process.env.APPDATA ?? "",
  "ai.hivemind.desktop",
  "recent-projects.json"
);
const evidenceDir = path.resolve(
  "..",
  "docs",
  "evidence",
  `full-audit-phase4-${installedVersion}`
);

let driver;
let tauriDriver;
let project;
let recentProjectsBefore = null;
let recentProjectsExisted = false;
const transport = [];
const evidence = {
  installedBinary,
  installedVersion,
  viewport: { width: 1440, height: 900 },
  paidProviderCalls: 0,
  initialManagerStart: {},
  cancellationDuringManagerProposal: {},
  cancelledSessionPresentation: {},
  installedCancelledSession: {},
  orphanReservation: {},
  openRoundIdentity: {},
  nullIdSilentRound: {},
  resumedBeforeStart: {},
  terminalRegression: {},
  cancellationFailureSurface: {},
  browserSevereLogs: [],
  recentProjects: {}
};

try {
  assert.ok(existsSync(installedBinary), `installed binary missing: ${installedBinary}`);
  for (const moduleName of [
    "events.js",
    "manager.js",
    "open-rounds.js",
    "resource-ledger.js",
    "run.js",
    "run-state.js",
    "task-control.js",
    "workspace-inspection.js"
  ]) {
    assert.ok(existsSync(path.join(installedCore, moduleName)), `installed Core module missing: ${moduleName}`);
  }
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

  const fixture = await import(
    pathToFileURL(path.resolve("..", "dist", "test", "support", "manager-fixture.js")).href
  );
  const eventsModule = await installedModule("events.js");
  const managerModule = await installedModule("manager.js");
  const roundsModule = await installedModule("open-rounds.js");
  const ledgerModule = await installedModule("resource-ledger.js");
  const runModule = await installedModule("run.js");
  const runStateModule = await installedModule("run-state.js");
  const taskControlModule = await installedModule("task-control.js");
  const inspectionModule = await installedModule("workspace-inspection.js");

  await fixture.withTempRepo(async ({ repo }) => {
    project = repo;
    const prepared = await fixture.prepareConcurrentManagerFixture(
      repo,
      1,
      1,
      "sequence",
      10,
      500_000
    );
    const agentPath = await fixture.writeAgent(repo, "phase4-manager.mjs", [
      "const { appendFile, mkdir, writeFile } = await import('node:fs/promises');",
      "const { join } = await import('node:path');",
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "const root = join(process.cwd(), '.hivemind');",
      "await mkdir(root, { recursive: true });",
      "const callsPath = join(root, 'phase4-manager-calls.jsonl');",
      "let prior = '';",
      "try { prior = await (await import('node:fs/promises')).readFile(callsPath, 'utf8'); } catch {}",
      "const call = prior.split(/\\r?\\n/).filter(Boolean).length + 1;",
      "await appendFile(callsPath, JSON.stringify({ call, pid: process.pid, prompt: input }) + '\\n');",
      "await writeFile(join(root, `phase4-manager-${call}.started`), String(process.pid));",
      "await new Promise((resolve) => setTimeout(resolve, 2500));",
      `console.log(${JSON.stringify(JSON.stringify(fixture.proposalFor([{ type: "get_status" }])))});`
    ]);
    await fixture.writeProfile(repo, "manager", agentPath, "strong", 1, 15_000);

    /* A manager.start proposal has no durable start boundary or discoverable
       session id until the provider process returns. */
    const sessionNamesBefore = await managerSessionNames(repo);
    const eventsBeforeInitial = await requiredEvents(eventsModule, repo);
    const initialStart = managerModule.startManagerSession(repo, "Begin the approved work.", { tool: "manager" });
    await waitForFile(path.join(repo, ".hivemind", "phase4-manager-1.started"), 10_000);
    const sessionNamesDuring = await managerSessionNames(repo);
    const eventsDuringInitial = await requiredEvents(eventsModule, repo);
    const durableEventsDuringInitial = eventsDuringInitial.slice(eventsBeforeInitial.length);
    evidence.initialManagerStart = {
      sessionArtifactsBefore: sessionNamesBefore,
      sessionArtifactsWhileProviderRunning: sessionNamesDuring,
      durableEventsWhileProviderRunning: durableEventsDuringInitial.map((event) => ({
        type: event.type,
        taskId: event.task_id,
        sessionId: event.data?.session_id ?? null,
        runId: event.data?.run_id ?? null
      })),
      durableSessionIdentifiersWhileProviderRunning: durableEventsDuringInitial
        .flatMap((event) => [event.data?.session_id, event.data?.run_id])
        .filter((value) => typeof value === "string" && value.length > 0)
    };
    const initialResult = await initialStart;
    assert.equal(initialResult.ok, true, initialResult.ok ? undefined : initialResult.reason);

    /* Seed a consumed proposal so continue must ask the manager again. Stop
       lands while that provider process is alive. */
    const seeded = await managerModule.startManagerSession(
      repo,
      "Continue from a stored session.",
      { proposedAction: fixture.testProposal([]) }
    );
    assert.equal(seeded.ok, true, seeded.ok ? undefined : seeded.reason);
    if (!seeded.ok) return;
    const continuation = managerModule.continueAutonomousManagerLoop(
      repo,
      seeded.value.session_id,
      { tool: "manager", maxSteps: 1 }
    );
    await waitForFile(path.join(repo, ".hivemind", "phase4-manager-2.started"), 10_000);
    const cancelledAt = Date.now();
    const cancelled = await managerModule.cancelManagerRun(repo, {
      session_id: seeded.value.session_id,
      reason: "Phase 4 cancellation probe"
    });
    const cancellationReturnedAt = Date.now();
    assert.equal(cancelled.ok, true, cancelled.ok ? undefined : cancelled.reason);
    const eventsAtCancellation = await requiredEvents(eventsModule, repo);
    const managerPid = Number(
      await readFile(path.join(repo, ".hivemind", "phase4-manager-2.started"), "utf8")
    );
    const managerAliveAfterCancellation = await isPidRunning(managerPid);
    const continued = await continuation;
    assert.equal(continued.ok, true, continued.ok ? undefined : continued.reason);
    const eventsAfterContinuation = await requiredEvents(eventsModule, repo);
    const history = await managerModule.inspectManagerSessionHistory(repo);
    assert.equal(history.ok, true, history.ok ? undefined : history.reason);
    if (!history.ok) return;
    const cancelledSession = history.value.find((entry) => entry.session_id === seeded.value.session_id);
    const rawSession = JSON.parse(
      await readFile(
        path.join(repo, ".hivemind", "orchestrator", "sessions", `${seeded.value.session_id}.json`),
        "utf8"
      )
    );
    evidence.cancellationDuringManagerProposal = {
      sessionId: seeded.value.session_id,
      cancellationReturnMs: cancellationReturnedAt - cancelledAt,
      managerProcessAliveAfterCancellation: managerAliveAfterCancellation,
      runCancelledRecordedBeforeManagerReturned: eventsAtCancellation.some(
        (event) => event.type === "scheduler.run_cancelled" && event.data.session_id === seeded.value.session_id
      ),
      continuationStatus: continued.value?.status ?? null,
      executedActionsAfterCancellation: rawSession.executed_actions?.map((entry) => ({ type: entry.type, ts: entry.ts })) ?? [],
      durableEventTypesAfterCancellation: eventsAfterContinuation
        .slice(eventsAtCancellation.length)
        .map((event) => event.type)
    };
    evidence.cancelledSessionPresentation = {
      status: cancelledSession?.status ?? null,
      continuationAvailable: cancelledSession?.continuation_available ?? null,
      proposedActions: rawSession.proposed_action?.actions?.map((entry) => entry.type) ?? [],
      proposalState: rawSession.proposal_state ?? null
    };

    const orphan = await ledgerModule.reserveMeteredCall(repo, {
      provider: "audit-orphan",
      session_id: "phase4-orphan-session",
      run_id: "phase4-orphan-run",
      task_id: null,
      daemon_instance_id: "phase4-crashed-daemon",
      estimated_input_tokens: 1
    });
    assert.equal(orphan.ok, true, orphan.ok ? undefined : orphan.reason);
    assert.ok(orphan.value?.reservation, "metered audit reservation was not created");
    const reconciled = await ledgerModule.reconcileMeteredCallReservations(repo, {
      probeLiveness: () => "dead"
    });
    assert.equal(reconciled.ok, true, reconciled.ok ? undefined : reconciled.reason);
    const ledger = await ledgerModule.readQuotaLedgerState(repo);
    assert.equal(ledger.ok, true, ledger.ok ? undefined : ledger.reason);
    const orphanAfter = ledger.value.reservations[orphan.value.reservation.reservation_id];
    evidence.orphanReservation = {
      reservationId: orphan.value.reservation.reservation_id,
      processIdentityBeforeCrash: orphan.value.reservation.process_identity,
      reconcileResult: reconciled.value,
      statusAfterRestartReconciliation: orphanAfter?.status ?? null,
      reservedTokensStillHeld: orphanAfter?.reserved_tokens ?? null
    };

    const oldTs = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const roundEvents = [
      event(oldTs, "quality.draft_started", prepared.taskIds[0], { quality_run_id: "Q-one", draft_id: "D-001" }),
      event(oldTs, "quality.draft_started", prepared.taskIds[0], { quality_run_id: "Q-one", draft_id: "D-002" }),
      event(oldTs, "scheduler.wave_started", null, { session_id: "session-one" }),
      event(oldTs, "scheduler.wave_started", null, { session_id: "session-two" })
    ];
    const collapsed = roundsModule.openRounds(roundEvents, { now: Date.now(), boundMs: 1 });
    const failedCancellationRounds = roundsModule.openRounds([
      event(oldTs, "quality.draft_started", prepared.taskIds[0], { quality_run_id: "Q-two", draft_id: "D-001" }),
      event(new Date().toISOString(), "quality.cancel_failed", prepared.taskIds[0], {
        quality_run_id: "Q-two",
        retryable: true,
        cleanup_complete: false
      })
    ], { now: Date.now(), boundMs: 1 });
    evidence.openRoundIdentity = {
      startsSupplied: roundEvents.length,
      openRoundsReturned: collapsed.map((entry) => ({ type: entry.type, id: entry.id })),
      qualityStartsSupplied: 2,
      qualityRoundsReturned: collapsed.filter((entry) => entry.type === "quality.draft_started").length,
      waveStartsSupplied: 2,
      waveRoundsReturned: collapsed.filter((entry) => entry.type === "scheduler.wave_started").length,
      retryableCancellationFailureLeavesOpenRound: failedCancellationRounds.length > 0
    };

    await appendRawEvent(repo, event(oldTs, "scheduler.wave_started", null, {
      session_id: "phase4-abandoned-wave"
    }));
    const directRounds = roundsModule.openRounds(await requiredEvents(eventsModule, repo), {
      now: Date.now(),
      boundMs: 1
    });
    const inspection = await inspectionModule.inspectWorkspace(repo, {
      now: new Date(),
      stallIntervalMs: 1,
      processLiveness: () => "dead"
    });
    assert.equal(inspection.ok, true, inspection.ok ? undefined : inspection.reason);
    evidence.nullIdSilentRound = {
      abandonedWaveInCoreReconciliation: directRounds.some(
        (entry) => entry.type === "scheduler.wave_started" && entry.id === null && entry.liveness.standing !== "running"
      ),
      silentRoundIdsPublishedToClient: inspection.value.silent_rounds
    };

    const syntheticFailure = await eventsModule.appendEvent(repo, {
      type: "scheduler.run_cancel_failed",
      task_id: null,
      data: {
        version: 1,
        session_id: "phase4-partial-stop",
        reason: "one fixture worker is still alive",
        stopped_task_ids: [],
        failures: ["T-AUDIT-STOP: worker is still alive"],
        terminal: true,
        retryable: true
      }
    });
    assert.equal(syntheticFailure.ok, true, syntheticFailure.ok ? undefined : syntheticFailure.reason);
    const afterFailure = await inspectionModule.inspectWorkspace(repo, {
      now: new Date(),
      stallIntervalMs: 45_000,
      processLiveness: () => "dead"
    });
    assert.equal(afterFailure.ok, true, afterFailure.ok ? undefined : afterFailure.reason);
    evidence.cancellationFailureSurface = {
      durableFailurePresent: (await requiredEvents(eventsModule, repo)).some(
        (entry) => entry.type === "scheduler.run_cancel_failed" && entry.data.session_id === "phase4-partial-stop"
      ),
      matchingNeedsYouItems: afterFailure.value.needs_you
        .filter((item) => JSON.stringify(item).includes("phase4-partial-stop") || item.detail.includes("fixture worker"))
        .map((item) => ({ kind: item.kind, title: item.title, detail: item.detail }))
    };

    await runInstalledPresentationProbe(repo);

    const resumedTaskId = prepared.taskIds[0];
    await eventsModule.appendEvent(repo, {
      type: "task.paused",
      task_id: resumedTaskId,
      data: { version: 1, reason: "quota_exhausted", snapshot_path: ".hivemind/resource/checkpoints/missing.snapshot.json" }
    });
    await eventsModule.appendEvent(repo, {
      type: "task.resumed",
      task_id: resumedTaskId,
      data: { version: 1, source: "phase4-interruption-probe", tool: "concurrent-worker" }
    });
    const startup = await taskControlModule.reconcileTaskRunsOnStartup(repo, {
      probeLiveness: () => "dead"
    });
    assert.equal(startup.ok, true, startup.ok ? undefined : startup.reason);
    const resumedInspection = await inspectionModule.inspectWorkspace(repo, {
      now: new Date(),
      processLiveness: () => "dead"
    });
    assert.equal(resumedInspection.ok, true, resumedInspection.ok ? undefined : resumedInspection.reason);
    evidence.resumedBeforeStart = {
      taskId: resumedTaskId,
      startupExaminedTaskIds: startup.value.examined,
      taskStateAfterReconciliation: resumedInspection.value.tasks.find((entry) => entry.task_id === resumedTaskId)?.state ?? null,
      taskStillReportedRunning: resumedInspection.value.tasks.find((entry) => entry.task_id === resumedTaskId)?.state === "running"
    };

    const terminalTask = "T-AUDIT-CANCELLED";
    await eventsModule.appendEvent(repo, {
      type: "task.started",
      task_id: terminalTask,
      data: { run_id: "phase4-terminal-run", tool: "audit-worker" }
    });
    await eventsModule.appendEvent(repo, {
      type: "task.cancelled",
      task_id: terminalTask,
      data: { version: 1, reason: "cancelled before late failure", terminal: true }
    });
    const stateBeforeLateFailure = runStateModule.latestTaskRunState(
      await requiredEvents(eventsModule, repo),
      terminalTask
    );
    const lateFailure = await runModule.markRunFailed(
      repo,
      terminalTask,
      "late background failure after cancellation",
      { source: "phase4-audit" }
    );
    assert.equal(lateFailure.ok, true, lateFailure.ok ? undefined : lateFailure.reason);
    const stateAfterLateFailure = runStateModule.latestTaskRunState(
      await requiredEvents(eventsModule, repo),
      terminalTask
    );
    evidence.terminalRegression = {
      beforeLateFailure: stateBeforeLateFailure.state,
      markRunFailedResult: lateFailure.value,
      afterLateFailure: stateAfterLateFailure.state
    };
  });

  validateObservedFindings();
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
  } else if (!recentProjectsExisted) {
    await rm(recentProjectsPath, { force: true }).catch(() => undefined);
    evidence.recentProjects.restoredExactly = !existsSync(recentProjectsPath);
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(evidenceDir, "phase4-failure-recovery-audit.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8"
  ).catch(() => undefined);
  await writeFile(path.join(evidenceDir, "driver.log"), transport.join(""), "utf8").catch(() => undefined);
}

console.log(JSON.stringify(evidence, null, 2));
console.log(`evidence: ${evidenceDir}`);

async function installedModule(name) {
  return import(pathToFileURL(path.join(installedCore, name)).href);
}

function event(ts, type, taskId, data) {
  return { ts, type, task_id: taskId, data };
}

async function requiredEvents(eventsModule, repo) {
  const result = await eventsModule.readEvents(repo);
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return result.value;
}

async function appendRawEvent(repo, value) {
  await appendFile(
    path.join(repo, ".hivemind", "log", "events.jsonl"),
    `${JSON.stringify(value)}\n`,
    "utf8"
  );
}

async function managerSessionNames(repo) {
  try {
    return await (await import("node:fs/promises")).readdir(
      path.join(repo, ".hivemind", "orchestrator", "sessions")
    );
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for fixture marker ${filePath}`);
}

async function runInstalledPresentationProbe(repo) {
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
  await driver.manage().window().setRect({ x: -1800, y: 0, width: 1440, height: 900 }).catch(() => undefined);
  await openProjectDialog(repo);
  await driver.wait(until.elementLocated(By.id("work-composer")), 45_000);
  await driver.wait(
    async () => (await bodyText()).includes("Waiting on the next agent"),
    30_000,
    "the cancelled manager session was not presented as active"
  );
  const stopButtons = await driver.findElements(By.xpath('//button[normalize-space(.)="Stop"]'));
  evidence.installedCancelledSession = {
    headline: "Waiting on the next agent",
    stopControlVisible: stopButtons.length > 0,
    bodyContainsCancellation: (await bodyText()).toLocaleLowerCase("en-US").includes("cancel")
  };
  await capture("01-cancelled-session-still-active");
  const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER).catch(() => []);
  evidence.browserSevereLogs = browserLogs
    .filter((entry) => entry.level?.name === "SEVERE")
    .map((entry) => entry.message);

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
  const openButton = await driver.wait(
    until.elementLocated(By.xpath('//button[contains(normalize-space(.), "Open project")]')),
    10_000
  );
  await openButton.click();
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

async function capture(name) {
  const image = await driver.takeScreenshot();
  await writeFile(path.join(evidenceDir, `${name}.png`), Buffer.from(image, "base64"));
}

async function isProcessRunning(name) {
  const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"], {
    windowsHide: true
  });
  return stdout.toLowerCase().includes(name.toLowerCase());
}

async function isPidRunning(pid) {
  const { stdout } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    windowsHide: true
  });
  return stdout.includes(`"${pid}"`);
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
    // The exact temporary fixture is removed by the manager fixture helper.
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateObservedFindings() {
  assert.deepEqual(
    evidence.initialManagerStart.sessionArtifactsWhileProviderRunning,
    evidence.initialManagerStart.sessionArtifactsBefore,
    "manager.start unexpectedly published a cancellable session before its provider returned"
  );
  assert.equal(evidence.initialManagerStart.durableSessionIdentifiersWhileProviderRunning.length, 0);
  assert.equal(evidence.cancellationDuringManagerProposal.runCancelledRecordedBeforeManagerReturned, true);
  assert.equal(evidence.cancellationDuringManagerProposal.managerProcessAliveAfterCancellation, true);
  assert.ok(evidence.cancellationDuringManagerProposal.executedActionsAfterCancellation.length > 0);
  assert.equal(evidence.cancelledSessionPresentation.status, "active");
  assert.equal(evidence.cancelledSessionPresentation.continuationAvailable, true);
  assert.equal(evidence.installedCancelledSession.stopControlVisible, true);
  assert.equal(evidence.installedCancelledSession.bodyContainsCancellation, false);
  assert.equal(evidence.orphanReservation.reconcileResult.retained >= 1, true);
  assert.equal(evidence.orphanReservation.statusAfterRestartReconciliation, "active");
  assert.equal(evidence.openRoundIdentity.qualityRoundsReturned, 1);
  assert.equal(evidence.openRoundIdentity.waveRoundsReturned, 1);
  assert.equal(evidence.openRoundIdentity.retryableCancellationFailureLeavesOpenRound, false);
  assert.equal(evidence.nullIdSilentRound.abandonedWaveInCoreReconciliation, true);
  assert.equal(evidence.nullIdSilentRound.silentRoundIdsPublishedToClient.includes(null), false);
  assert.equal(evidence.cancellationFailureSurface.durableFailurePresent, true);
  assert.equal(evidence.cancellationFailureSurface.matchingNeedsYouItems.length, 0);
  assert.equal(evidence.resumedBeforeStart.startupExaminedTaskIds.includes(evidence.resumedBeforeStart.taskId), false);
  assert.equal(evidence.resumedBeforeStart.taskStillReportedRunning, true);
  assert.equal(evidence.terminalRegression.beforeLateFailure, "cancelled");
  assert.equal(evidence.terminalRegression.afterLateFailure, "failed");
  assert.deepEqual(evidence.browserSevereLogs, []);
}
