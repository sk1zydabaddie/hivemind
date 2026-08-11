import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { appendEvent, readEvents, type HivemindEvent } from "../../src/events.js";
import { currentBuildIdentity } from "../../src/build-identity.js";
import { loadConfig } from "../../src/config.js";
import { createDaemonServer } from "../../src/daemon.js";
import { initProject } from "../../src/init.js";
import { integratedTaskIdsFromEvents } from "../../src/integration-state.js";
import { requestLease } from "../../src/lease.js";
import { readQuotaLedger, readQuotaLedgerState, recordQuotaUsage, reserveMeteredCall } from "../../src/resource-ledger.js";
import { latestTaskRunState } from "../../src/run-state.js";
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
} from "../../src/manager.js";
import { createSpec, type SpecResult } from "../../src/spec.js";
import { getStatus } from "../../src/status.js";
import { executeWorkspaceAction } from "../../src/workspace-actions.js";
import { admitExecutionWave } from "../../src/wave-admission.js";
import { authorizePlanlessManualTaskIfEligible } from "./manual-task.js";
import { createRatifiedSpec } from "./spec.js";
import { useOnlyFixtureAdapterProfiles, withTemplateRepo } from "./fixture-repo.js";

export const execFileAsync = promisify(execFile);
export const testDir = dirname(fileURLToPath(import.meta.url));
export const cliPath = path.resolve(testDir, "../../src/cli.js");

export interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
}


export async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "manager",
    async (repo) => {
      await git(repo, ["init"]);
      await git(repo, ["config", "user.name", "Hivemind Test"]);
      await git(repo, ["config", "user.email", "hivemind@example.test"]);
      await git(repo, ["checkout", "-b", "main"]);
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await git(repo, ["add", "README.md"]);
      await git(repo, ["commit", "-m", "initial"]);
      await initProject(repo);
      await useOnlyFixtureAdapterProfiles(repo);
      await setConfigManagerAutonomy(repo, { level: "review_everything" });
    },
    async (repo) => {
      await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
    },
    "hivemind-manager-test-",
    async (repo) => { await cleanupTempRepo(repo); }
  );
}

export async function runAutonomousLoopWithTypedApprovals(
  repo: string,
  message: string,
  tool: string,
  maxSteps: number,
  approvedTypes: Set<ManagerAction["type"]>
): Promise<SpecResult<ManagerAutonomousLoopResult>> {
  let result = await runAutonomousManagerLoop(repo, message, { tool, maxSteps });
  const steps: ManagerAutonomousLoopResult["steps"] = [];
  for (let approvals = 0; approvals <= maxSteps; approvals += 1) {
    if (!result.ok) return result;
    const pendingStep = result.value.steps.at(-1);
    if (result.value.status !== "paused" || pendingStep?.pause === undefined) {
      return { ok: true, value: { ...result.value, steps: [...steps, ...result.value.steps] } };
    }
    steps.push(...result.value.steps.slice(0, -1));
    if (!approvedTypes.has(pendingStep.action_type)) {
      return { ok: true, value: { ...result.value, steps: [...steps, pendingStep] } };
    }
    const pending = pendingStep.pause;
    const approved = await approvePendingManagerAction(repo, {
      session_id: result.value.session_id,
      pending_action_id: pending.pending_action_id,
      action_type: pending.action_type,
      subject: pending.subject,
      expected_state_hash: pending.expected_state_hash
    });
    if (!approved.ok) return approved;
    if (!approved.value.result.ok) {
      const status = await getStatus(repo);
      if (!status.ok) return status;
      steps.push({
        index: steps.length,
        action_type: approved.value.action_type,
        tier: "gate_rejection",
        result: approved.value.result,
        stop: {
          reason: approved.value.result.reason,
          diagnosis: `The deterministic gate rejected ${approved.value.action_type}; this is a Tier 3 hard stop, not a prompt for autonomous retry.`,
          options: ["Do not change provider tiers, risk config, safety rules, or approval policy inside the autonomous loop to force this action through."],
          recommendation: "Stop the loop and ask the human which option to take."
        }
      });
      return {
        ok: true,
        value: {
          session_id: result.value.session_id,
          session_path: result.value.session_path,
          status: "stopped",
          steps,
          final_status: status.value
        }
      };
    }
    steps.push({ index: steps.length, action_type: approved.value.action_type, tier: "human_approval", result: approved.value.result });
    result = await continueAutonomousManagerLoop(repo, result.value.session_id, { tool, maxSteps });
  }
  return { ok: false, reason: "typed approval fixture exceeded its deterministic approval bound" };
}

export interface WorkerInterval {
  taskId: string;
  start: number;
  end: number;
}

export interface ConcurrentFixtureResult {
  events: HivemindEvent[];
  intervals: WorkerInterval[];
  workerWindowMs: number;
  perTaskTrail: Record<string, string[]>;
}

export async function runConcurrentManagerFixture(options: {
  taskCount: number;
  concurrency: number;
  mode: "parallel" | "sequence";
  workerDelayMs: number;
  sessionCeiling?: number;
  seedSettledUsage?: boolean;
  barrier?: boolean;
  /**
   * Runs while the scheduler loop is still in flight, so a test can observe and
   * release lanes instead of inferring their overlap from timestamps afterwards.
   */
  drive?: (context: { repo: string; barrierDir: string; taskIds: string[] }) => Promise<void>;
}): Promise<ConcurrentFixtureResult> {
  let output: ConcurrentFixtureResult | undefined;
  await withTempRepo(async ({ repo }) => {
    const fixture = await prepareConcurrentManagerFixture(
      repo,
      options.taskCount,
      options.concurrency,
      options.mode,
      options.workerDelayMs,
      options.sessionCeiling ?? 500_000,
      undefined,
      undefined,
      options.barrier === true
    );
    if (options.seedSettledUsage === true) {
      const seeded = await recordQuotaUsage(repo, {
        provider: "seeded-manager-history",
        input_text: "one settled token before concurrent admission",
        model_output_text: "",
        wall_time_ms: 1,
        throttled: false,
        session_id: "11111111-1111-4111-8111-111111111111"
      });
      assert.equal(seeded.ok, true, seeded.ok ? undefined : seeded.reason);
    }

    const started = await startWorkspaceManagerSession(repo, "Run the deterministic concurrent fixture.", "manager");
    assert.equal(started.ok, true, started.ok ? undefined : started.reason);
    if (!started.ok) return;
    const continuation = continueAutonomousManagerLoop(repo, started.value.session_id, { tool: "manager", maxSteps: 100 });
    if (options.drive !== undefined) {
      await options.drive({ repo, barrierDir: fixture.barrierDir, taskIds: fixture.taskIds });
      await releaseWorkers(fixture.barrierDir);
    }
    const result = await continuation;
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    assert.equal(result.value.status, "completed", JSON.stringify(result.value.steps.at(-1)));

    const events = await readRequiredEvents(repo);
    const intervals = workerIntervals(events, fixture.taskIds);
    const workerWindowMs = Math.max(...intervals.map((entry) => entry.end)) - Math.min(...intervals.map((entry) => entry.start));
    output = {
      events,
      intervals,
      workerWindowMs,
      perTaskTrail: Object.fromEntries(
        fixture.taskIds.map((taskId) => [
          taskId,
          events.filter((event) => event.task_id === taskId).map((event) => event.type)
        ])
      )
    };
  });
  assert.ok(output);
  return output;
}

/**
 * Explicit synchronisation for concurrent fixtures.
 *
 * Wall-clock overlap of real spawned processes is not evidence: under CPU
 * contention a sleeping worker is starved and the "overlap" these tests claim
 * to prove silently stops happening. A barrier makes each worker announce
 * itself and then block until the test releases it, so the test can prove that
 * N workers are simultaneously in flight before any of them proceeds, and can
 * control ordering instead of hoping for it.
 */
export function barrierDirectoryFor(repo: string): string {
  return path.join(path.dirname(repo), `${path.basename(repo)}-barrier`);
}

/** Workers currently announced at the barrier, without waiting for more. */
export async function observeWorkersInFlight(barrierDir: string): Promise<string[]> {
  return (await readdir(barrierDir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".started"))
    .map((name) => name.slice(0, -".started".length))
    .sort();
}

/** Resolves once `expected` workers are simultaneously blocked at the barrier. */
export async function waitForWorkersInFlight(
  barrierDir: string,
  expected: number,
  timeoutMs = 60_000
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const started = (await readdir(barrierDir).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".started"))
      .map((name) => name.slice(0, -".started".length))
      .sort();
    if (started.length >= expected) return started;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const seen = (await readdir(barrierDir).catch(() => [] as string[])).join(", ");
  throw new Error(`expected ${expected} workers in flight before release; saw [${seen}]`);
}

/**
 * Releases workers blocked at the barrier. Naming task ids releases only those
 * lanes, so a test can drive one lane to its outcome while its siblings are
 * provably still blocked -- which is what makes "the failing lane did not touch
 * the sibling" an observation rather than a race.
 */
export async function releaseWorkers(barrierDir: string, taskIds?: string[]): Promise<void> {
  if (taskIds === undefined) {
    await writeFile(path.join(barrierDir, "release"), "");
    return;
  }
  for (const taskId of taskIds) {
    await writeFile(path.join(barrierDir, `${taskId}.release`), "");
  }
}

export async function prepareConcurrentManagerFixture(
  repo: string,
  taskCount: number,
  concurrency: number,
  mode: "parallel" | "sequence",
  workerDelayMs: number,
  sessionCeiling: number,
  failTaskId?: string,
  quotaTaskId?: string,
  barrier = false
): Promise<{ taskIds: string[]; barrierDir: string }> {
  const barrierDir = barrierDirectoryFor(repo);
  if (barrier) await mkdir(barrierDir, { recursive: true });
  await createRatifiedSpec(repo, "S-001");
  await setConfigManagerAutonomy(repo, { level: "auto" });
  const taskIds = Array.from({ length: taskCount }, (_, index) => `T-WAVE-${String(index + 1).padStart(3, "0")}`);
  for (const taskId of taskIds) await writeFile(path.join(repo, `${taskId}.txt`), `${taskId} base\n`);
  await git(repo, ["add", ...taskIds.map((taskId) => `${taskId}.txt`)]);
  await git(repo, ["commit", "-m", "add concurrent fixture files"]);
  const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);

  const workerPath = await writeAgent(repo, "concurrent-worker.mjs", [
    "const { appendFile, writeFile, access } = await import('node:fs/promises');",
    "const { basename, join } = await import('node:path');",
    "const taskId = basename(process.cwd());",
    "await appendFile(`${taskId}.txt`, `changed by ${taskId}\\n`);",
    // Announce, then block until released. The test proves overlap from the
    // announcements, so no worker outcome depends on wall-clock timing.
    ...(barrier
      ? [
          `const barrierDir = ${JSON.stringify(barrierDir)};`,
          "await writeFile(join(barrierDir, `${taskId}.started`), '');",
          "while (true) {",
          "  try { await access(join(barrierDir, 'release')); break; } catch {}",
          "  try { await access(join(barrierDir, `${taskId}.release`)); break; } catch {}",
          "  await new Promise((resolve) => setTimeout(resolve, 10));",
          "}"
        ]
      : []),
    ...(failTaskId === undefined
      ? []
      : [
          `if (taskId === ${JSON.stringify(failTaskId)}) {`,
          ...(barrier ? [] : [`  await new Promise((resolve) => setTimeout(resolve, ${Math.max(1, Math.floor(workerDelayMs / 2))}));`]),
          "  throw new Error('fixture worker failure');",
          "}"
        ]),
    ...(quotaTaskId === undefined
      ? []
      : [
          `if (taskId === ${JSON.stringify(quotaTaskId)}) {`,
          ...(barrier ? [] : [`  await new Promise((resolve) => setTimeout(resolve, ${Math.max(1, Math.floor(workerDelayMs / 2))}));`]),
          "  console.error('429 rate limit exceeded; retry after provider reset');",
          "  process.exit(1);",
          "}"
        ]),
    // A barriered worker's lifetime is bounded by the release, never by a sleep.
    ...(barrier ? [] : [`await new Promise((resolve) => setTimeout(resolve, ${workerDelayMs}));`])
  ]);
  await writeProfile(repo, "concurrent-worker", workerPath);
  await setConfigExecution(repo, concurrency);
  await setResourceSessionCeiling(repo, sessionCeiling);
  /* Declared, not inherited: these fixtures assert how many workers fit under
     the session ceiling, which depends on this number. */
  await setResourceRunCeiling(repo, 150_000);
  /* Same discipline for providers. These fixtures assert what happens when a
     provider lane hits a wall, which is only meaningful against a known set of
     providers -- init's tier ladder would reroute instead of pausing, which is
     correct behaviour for a real project and wrong for this test. */
  await removeDefaultTierWorkers(repo);
  await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
  await prepareLintedPlanWithTasks(
    repo,
    taskIds.map((taskId) => planTaskFromContract(managerContract(taskId, baseCommit, [`${taskId}.txt`]))),
    "concurrent-plan.json",
    mode
  );
  if (mode === "parallel") {
    const admission = await admitExecutionWave(repo, "S-001", "G-1");
    assert.equal(admission.ok, true, admission.ok ? undefined : admission.reason);
    if (admission.ok) assert.deepEqual(admission.value.admitted_task_ids, taskIds);
  }
  return { taskIds, barrierDir };
}

export function workerIntervals(events: HivemindEvent[], taskIds: string[]): WorkerInterval[] {
  return taskIds.map((taskId) => {
    const started = events.find((event) => event.type === "task.worker_process_started" && event.task_id === taskId);
    const stopped = events.find((event) => event.type === "task.worker_process_stopped" && event.task_id === taskId);
    assert.ok(started, `missing worker start for ${taskId}`);
    assert.ok(stopped, `missing worker stop for ${taskId}`);
    return { taskId, start: Date.parse(started.ts), end: Date.parse(stopped.ts) };
  });
}

export function maxConcurrentIntervals(intervals: WorkerInterval[]): number {
  const points = intervals.flatMap((interval) => [
    { at: interval.start, delta: 1 },
    { at: interval.end, delta: -1 }
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

export function managerContract(taskId: string, baseCommit: string, allowedFiles: string[]): Record<string, unknown> {
  return {
    task_id: taskId,
    title: "Manager loop fixture",
    agent_role: "builder",
    routing_task_type: "other",
    base_commit: baseCommit,
    acceptance_criterion: "Manager loop fixture completes one deterministic flow.",
    allowed_files: allowedFiles,
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: ["submit diff only"]
  };
}

export function intentFor(taskId: string, intendedFiles: string[]): Record<string, unknown> {
  return {
    task_id: taskId,
    intended_files: intendedFiles,
    intended_symbols: [],
    possible_risks: [],
    will_not_change: []
  };
}

export function testProposal(actions: ManagerAction[] = []): ManagerProposedAction {
  return {
    type: "proposed_actions",
    source: "scripted",
    reason: "Test-seeded proposal for deterministic manager executor coverage.",
    actions,
    human_approval_required_for: []
  };
}

export function proposalFor(actions: ManagerAction[], humanApprovalRequiredFor: ManagerAction["type"][] = []): Record<string, unknown> {
  return {
    reason: actions.length === 0 ? "No next manager action is currently needed." : `Propose ${actions[0].type} from observed state.`,
    human_approval_required_for: humanApprovalRequiredFor,
    actions
  };
}

export async function prepareLintedPlan(repo: string, contract: Record<string, unknown>, name = `${String(contract.task_id)}-plan.json`): Promise<void> {
  await prepareLintedPlanWithTasks(repo, [planTaskFromContract(contract)], name);
}

export async function prepareLintedPlanWithTasks(
  repo: string,
  tasks: Record<string, unknown>[],
  name = "plan.json",
  mode: "parallel" | "sequence" = "sequence"
): Promise<void> {
  const planPath = path.join(repo, name);
  await writeFile(
    planPath,
    `${JSON.stringify(
        {
          tasks,
        execution_groups: [{ group_id: "G-1", mode, task_ids: tasks.map((task) => task.task_id) }]
      },
      null,
      2
    )}\n`
  );
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
  const review = JSON.parse((await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--review"], { cwd: repo, windowsHide: true })).stdout) as { plan_hash: string };
  await appendEvent(repo, {
    type: "plan.prepared",
    task_id: null,
    data: {
      version: 1,
      spec_id: "S-001",
      plan_hash: review.plan_hash,
      plan_path: ".hivemind/plans/S-001.tentative.json",
      proposal_path: name,
      usage_session_id: "11111111-1111-4111-8111-111111111111",
      status: "awaiting_ratification",
      authorization_effect: "none"
    }
  });
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ratify", review.plan_hash], { cwd: repo, windowsHide: true });
}

export function planTaskFromContract(contract: Record<string, unknown>, dependsOn: string[] = []): Record<string, unknown> {
  return {
    task_id: contract.task_id,
    title: contract.title,
    task_type: "deterministic",
    routing_task_type: contract.routing_task_type,
    mode: "write",
    agent_role: contract.agent_role,
    draft_scope: {
      allowed_files: contract.allowed_files,
      read_only_files: contract.read_only_files,
      forbidden_files: contract.forbidden_files,
      must_not_change: contract.must_not_change
    },
    depends_on: dependsOn,
    parallel_safe: true,
    acceptance_criterion: contract.acceptance_criterion,
    required_tests: contract.required_tests,
    patch_requirements: contract.patch_requirements
  };
}

export async function appendIntegratedDependencyEvents(repo: string, taskId: string): Promise<void> {
  await appendEvent(repo, {
    type: "patch.submitted",
    task_id: taskId,
    data: { bundle_path: `.hivemind/patches/${taskId}`, changed_files: 1 }
  });
  await appendEvent(repo, {
    type: "patch.accepted",
    task_id: taskId,
    data: { verdict: "accept", reason: "accepted dependency fixture" }
  });
  await appendEvent(repo, {
    type: "integration.passed",
    task_id: null,
    data: { applied: [taskId], tests: "pass" }
  });
}

export async function contractFiles(repo: string): Promise<string[]> {
  return (await childNames(path.join(repo, ".hivemind", "tasks"))).filter((name) => name.endsWith(".contract.json"));
}

export async function childNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

export async function assertExists(filePath: string): Promise<void> {
  await stat(filePath);
}

export async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(isNodeError(error, "ENOENT"), true);
    return true;
  });
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function readSession(
  repo: string,
  sessionPath: string
): Promise<{
  session_id: string;
  proposal_state: { proposal_id: string; status: "pending" | "consumed" | "discarded"; next_action_index?: number; consumed_at?: string; discard_reason?: string };
  pending_action?: { action: { type: string }; reason: string; recommendation: string };
  blocked_action?: { action_type: string; result: { ok: false; reason: string } };
  executed_actions: Array<{ type: string; result: { ok: boolean; reason?: string } }>;
}> {
  return JSON.parse(await readFile(path.join(repo, sessionPath), "utf8")) as {
    session_id: string;
    proposal_state: { proposal_id: string; status: "pending" | "consumed" | "discarded"; next_action_index?: number; consumed_at?: string; discard_reason?: string };
    pending_action?: { action: { type: string }; reason: string; recommendation: string };
    blocked_action?: { action_type: string; result: { ok: false; reason: string } };
    executed_actions: Array<{ type: string; result: { ok: boolean; reason?: string } }>;
  };
}

export async function readRequiredEvents(repo: string) {
  const events = await readEvents(repo);
  assert.equal(events.ok, true);
  if (!events.ok) {
    return [];
  }
  return events.value;
}


export function assertEventOrder(actual: string[], expected: string[]): void {
  let cursor = 0;
  for (const type of actual) {
    if (type === expected[cursor]) {
      cursor += 1;
    }
    if (cursor === expected.length) {
      return;
    }
  }
  assert.fail(`event order missing subsequence: ${expected.join(", ")} in ${actual.join(", ")}`);
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export async function setConfigTestCommand(repo: string, testCommand: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.test_command = testCommand;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function setUnknownCoverageConfig(repo: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.test_command = "node -e \"process.exit(0)\"";
  config.verification = {
    checks: [
      {
        id: "full",
        command: "node -e \"process.exit(0)\"",
        entry_files: ["README.md"]
      }
    ],
    coverage: {
      command: "node -e \"process.exit(0)\"",
      report_path: "coverage/lcov.info",
      format: "lcov"
    }
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function setConfigManagerAutonomy(repo: string, managerAutonomy: Record<string, unknown>): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.manager_autonomy = {
    ...((typeof config.manager_autonomy === "object" && config.manager_autonomy !== null && !Array.isArray(config.manager_autonomy)
      ? config.manager_autonomy
      : {}) as Record<string, unknown>),
    ...managerAutonomy
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function setConfigExecution(repo: string, maxConcurrentWorkers: number): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.execution = { max_concurrent_workers: maxConcurrentWorkers };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Replaces the whole tier map rather than merging into it, so a caller naming
 * one tier gets exactly that tier. Tier inference stops at the first match in
 * critical -> high -> medium -> low order, so merging left init's defaults
 * shadowing whichever tier the caller was trying to declare.
 */
export async function setTierPatterns(
  repo: string,
  patterns: { low_globs?: string[]; medium_globs?: string[]; high_globs?: string[]; critical_globs?: string[] }
): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.low_globs = patterns.low_globs ?? [];
  config.medium_globs = patterns.medium_globs ?? [];
  config.high_globs = patterns.high_globs ?? [];
  config.critical_globs = patterns.critical_globs ?? [];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Budget tests must DECLARE the run ceiling, not inherit it.
 *
 * These fixtures assert how many workers fit under a session ceiling, which
 * depends on the per-call reservation -- the run ceiling. Inheriting that from
 * init's defaults coupled them to a number they do not assert, so raising the
 * default (because it was below one real worker call) broke six concurrency
 * tests that have nothing to do with it. Same lesson as declaring the tier and
 * provider set rather than inheriting init's.
 */
/** Drop init's tier ladder so a fixture's provider set is exactly what it declares. */
export async function removeDefaultTierWorkers(repo: string): Promise<void> {
  for (const tool of ["worker-standard", "worker-cheap"]) {
    await rm(path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`), { force: true });
  }
}

export async function setResourceRunCeiling(repo: string, tokens: number): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const policy = typeof config.resource_policy === "object" && config.resource_policy !== null && !Array.isArray(config.resource_policy)
    ? config.resource_policy as Record<string, unknown>
    : {};
  config.resource_policy = { ...policy, run_ceiling: { tokens } };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}
`);
}

export async function setResourceSessionCeiling(repo: string, tokens: number): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const policy = typeof config.resource_policy === "object" && config.resource_policy !== null && !Array.isArray(config.resource_policy)
    ? config.resource_policy as Record<string, unknown>
    : {};
  config.resource_policy = { ...policy, session_ceiling: { tokens } };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function allowFixtureManagerCalls(repo: string): Promise<void> {
  await setConfigManagerAutonomy(repo, {
    tier2_actions: [],
    cost_threshold: { estimated_requests: 1 }
  });
}

export async function writeAgent(repo: string, fileName: string, lines: string[]): Promise<string> {
  const agentsDir = path.join(repo, "fake-agents");
  await mkdir(agentsDir, { recursive: true });
  const agentPath = path.join(agentsDir, fileName);
  await writeFile(agentPath, `${lines.join("\n")}\n`);
  return agentPath;
}

export async function writeProfile(
  repo: string,
  tool: string,
  agentPath: string,
  routingTier = "strong",
  costRank = 1,
  timeoutMs?: number
): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: routingTier,
        cost_rank: costRank,
        ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs })
      },
      null,
      2
    )}\n`
  );
}

export async function writeReactiveManagerProposalProfile(
  repo: string,
  proposals: Record<string, Record<string, unknown>>,
  tool = "manager",
  costRank = 1
): Promise<void> {
  const agentPath = await writeAgent(repo, `${tool}-reactive-proposal-agent.mjs`, [
    "const { appendFile } = await import('node:fs/promises');",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    `const proposals = ${JSON.stringify(proposals)};`,
    "const match = input.match(/Last manager observation: action ([a-z_]+) returned (ok|rejected)/);",
    "const key = match ? `after_${match[1]}_${match[2]}` : 'initial';",
    "await appendFile('.hivemind/manager-reactive-calls.log', `${key}\\n`);",
    "console.log(JSON.stringify(proposals[key] ?? { reason: 'No follow-up action.', human_approval_required_for: [], actions: [] }));"
  ]);
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: "strong",
        cost_rank: costRank
      },
      null,
      2
    )}\n`
  );
}

export async function writeRedirectAwareManagerProfile(
  repo: string,
  taskId: string,
  contract: Record<string, unknown>,
  workerTool: string,
  options: { repeatBadIntentAfterRedirect?: boolean } = {}
): Promise<void> {
  const badIntent = intentFor(taskId, ["src/schema.ts"]);
  const correctedIntent = intentFor(taskId, ["README.md"]);
  const proposals = {
    initial: proposalFor([{ type: "create_task_contract", contract }]),
    after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: taskId }]),
    after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: taskId, intent: badIntent }]),
    after_check_write_intent_ok: proposalFor([{ type: "create_worktree", task_id: taskId }]),
    after_create_worktree_ok: proposalFor([{ type: "run_worker", task_id: taskId, tool: workerTool }], ["run_worker"]),
    after_run_worker_ok: proposalFor([{ type: "submit_patch", task_id: taskId }]),
    after_submit_patch_ok: proposalFor([{ type: "analyze_patch", task_id: taskId }]),
    after_analyze_patch_ok: proposalFor([])
  };
  const correctedProposal = proposalFor([
    { type: "check_write_intent", task_id: taskId, intent: options.repeatBadIntentAfterRedirect === true ? badIntent : correctedIntent }
  ]);
  const agentPath = await writeAgent(repo, "manager-redirect-aware-agent.mjs", [
    "const { appendFile } = await import('node:fs/promises');",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    `const taskId = ${JSON.stringify(taskId)};`,
    `const proposals = ${JSON.stringify(proposals)};`,
    `const correctedProposal = ${JSON.stringify(correctedProposal)};`,
    "if (input.includes('A deterministic write-intent gate has already refused')) {",
    "  const specific = input.includes('src/schema.ts') && input.includes('README.md');",
    "  await appendFile('.hivemind/manager-reactive-calls.log', specific ? 'correction_prompt_specific\\n' : 'correction_prompt_generic\\n');",
    "  console.log(JSON.stringify({ correction: 'Do not edit src/schema.ts; it is outside this task lease. Use README.md only for this task, re-declare write-intent for README.md, and continue without widening scope.' }));",
    "  process.exit(0);",
    "}",
    "const match = input.match(/Last manager observation: action ([a-z_]+) returned (ok|rejected)/);",
    "const key = match ? `after_${match[1]}_${match[2]}` : 'initial';",
    "if (key === 'after_check_write_intent_rejected') {",
    "  const redirected = input.includes('task.redirected') && input.includes('Do not edit src/schema.ts') && input.includes('README.md');",
    "  await appendFile('.hivemind/manager-reactive-calls.log', redirected ? 'after_check_write_intent_rejected_redirected\\n' : 'after_check_write_intent_rejected_unredirected\\n');",
    "  console.log(JSON.stringify(redirected ? correctedProposal : { reason: 'No redirect evidence.', human_approval_required_for: [], actions: [] }));",
    "  process.exit(0);",
    "}",
    "await appendFile('.hivemind/manager-reactive-calls.log', `${key}\\n`);",
    "console.log(JSON.stringify(proposals[key] ?? { reason: 'No follow-up action.', human_approval_required_for: [], actions: [] }));"
  ]);
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, "manager.profile.json"),
    `${JSON.stringify(
      {
        tool: "manager",
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 2048,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
}

export async function writePatchPipelineAwareManagerProfile(repo: string, taskId: string, workerTool: string, tool = "manager"): Promise<void> {
  const contract = managerContract(taskId, await gitStdout(repo, ["rev-parse", "HEAD"]), ["README.md"]);
  const proposals = {
    initial: proposalFor([{ type: "create_task_contract", contract }]),
    after_create_task_contract_ok: proposalFor([{ type: "request_lease", task_id: taskId }]),
    after_request_lease_ok: proposalFor([{ type: "check_write_intent", task_id: taskId, intent: intentFor(taskId, ["README.md"]) }]),
    after_check_write_intent_ok: proposalFor([{ type: "create_worktree", task_id: taskId }]),
    after_create_worktree_ok: proposalFor([{ type: "run_worker", task_id: taskId, tool: workerTool }], ["run_worker"]),
    after_submit_patch_ok: proposalFor([])
  };
  const submitProposal = proposalFor([{ type: "submit_patch", task_id: taskId }]);
  const unsafeEnqueueProposal = proposalFor([{ type: "enqueue_patch", task_id: taskId }]);
  const agentPath = await writeAgent(repo, `${tool}-pipeline-aware-proposal-agent.mjs`, [
    "const { appendFile } = await import('node:fs/promises');",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    `const taskId = ${JSON.stringify(taskId)};`,
    `const proposals = ${JSON.stringify(proposals)};`,
    `const submitProposal = ${JSON.stringify(submitProposal)};`,
    `const unsafeEnqueueProposal = ${JSON.stringify(unsafeEnqueueProposal)};`,
    "const match = input.match(/Last manager observation: action ([a-z_]+) returned (ok|rejected)/);",
    "const key = match ? `after_${match[1]}_${match[2]}` : 'initial';",
    "if (key === 'after_run_worker_ok') {",
    "  const statusStart = input.indexOf('Durable status JSON:');",
    "  const planStart = input.indexOf('Tentative plan JSON or missing state:');",
    "  const statusText = statusStart === -1 || planStart === -1 ? input : input.slice(statusStart, planStart);",
    "  const taskMarker = `\"task_id\": \"${taskId}\"`;",
    "  const sawUnsubmittedPatch = statusText.includes(taskMarker) && statusText.includes('\"bundle\": \"present\"') && statusText.includes('\"submitted\": false') && statusText.includes('\"analyzed\": false') && statusText.includes('\"accepted\": false') && statusText.includes('\"verdict\": null');",
    "  await appendFile('.hivemind/manager-reactive-calls.log', sawUnsubmittedPatch ? 'after_run_worker_ok_unsubmitted\\n' : 'after_run_worker_ok_misleading\\n');",
    "  console.log(JSON.stringify(sawUnsubmittedPatch ? submitProposal : unsafeEnqueueProposal));",
    "  process.exit(0);",
    "}",
    "await appendFile('.hivemind/manager-reactive-calls.log', `${key}\\n`);",
    "console.log(JSON.stringify(proposals[key] ?? { reason: 'No follow-up action.', human_approval_required_for: [], actions: [] }));"
  ]);
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
}

export async function managerReactiveCalls(repo: string): Promise<string[]> {
  const filePath = path.join(repo, ".hivemind", "manager-reactive-calls.log");
  if (!(await exists(filePath))) {
    return [];
  }
  return (await readFile(filePath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
}

export async function writeManagerProposalProfile(
  repo: string,
  proposal: Record<string, unknown>,
  tool = "manager",
  extraInvokeArgs: string[] = []
): Promise<void> {
  const agentPath = await writeAgent(repo, `${tool}-proposal-agent.mjs`, [`console.log(${JSON.stringify(JSON.stringify(proposal))});`]);
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath, ...extraInvokeArgs],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
}

export async function writePromptCapturingManagerProfile(repo: string, contextWindow: number): Promise<void> {
  const proposal = proposalFor([{ type: "get_status" }]);
  const agentPath = await writeAgent(repo, "manager-prompt-capture-agent.mjs", [
    "const { writeFile } = await import('node:fs/promises');",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    "await writeFile('.hivemind/captured-manager-prompt.txt', input);",
    `console.log(${JSON.stringify(JSON.stringify(proposal))});`
  ]);
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, "manager.profile.json"),
    `${JSON.stringify(
      {
        tool: "manager",
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-16",
        context_window: contextWindow,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
}

export async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Manager executor fixture",
        agent_role: "builder",
        routing_task_type: "other",
        base_commit: baseCommit,
        acceptance_criterion: "Manager executor fixture reaches one deterministic result.",
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: ["node -e \"process.exit(0)\""],
        patch_requirements: []
      },
      null,
      2
    )}\n`
  );
  await authorizePlanlessManualTaskIfEligible(repo, taskId);
}

export async function writeAcceptedPatchBundle(repo: string, taskId: string, baseCommit: string, edit: () => Promise<void>): Promise<void> {
  await git(repo, ["reset", "--hard", baseCommit]);
  await edit();
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  await writeFile(path.join(patchDir, "diff.patch"), await gitRawStdout(repo, ["diff", "--no-renames", baseCommit]));
  await git(repo, ["reset", "--hard", baseCommit]);
  await appendEvent(repo, {
    type: "patch.submitted",
    task_id: taskId,
    data: { patch_path: `.hivemind/patches/${taskId}/diff.patch`, changed_files: 1 }
  });
  await appendEvent(repo, {
    type: "patch.accepted",
    task_id: taskId,
    data: { verdict: "accept", reason: "all changes are within scope" }
  });
}

export async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

export async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout;
}

export async function cleanupTempRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const worktreePath = line.slice("worktree ".length);
      if (worktreePath !== repo) {
        await git(repo, ["worktree", "remove", "--force", worktreePath]);
      }
    }
  } catch {
    // Best-effort cleanup before deleting the temp repo.
  }
  await rm(repo, { recursive: true, force: true, maxRetries: 3 });
}

export async function startDaemon(repo: string): Promise<DaemonProcess> {
  const child = spawn(process.execPath, [cliPath, "daemon", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
  const line = await readLine(child);
  const parsed = JSON.parse(line) as { event: string; url: string };
  assert.equal(parsed.event, "daemon.ready");
  return { child, url: parsed.url };
}

export async function stopDaemon(daemon: DaemonProcess): Promise<void> {
  if (daemon.child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    daemon.child.once("exit", () => resolve());
    daemon.child.kill();
  });
}

export async function listenServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function waitForDurableEvent(repo: string, type: string, taskId: string | null, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readEvents(repo);
    if (events.ok && events.value.some((event) => event.type === type && event.task_id === taskId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${type} on ${taskId}`);
}

export async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function postWorkspaceActionForTest(
  daemonUrl: string,
  action: Record<string, unknown>
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const body = JSON.stringify(action);
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${daemonUrl}/workspace/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(raw) as { ok: true; value: unknown } | { ok: false; reason: string });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error("workspace action deadlocked or timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

export interface RunLifecycleDaemon {
  url: string;
  readonly runRequests: number;
  readonly markFailedRequests: number;
  close: () => Promise<void>;
}

export async function startRunLifecycleDaemon(repo: string, options: { taskId: string; completionDelayMs?: number; quotaPauseAfterStart?: boolean }): Promise<RunLifecycleDaemon> {
  let runRequests = 0;
  let markFailedRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true, repo_root: repo, build_id: await currentBuildIdentity() });
        return;
      }
      if (request.method === "POST" && request.url === "/run") {
        runRequests += 1;
        await readJsonBody(request);
        const worktree = path.join(repo, ".hivemind", "worktrees", options.taskId);
        const started = await appendEvent(repo, {
          type: "task.started",
          task_id: options.taskId,
          data: { tool: "fake-delayed", worktree }
        });
        assert.equal(started.ok, true);
        if (options.quotaPauseAfterStart === true) {
          const paused = await appendEvent(repo, {
            type: "task.paused",
            task_id: options.taskId,
            data: {
              reason: "quota_exhausted",
              source: "quota-wall-recovery",
              snapshot_path: `.hivemind/resource/checkpoints/${options.taskId}.snapshot.json`,
              reroute_reason: "no eligible provider for strong task tier",
              awaiting: "quota_reset_or_provider_available"
            }
          });
          assert.equal(paused.ok, true);
        }
        if (options.completionDelayMs !== undefined) {
          setTimeout(() => {
            void completeFakeDaemonRun(repo, options.taskId);
          }, options.completionDelayMs);
        }
        sendJson(response, 200, {
          ok: true,
          value: {
            task_id: options.taskId,
            status: "started",
            tool: "fake-delayed",
            worktree
          }
        });
        return;
      }
      if (request.method === "POST" && request.url === "/run/mark-failed") {
        markFailedRequests += 1;
        const payload = await readJsonBody(request);
        const reason = typeof payload.reason === "string" ? payload.reason : "test timeout";
        const failed = await appendEvent(repo, {
          type: "task.failed",
          task_id: options.taskId,
          data: {
            reason,
            ...(payload.source === undefined ? {} : { source: payload.source })
          }
        });
        assert.equal(failed.ok, true);
        sendJson(response, 200, { ok: true, value: { task_id: options.taskId, status: "failed", reason } });
        return;
      }
      sendJson(response, 404, { ok: false, reason: "not found" });
    } catch (error: unknown) {
      sendJson(response, 500, { ok: false, reason: error instanceof Error ? error.message : "fake daemon failure" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    get runRequests() {
      return runRequests;
    },
    get markFailedRequests() {
      return markFailedRequests;
    },
    close: () => closeServer(server)
  };
}

export async function completeFakeDaemonRun(repo: string, taskId: string): Promise<void> {
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  const diffPath = path.join(patchDir, "diff.patch");
  await writeFile(diffPath, "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Fixture\n+changed by delayed daemon\n");
  const completed = await appendEvent(repo, {
    type: "task.completed",
    task_id: taskId,
    data: {
      task_id: taskId,
      status: "completed",
      tool: "fake-delayed",
      diff_path: diffPath,
      tool_exit: 0,
      changed_files: 1
    }
  });
  assert.equal(completed.ok, true);
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function withProcessEnv(updates: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export function readLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon did not become ready; stderr: ${stderr}`));
    }, 5000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolve(stdout.slice(0, newline).trim());
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`daemon exited before ready with code ${code}; stderr: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}
