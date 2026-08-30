import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents, type HivemindEvent } from "../src/events.js";
import { currentBuildIdentity } from "../src/build-identity.js";
import { loadConfig } from "../src/config.js";
import { createDaemonServer } from "../src/daemon.js";
import { initProject } from "../src/init.js";
import { integratedTaskIdsFromEvents } from "../src/integration-state.js";
import { requestLease } from "../src/lease.js";
import { readQuotaLedger, readQuotaLedgerState, recordQuotaUsage, reserveMeteredCall } from "../src/resource-ledger.js";
import { latestTaskRunState } from "../src/run-state.js";
import {
  approvePendingManagerAction,
  continueAutonomousManagerLoop,
  executeManagerAction,
  runAutonomousManagerLoop,
  startManagerSession,
  startWorkspaceManagerSession,
  type ManagerAction,
  type ManagerAutonomousLoopResult,
  type ManagerProposedAction
} from "../src/manager.js";
import { createSpec, type SpecResult } from "../src/spec.js";
import { getStatus } from "../src/status.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";
import { admitExecutionWave } from "../src/wave-admission.js";
import { createRatifiedSpec } from "./support/spec.js";
import { withTemplateRepo } from "./support/fixture-repo.js";


import {
  execFileAsync,
  cliPath,
  withTempRepo,
  runConcurrentManagerFixture,
  prepareConcurrentManagerFixture,
  waitForWorkersInFlight,
  observeWorkersInFlight,
  releaseWorkers,
  maxConcurrentIntervals,
  managerContract,
  intentFor,
  assertMissing,
  readRequiredEvents,
  setConfigExecution,
  gitStdout,
  waitForDurableEvent
} from "./support/manager-fixture.js";

test("concurrent deterministic scheduling overlaps workers and preserves serial per-task trails", async (context) => {
  // The M10.4 claim is causal, not temporal: at cap 2 both lanes are in flight
  // at the same instant, and at cap 1 the second lane cannot begin until the
  // first is released. Both are observed here rather than inferred from
  // timestamps, which a loaded machine can reorder.
  let concurrentInFlight: string[] = [];
  const concurrent = await runConcurrentManagerFixture({
    taskCount: 2,
    concurrency: 2,
    mode: "parallel",
    workerDelayMs: 2_500,
    barrier: true,
    drive: async ({ barrierDir }) => {
      concurrentInFlight = await waitForWorkersInFlight(barrierDir, 2);
    }
  });
  assert.deepEqual(concurrentInFlight, ["T-WAVE-001", "T-WAVE-002"], "cap two did not hold two lanes in flight at once");

  let serialFirst: string[] = [];
  let serialWhileFirstHeld: string[] = [];
  let serialAfterRelease: string[] = [];
  const serial = await runConcurrentManagerFixture({
    taskCount: 2,
    concurrency: 1,
    mode: "parallel",
    workerDelayMs: 2_500,
    barrier: true,
    drive: async ({ barrierDir }) => {
      serialFirst = await waitForWorkersInFlight(barrierDir, 1);
      // The second lane must still be absent while the first is held.
      serialWhileFirstHeld = await observeWorkersInFlight(barrierDir);
      await releaseWorkers(barrierDir, serialFirst);
      // It may only appear as a consequence of that release.
      serialAfterRelease = await waitForWorkersInFlight(barrierDir, 2);
    }
  });
  assert.equal(serialWhileFirstHeld.length, 1, `cap one admitted a second lane while the first was held: ${serialWhileFirstHeld.join(", ")}`);
  assert.deepEqual(serialAfterRelease, ["T-WAVE-001", "T-WAVE-002"]);

  assert.deepEqual(concurrent.perTaskTrail, serial.perTaskTrail);
  assert.equal(concurrent.events.some((event) => event.type === "scheduler.wave_started"), true);
  assert.equal(concurrent.events.some((event) => event.type === "scheduler.wave_completed"), true);
  // Elapsed-time speedup is a property of real worker durations, which this
  // barriered fixture deliberately controls. It is reported as a measurement,
  // not asserted; the concurrency guarantee itself is proven causally above.
  context.diagnostic(
    `M10.4 barriered worker windows (measurement only): serial=${serial.workerWindowMs}ms, concurrent=${concurrent.workerWindowMs}ms`
  );
});

test("concurrent scheduler enforces cap two and refills a slot only after one of four workers finishes", async () => {
  // "Refills only after a worker finishes" is a causal claim. Holding the cap
  // full and proving the third lane is absent, then proving it appears as a
  // consequence of releasing one, is that claim. Comparing start timestamps was
  // only a proxy for it, and a loaded machine could reorder them.
  let whileCapFull: string[] = [];
  let afterOneReleased: string[] = [];
  const result = await runConcurrentManagerFixture({
    taskCount: 4,
    concurrency: 2,
    mode: "parallel",
    workerDelayMs: 2_000,
    sessionCeiling: 650_000,
    barrier: true,
    drive: async ({ barrierDir }) => {
      const firstRound = await waitForWorkersInFlight(barrierDir, 2);
      whileCapFull = await observeWorkersInFlight(barrierDir);
      await releaseWorkers(barrierDir, [firstRound[0]]);
      afterOneReleased = await waitForWorkersInFlight(barrierDir, 3);
    }
  });

  assert.equal(whileCapFull.length, 2, `cap two admitted a third lane before a slot opened: ${whileCapFull.join(", ")}`);
  assert.equal(afterOneReleased.length >= 3, true, "the third lane did not start after a slot opened");
  const wave = result.events.find((event) => event.type === "scheduler.wave_started");
  assert.equal(wave?.data.configured_cap, 2);
  assert.equal(wave?.data.effective_concurrency, 2);
  assert.equal(wave?.data.binding_limit, "configured_cap");
});

test("concurrent worker configuration fails closed above the hard maximum of four", async () => {
  await withTempRepo(async ({ repo }) => {
    await setConfigExecution(repo, 5);
    const config = await loadConfig(repo);
    assert.equal(config.ok, false);
    if (!config.ok) assert.match(config.reason, /max_concurrent_workers must be an integer between 1 and 4/u);
  });
});

test("concurrent scheduler distinguishes budget-limited execution from its configured cap", async () => {
  let whileFirstHeld: string[] = [];
  const result = await runConcurrentManagerFixture({
    taskCount: 2,
    concurrency: 2,
    mode: "parallel",
    workerDelayMs: 1_000,
    sessionCeiling: 300_000,
    seedSettledUsage: true,
    barrier: true,
    drive: async ({ barrierDir }) => {
      // Budget, not the configured cap, is what holds the second lane back, so
      // its absence is observed while the first lane is still in flight.
      const first = await waitForWorkersInFlight(barrierDir, 1);
      whileFirstHeld = await observeWorkersInFlight(barrierDir);
      await releaseWorkers(barrierDir, first);
    }
  });

  assert.equal(whileFirstHeld.length, 1, `budget-limited admission ran more than one lane: ${whileFirstHeld.join(", ")}`);
  const wave = result.events.find((event) => event.type === "scheduler.wave_started");
  assert.equal(wave?.data.configured_cap, 2);
  assert.equal(wave?.data.effective_concurrency, 1);
  assert.equal(wave?.data.binding_limit, "budget");
  assert.equal(wave?.data.budget_available_reservations, 1);
});

test("each concurrent setup action keeps its independent gate and setup order", async () => {
  await withTempRepo(async ({ repo }) => {
    const fixture = await prepareConcurrentManagerFixture(repo, 2, 2, "parallel", 1_500, 500_000);
    const held = await requestLease(repo, "T-EXTERNAL-HOLDER", ["T-WAVE-002.txt"]);
    assert.equal(held.ok, true, held.ok ? undefined : held.reason);

    const started = await startWorkspaceManagerSession(repo, "Run the admitted wave until a real lease refusal.", "manager");
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const result = await continueAutonomousManagerLoop(repo, started.value.session_id, { tool: "manager", maxSteps: 100 });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.equal(result.value.status, "stopped");

    const events = await readRequiredEvents(repo);
    const firstStarted = events.findIndex((event) => event.type === "task.started" && event.task_id === fixture.taskIds[0]);
    const secondCreated = events.findIndex((event) => event.type === "task.created" && event.task_id === fixture.taskIds[1]);
    assert.ok(firstStarted >= 0 && secondCreated > firstStarted, "the second task setup began before the first worker start returned");
    assert.equal(events.some((event) => event.type === "lease.rejected" && event.task_id === fixture.taskIds[1]), true);
    assert.equal(events.some((event) => event.type === "task.worker_process_started" && event.task_id === fixture.taskIds[1]), false);
    assert.equal(result.value.final_status.leases["T-WAVE-002.txt"], "T-EXTERNAL-HOLDER");
  });
});

test("a concurrent worker failure settles only its lane while independent siblings continue and keep their resources", async () => {
  await withTempRepo(async ({ repo }) => {
    const fixture = await prepareConcurrentManagerFixture(repo, 3, 2, "parallel", 2_500, 500_000, "T-WAVE-001", undefined, true);
    const started = await startWorkspaceManagerSession(repo, "Run the admitted wave until one worker fails.", "manager");
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;

    const continuation = continueAutonomousManagerLoop(repo, started.value.session_id, { tool: "manager", maxSteps: 100 });
    // Both lanes are proven in flight, then only the failing lane is released.
    // The sibling is still blocked while its resources are inspected, so an
    // intact lease/worktree/reservation is observed rather than raced for.
    assert.deepEqual(
      await waitForWorkersInFlight(fixture.barrierDir, 2),
      [fixture.taskIds[0], fixture.taskIds[1]]
    );
    await releaseWorkers(fixture.barrierDir, [fixture.taskIds[0]]);
    await waitForDurableEvent(repo, "task.failed", fixture.taskIds[0]);
    const duringFailure = await getStatus(repo);
    assert.equal(duringFailure.ok, true, duringFailure.ok ? undefined : duringFailure.reason);
    if (!duringFailure.ok) return;
    assert.equal(duringFailure.value.leases[`${fixture.taskIds[1]}.txt`], fixture.taskIds[1]);
    assert.notEqual(duringFailure.value.tasks.find((task) => task.task_id === fixture.taskIds[1])?.worktree, "missing");
    const ledger = await readQuotaLedgerState(repo);
    assert.equal(ledger.ok, true, ledger.ok ? undefined : ledger.reason);
    if (ledger.ok) {
      assert.equal(Object.values(ledger.value.reservations).some((reservation) =>
        reservation.task_id === fixture.taskIds[1] && reservation.status === "active"
      ), true);
    }

    await releaseWorkers(fixture.barrierDir);
    const result = await continuation;
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.equal(result.value.status, "stopped");

    const events = await readRequiredEvents(repo);
    assert.equal(events.some((event) => event.type === "task.failed" && event.task_id === fixture.taskIds[0]), true);
    assert.equal(events.some((event) => event.type === "scheduler.wave_settled"), true);
    assert.equal(events.some((event) => event.type === "task.worker_process_started" && event.task_id === fixture.taskIds[2]), true);
    assert.equal(result.value.final_status.leases[`${fixture.taskIds[0]}.txt`], undefined);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", fixture.taskIds[0]));
    assert.equal(events.some((event) => event.type === "task.completed" && event.task_id === fixture.taskIds[1]), true);
    assert.equal(events.some((event) => event.type === "task.completed" && event.task_id === fixture.taskIds[2]), true);
    const survivorVerification = events.find((event) =>
      event.type === "integration.passed" &&
      Array.isArray(event.data.applied) &&
      event.data.applied.includes(fixture.taskIds[1]) &&
      event.data.applied.includes(fixture.taskIds[2])
    );
    assert.ok(survivorVerification, "the exact successful survivor set was not shadow-verified together");
    assert.equal(Array.isArray(survivorVerification?.data.applied) && survivorVerification.data.applied.includes(fixture.taskIds[0]), false);
  });
});

test("cancelling one concurrent task reuses task.stop and leaves its sibling running", async () => {
  await withTempRepo(async ({ repo }) => {
    const fixture = await prepareConcurrentManagerFixture(repo, 2, 2, "parallel", 3_000, 500_000, undefined, undefined, true);
    const started = await startWorkspaceManagerSession(repo, "Run two lanes and stop only one.", "manager");
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const continuation = continueAutonomousManagerLoop(repo, started.value.session_id, { tool: "manager", maxSteps: 100 });
    // Both lanes held at the barrier, so the sibling cannot have finished
    // before the stop lands and its resources are checked.
    assert.deepEqual(await waitForWorkersInFlight(fixture.barrierDir, 2), fixture.taskIds);
    const stopped = await executeWorkspaceAction(repo, {
      type: "task.stop",
      payload: { task_id: fixture.taskIds[0], reason: "Cancel only this concurrent lane." }
    });
    assert.equal(stopped.ok, true, stopped.ok ? undefined : stopped.reason);
    const afterStop = await getStatus(repo);
    assert.equal(afterStop.ok, true, afterStop.ok ? undefined : afterStop.reason);
    if (!afterStop.ok) return;
    assert.equal(afterStop.value.leases[`${fixture.taskIds[1]}.txt`], fixture.taskIds[1]);
    assert.notEqual(afterStop.value.tasks.find((task) => task.task_id === fixture.taskIds[1])?.worktree, "missing");
    await releaseWorkers(fixture.barrierDir);
    await continuation;
    const events = await readRequiredEvents(repo);
    assert.equal(events.filter((event) => event.type === "task.cancel_requested" && event.task_id === fixture.taskIds[0]).length, 1);
    assert.equal(events.some((event) => event.type === "task.cancelled" && event.task_id === fixture.taskIds[0]), true);
    assert.equal(events.some((event) => event.type === "task.completed" && event.task_id === fixture.taskIds[1]), true);
  });
});

test("run cancellation prevents new launches before fanning out through task.stop exactly once", async () => {
  await withTempRepo(async ({ repo }) => {
    const fixture = await prepareConcurrentManagerFixture(repo, 3, 2, "parallel", 1_000, 500_000);
    const started = await startWorkspaceManagerSession(repo, "Cancel this concurrent run as a group.", "manager");
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    for (const [index, taskId] of fixture.taskIds.slice(0, 2).entries()) {
      for (const action of [
        { type: "create_task_contract", contract: managerContract(taskId, baseCommit, [`${taskId}.txt`]) },
        { type: "request_lease", task_id: taskId },
        { type: "check_write_intent", task_id: taskId, intent: intentFor(taskId, [`${taskId}.txt`]) },
        { type: "create_worktree", task_id: taskId }
      ] as ManagerAction[]) {
        const executed = await executeManagerAction(repo, started.value.session_id, action);
        assert.equal(executed.ok, true, executed.ok ? undefined : executed.reason);
      }
      const runId = `R-cancel-${index}`;
      await appendEvent(repo, { type: "task.started", task_id: taskId, data: { run_id: runId, tool: "concurrent-worker" } });
      await appendEvent(repo, {
        type: "task.worker_process_started",
        task_id: taskId,
        data: { version: 1, run_id: runId, tool: "concurrent-worker", pid: 2_000_000_000 + index, process_group_id: process.platform === "win32" ? null : 2_000_000_000 + index, process_instance_id: `dead-${index}` }
      });
      await appendEvent(repo, {
        type: "task.worker_process_stopped",
        task_id: taskId,
        data: { version: 1, run_id: runId, tool: "concurrent-worker", pid: 2_000_000_000 + index, process_instance_id: `dead-${index}`, exit_code: 1 }
      });
    }
    const cancelled = await executeWorkspaceAction(repo, {
      type: "run.stop",
      payload: { session_id: started.value.session_id, reason: "Stop the whole admitted run." }
    });
    assert.equal(cancelled.ok, true, cancelled.ok ? undefined : cancelled.reason);
    const events = await readRequiredEvents(repo);
    assert.equal(events.some((event) => event.type === "scheduler.run_cancel_requested"), true);
    assert.equal(events.some((event) => event.type === "scheduler.run_cancelled"), true);
    assert.equal(events.some((event) => event.type === "task.started" && event.task_id === fixture.taskIds[2]), false);
    for (const taskId of fixture.taskIds.slice(0, 2)) {
      assert.equal(events.filter((event) => event.type === "task.cancel_requested" && event.task_id === taskId).length, 1);
      assert.equal(events.filter((event) => event.type === "task.cancelled" && event.task_id === taskId).length, 1);
    }
  });
});

test("a provider quota wall pauses only its lane while an already-reserved sibling completes", async () => {
  await withTempRepo(async ({ repo }) => {
    const taskIds = ["T-WAVE-001", "T-WAVE-002"];
    const fixture = await prepareConcurrentManagerFixture(repo, 2, 2, "parallel", 2_000, 500_000, undefined, taskIds[0], true);
    const started = await startWorkspaceManagerSession(repo, "Run until one provider lane reaches its quota wall.", "manager");
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const continuation = continueAutonomousManagerLoop(repo, started.value.session_id, { tool: "manager", maxSteps: 100 });
    // "Already-reserved sibling" is the precondition this test exists to
    // exercise, so it is established by construction: both lanes are proven in
    // flight and blocked before either is allowed to reach its outcome.
    assert.deepEqual(await waitForWorkersInFlight(fixture.barrierDir, 2), taskIds);
    await releaseWorkers(fixture.barrierDir);
    const result = await continuation;
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    const events = await readRequiredEvents(repo);
    const pause = events.find((event) => event.type === "task.paused" && event.task_id === taskIds[0]);
    assert.equal(pause?.data.reason, "quota_exhausted");
    assert.equal(events.some((event) => event.type === "task.failed" && event.task_id === taskIds[0]), false);
    assert.equal(events.some((event) => event.type === "task.completed" && event.task_id === taskIds[1]), true);
    assert.equal(events.some((event) => event.type === "integration.passed" && Array.isArray(event.data.applied) && event.data.applied.includes(taskIds[1])), true);
    const status = await getStatus(repo);
    assert.equal(status.ok, true, status.ok ? undefined : status.reason);
    if (status.ok) {
      assert.equal(status.value.leases[`${taskIds[0]}.txt`], taskIds[0]);
      assert.notEqual(status.value.tasks.find((task) => task.task_id === taskIds[0])?.worktree, "missing");
    }
  });
});

test("a spawn-time session reservation refusal stops new lanes without disturbing an in-flight sibling", async () => {
  await withTempRepo(async ({ repo }) => {
    const fixture = await prepareConcurrentManagerFixture(repo, 3, 2, "parallel", 2_500, 300_000);
    const started = await startWorkspaceManagerSession(repo, "Run until a concurrent budget race closes a slot.", "manager");
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;

    /* Establish the competing reservation before the wave begins. Waiting for
       scheduler.wave_started raced this one-token reservation against both
       worker spawns; under full-suite load the second worker could reserve
       first, so the test sometimes exercised three successful admissions
       instead of the spawn-time refusal it named. With one token already held,
       the first worker still fits and the second deterministically crosses the
       exact session ceiling. */
    const competingReservation = await reserveMeteredCall(repo, {
      provider: "external-metered-call",
      session_id: started.value.session_id,
      run_id: "R-external-budget-race",
      task_id: null,
      daemon_instance_id: "test-external-budget-race",
      estimated_input_tokens: 1
    });
    assert.equal(competingReservation.ok, true, competingReservation.ok ? undefined : competingReservation.reason);

    const continuation = continueAutonomousManagerLoop(repo, started.value.session_id, { tool: "manager", maxSteps: 100 });
    const result = await continuation;
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.equal(result.value.status, "stopped");

    const events = await readRequiredEvents(repo);
    const startedWorkers = fixture.taskIds.slice(0, 2).filter((taskId) =>
      events.some((event) => event.type === "task.worker_process_started" && event.task_id === taskId)
    );
    assert.equal(startedWorkers.length, 1, "spawn-time budget admission did not leave exactly one in-flight worker");
    const survivorTaskId = startedWorkers[0];
    assert.equal(events.some((event) => event.type === "task.completed" && event.task_id === survivorTaskId), true);
    assert.equal(events.some((event) => event.type === "integration.passed" && Array.isArray(event.data.applied) && event.data.applied.includes(survivorTaskId)), true);
    assert.equal(events.some((event) => event.type === "task.started" && event.task_id === fixture.taskIds[2]), false);
    const stoppedWave = events.find((event) => event.type === "scheduler.wave_stopped");
    assert.match(typeof stoppedWave?.data.reason === "string" ? stoppedWave.data.reason : "", /token budget exceeded: session/u);
  });
});
