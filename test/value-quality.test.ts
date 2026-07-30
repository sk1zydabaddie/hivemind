import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { readPromotedValueQualityPolicy } from "../src/learned-routing.js";
import { executeManagerAction, startManagerSession } from "../src/manager.js";
import { proposeMemoryLesson } from "../src/memory-log.js";
import { reviewMemoryProposalInteractively } from "../src/memory-review.js";
import { recordQuotaUsage } from "../src/resource-ledger.js";
import { admitValueQuality, authorizeValueQualityCall } from "../src/value-quality.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("value-quality admission applies the tier floor and only promoted current Medium policy has authority", async () => {
  await withValueQualityRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-LOW", baseCommit, "README.md", "cli");
    await writeContract(repo, "T-MEDIUM", baseCommit, "src/medium.ts", "cli");
    await writeContract(repo, "T-MEDIUM-OTHER", baseCommit, "src/medium.ts", "testing");
    await writeContract(repo, "T-HIGH", baseCommit, "src/high.ts", "cli");
    await writeContract(repo, "T-CRITICAL", baseCommit, "src/critical.ts", "cli");

    const unpromotedPolicy = await proposeValueQualityPolicy(repo, ["cli"]);
    const beforePromotion = await admitValueQuality(repo, "T-MEDIUM", { strategy: "best_of_n" });
    assert.equal(beforePromotion.ok, false);
    if (!beforePromotion.ok) {
      assert.match(beforePromotion.reason, /no human-promoted value-quality policy/);
    }

    assert.equal((await runInteractiveReview(repo, unpromotedPolicy)).ok, true);
    assert.equal((await readPromotedValueQualityPolicy(repo)).promoted, "active");

    const low = await admitValueQuality(repo, "T-LOW", { strategy: "best_of_n", n: 3 });
    assert.equal(low.ok, false);
    if (!low.ok) {
      assert.match(low.reason, /Low-tier tasks are never admitted/);
    }
    const medium = await admitValueQuality(repo, "T-MEDIUM", { strategy: "best_of_n" });
    assert.equal(medium.ok, true);
    if (medium.ok) {
      assert.equal(medium.value.draft_count, 2);
      assert.equal(medium.value.policy_status, "active");
      assert.equal(medium.value.routing_task_type, "cli");
      assert.match(medium.value.policy_canon_id ?? "", /^M-/u);
    }
    const unrelatedMedium = await admitValueQuality(repo, "T-MEDIUM-OTHER", { strategy: "draft_refine" });
    assert.equal(unrelatedMedium.ok, false);
    if (!unrelatedMedium.ok) {
      assert.match(unrelatedMedium.reason, /testing is not marked error-prone/);
    }
    const high = await admitValueQuality(repo, "T-HIGH", { strategy: "draft_refine" });
    const critical = await admitValueQuality(repo, "T-CRITICAL", { strategy: "best_of_n", n: 3 });
    assert.equal(high.ok, true);
    assert.equal(critical.ok, true);
    if (high.ok) {
      assert.equal(high.value.policy_status, "not_required");
    }

    if (medium.ok) {
      assert.equal((await appendEvent(repo, {
        type: "patch.rejected",
        task_id: "T-NEW",
        data: { reason: "later evidence makes the Medium admission policy stale" }
      })).ok, true);
      const staleCall = await authorizeValueQualityCall(repo, medium.value.quality_run_id);
      assert.equal(staleCall.ok, false);
      if (!staleCall.ok) {
        assert.match(staleCall.reason, /current admission policy no longer permits/);
      }
    }

    const tooFew = await admitValueQuality(repo, "T-HIGH", { strategy: "best_of_n", n: 1 });
    const tooMany = await admitValueQuality(repo, "T-HIGH", { strategy: "best_of_n", n: 4 });
    const callerOverride = await admitValueQuality(repo, "T-LOW", {
      strategy: "best_of_n",
      force: true,
      admitted: true,
      policy_status: "active"
    });
    assert.equal(tooFew.ok, false);
    assert.equal(tooMany.ok, false);
    assert.equal(callerOverride.ok, false);
    if (!callerOverride.ok) {
      assert.match(callerOverride.reason, /unsupported field/);
    }

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    const decisions = events.value.filter((event) => event.type === "quality.admission_decided");
    assert.equal(decisions.some((event) =>
      event.task_id === "T-LOW" &&
      event.data.admitted === false &&
      event.data.task_tier === "low" &&
      event.data.reason === "Low-tier tasks are never admitted to value-quality spending"
    ), true);
    assert.equal(decisions.some((event) =>
      event.task_id === "T-MEDIUM" &&
      event.data.admitted === true &&
      event.data.policy_status === "active" &&
      typeof event.data.policy_canon_id === "string" &&
      typeof event.data.policy_source_evidence_hash === "string"
    ), true);
  });
});

test("Medium admission fails closed for empty, stale, and invalid promoted policy state", async () => {
  await withValueQualityRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-MEDIUM", baseCommit, "src/medium.ts", "cli");
    const emptyPolicy = await proposeValueQualityPolicy(repo, []);
    assert.equal((await runInteractiveReview(repo, emptyPolicy)).ok, true);
    const result = await admitValueQuality(repo, "T-MEDIUM", { strategy: "draft_refine" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /names no error-prone routing task types/);
    }
  });

  await withValueQualityRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-MEDIUM", baseCommit, "src/medium.ts", "cli");
    const policy = await proposeValueQualityPolicy(repo, ["cli"]);
    assert.equal((await runInteractiveReview(repo, policy)).ok, true);
    assert.equal((await appendEvent(repo, {
      type: "patch.rejected",
      task_id: "T-NEW",
      data: { reason: "new evidence invalidates the prior policy identity" }
    })).ok, true);
    const result = await admitValueQuality(repo, "T-MEDIUM", { strategy: "draft_refine" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /does not match current Tier-1 routing evidence/);
    }
  });

  await withValueQualityRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-MEDIUM", baseCommit, "src/medium.ts", "cli");
    await mkdir(path.join(repo, ".hivemind", "canon"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "canon", "broken.memory.json"), "{not-json}\n");
    const result = await admitValueQuality(repo, "T-MEDIUM", { strategy: "draft_refine" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /invalid JSON/);
    }
  });
});

test("every value-quality call authorization rechecks tier and the shared quality-run token ceiling without spawning", async () => {
  await withValueQualityRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-HIGH", baseCommit, "src/high.ts", "cli");
    await writeProfile(repo, "strong-provider", "strong");
    await writeProfile(repo, "standard-provider", "standard");
    const admission = await admitValueQuality(repo, "T-HIGH", { strategy: "best_of_n" });
    assert.equal(admission.ok, true);
    if (!admission.ok) {
      return;
    }

    const first = await authorizeValueQualityCall(repo, admission.value.quality_run_id, {
      requestedTool: "strong-provider",
      estimatedInputTokens: 1_000
    });
    assert.equal(first.ok, true);
    const belowTier = await authorizeValueQualityCall(repo, admission.value.quality_run_id, {
      requestedTool: "standard-provider"
    });
    assert.equal(belowTier.ok, false);
    if (!belowTier.ok) {
      assert.match(belowTier.reason, /below required floor for high task tier/);
    }

    for (let index = 0; index < 5; index += 1) {
      await recordQuotaUsage(repo, {
        provider: "strong-provider",
        input_text: "",
        model_output_text: "",
        wall_time_ms: 1,
        throttled: false,
        session_id: admission.value.quality_run_id,
        provider_usage: {
          status: "captured",
          parser: "fixture",
          usage: {
            input_tokens: 100_000,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 100_000
          }
        }
      });
    }
    const exhausted = await authorizeValueQualityCall(repo, admission.value.quality_run_id, {
      requestedTool: "strong-provider"
    });
    assert.equal(exhausted.ok, false);
    if (!exhausted.ok) {
      assert.match(exhausted.reason, /session .* used 500000 effective tokens .* ceiling 500000/);
    }
    assert.equal(await fileExists(path.join(repo, "provider-spawned.txt")), false);
  });
});

test("CLI and manual manager callers cannot bypass Low-tier admission while autonomous proposals cannot request it", async () => {
  await withValueQualityRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-LOW", baseCommit, "README.md", "cli");
    await createRatifiedSpec(repo, "S-001");

    const cli = await runCliExpectFailure(
      repo,
      ["quality", "admit", "T-LOW", "--strategy", "best-of-n"],
      { HIVEMIND_VALUE_QUALITY_FORCE: "true" }
    );
    assert.match(cli.stderr, /Low-tier tasks are never admitted/);
    const forcedCli = await runCliExpectFailure(repo, ["quality", "admit", "T-LOW", "--strategy", "best-of-n", "--force"]);
    assert.match(forcedCli.stderr, /usage: hivemind quality admit/);

    const session = await startManagerSession(repo, "Human-authored admission attempt", {
      proposedAction: {
        type: "proposed_actions",
        source: "scripted",
        reason: "Fixture session.",
        actions: [],
        human_approval_required_for: []
      }
    });
    assert.equal(session.ok, true);
    if (!session.ok) {
      return;
    }
    const manager = await executeManagerAction(repo, session.value.session_id, {
      type: "admit_value_quality",
      task_id: "T-LOW",
      strategy: "best_of_n"
    });
    assert.equal(manager.ok, true);
    if (manager.ok) {
      assert.equal(manager.value.result.ok, false);
      if (!manager.value.result.ok) {
        assert.match(manager.value.result.reason, /Low-tier tasks are never admitted/);
      }
    }

    await writeManagerProfile(repo, {
      reason: "Attempt autonomous extra spending.",
      human_approval_required_for: [],
      actions: [{ type: "admit_value_quality", task_id: "T-LOW", strategy: "best_of_n" }]
    });
    const generated = await startManagerSession(repo, "Autonomous manager must not launch quality work");
    assert.equal(generated.ok, false);
    if (!generated.ok) {
      assert.match(generated.reason, /autonomous manager must not propose value-quality admission/);
    }
  });
});

async function withValueQualityRepo(
  run: (context: { repo: string; baseCommit: string }) => Promise<void>
): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-value-quality-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await git(repo, ["checkout", "-b", "main"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "medium.ts"), "export const medium = true;\n");
    await writeFile(path.join(repo, "src", "high.ts"), "export const high = true;\n");
    await writeFile(path.join(repo, "src", "critical.ts"), "export const critical = true;\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await writeConfig(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function proposeValueQualityPolicy(repo: string, errorProne: string[]): Promise<string> {
  const status = await readPromotedValueQualityPolicy(repo);
  const proposed = await proposeMemoryLesson(repo, {
    title: "Value-quality admission policy",
    lesson: "Spend extra quality effort only for the listed routing task types after human review.",
    evidence: ["events.jsonl routing evidence identity"],
    value_quality_policy: {
      version: 1,
      kind: "value_quality_policy",
      source_evidence_hash: status.current_evidence_hash,
      source_event_count: status.current_evidence_event_count,
      error_prone_routing_task_types: errorProne
    }
  });
  if (!proposed.ok) {
    throw new Error(proposed.reason);
  }
  assert.equal(proposed.ok, true);
  return proposed.value.proposal_id;
}

async function runInteractiveReview(repo: string, proposalId: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true });
  Object.defineProperty(output, "isTTY", { value: true });
  output.resume();
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process, "stderr");
  if (stdinDescriptor === undefined || stderrDescriptor === undefined) {
    throw new Error("process stdio descriptors are unavailable");
  }
  Object.defineProperty(process, "stdin", { configurable: true, enumerable: true, get: () => input });
  Object.defineProperty(process, "stderr", { configurable: true, enumerable: true, get: () => output });
  input.end(`approve ${proposalId}\n`);
  try {
    return await reviewMemoryProposalInteractively(repo, proposalId);
  } finally {
    Object.defineProperty(process, "stdin", stdinDescriptor);
    Object.defineProperty(process, "stderr", stderrDescriptor);
  }
}

async function writeConfig(repo: string): Promise<void> {
  await writeFile(path.join(repo, ".hivemind", "config.json"), `${JSON.stringify({
    version: 1,
    stack: "typescript-node",
    repo_root: repo,
    test_command: "node -e \"process.exit(0)\"",
    allowed_globs: ["**/*"],
    forbidden_globs: [],
    low_globs: ["README.md"],
    medium_globs: ["src/medium.ts"],
    high_globs: ["src/high.ts"],
    critical_globs: ["src/critical.ts"],
    resource_policy: {
      run_ceiling: { requests: 50, wall_time_ms: 3_600_000, tokens: 150_000 },
      session_ceiling: { tokens: 500_000 }
    }
  }, null, 2)}\n`);
}

async function writeContract(
  repo: string,
  taskId: string,
  baseCommit: string,
  allowedFile: string,
  routingTaskType: string
): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "tasks", `${taskId}.contract.json`), `${JSON.stringify({
    task_id: taskId,
    title: "Value-quality fixture",
    agent_role: "builder",
    routing_task_type: routingTaskType,
    base_commit: baseCommit,
    acceptance_criterion: "Admission follows the deterministic value policy.",
    allowed_files: [allowedFile],
    allowed_file_intents: { [allowedFile]: "modify" },
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: []
  }, null, 2)}\n`);
}

async function writeProfile(repo: string, tool: string, routingTier: string): Promise<void> {
  const adapters = path.join(repo, ".hivemind", "adapters");
  await mkdir(adapters, { recursive: true });
  await writeFile(path.join(adapters, `${tool}.profile.json`), `${JSON.stringify({
    tool,
    invoke: ["node", "-e", "require('node:fs').writeFileSync('provider-spawned.txt','spawned')"],
    prompt_arg: "stdin",
    verified_on: "2026-07-30",
    context_window: 1024,
    routing_tier: routingTier,
    cost_rank: 1
  }, null, 2)}\n`);
}

async function writeManagerProfile(repo: string, proposal: Record<string, unknown>): Promise<void> {
  const scriptPath = path.join(repo, "manager-fixture.mjs");
  await writeFile(scriptPath, `console.log(${JSON.stringify(JSON.stringify(proposal))});\n`);
  const adapters = path.join(repo, ".hivemind", "adapters");
  await mkdir(adapters, { recursive: true });
  await writeFile(path.join(adapters, "manager.profile.json"), `${JSON.stringify({
    tool: "manager",
    invoke: ["node", scriptPath],
    prompt_arg: "stdin",
    verified_on: "2026-07-30",
    context_window: 1024,
    routing_tier: "strong",
    cost_rank: 1
  }, null, 2)}\n`);
}

async function runCliExpectFailure(
  repo: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: repo,
      env: { ...process.env, ...extraEnv, HIVEMIND_DAEMON_URL: "" },
      windowsHide: true
    });
    assert.fail(`CLI unexpectedly succeeded: ${args.join(" ")}`);
  } catch (error: unknown) {
    if (isExecError(error)) {
      return { stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout.trim();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error: unknown) {
    return !isNodeError(error, "ENOENT");
  }
}

function isExecError(error: unknown): error is Error & { stdout: string; stderr: string } {
  return error instanceof Error && "stdout" in error && "stderr" in error &&
    typeof error.stdout === "string" && typeof error.stderr === "string";
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
