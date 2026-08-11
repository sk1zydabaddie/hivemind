import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { loadAndValidateContract, type TaskContract } from "../src/contract.js";
import { captureWorktreeDiff } from "../src/diff-capture.js";
import { appendEvent } from "../src/events.js";
import { runGate } from "../src/gate.js";
import { initProject } from "../src/init.js";
import { requestLease } from "../src/lease.js";
import { assembleAgentPrompt } from "../src/prompt-cache.js";
import { resolveTaskAuthoringBase } from "../src/task-authoring-base.js";
import { captureVerificationInputs, writeVerificationSet } from "../src/verification-set.js";
import { createTaskWorktree } from "../src/worktree.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("dependent task authors against the exact verified predecessor tree while capturing only its own diff", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-authoring-base-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "dependency.ts"), "export const dependency = 'old';\n");
    await writeFile(path.join(repo, "src", "consumer.ts"), "export const consumer = 'seed';\n");
    await writeFile(path.join(repo, "package.json"), '{"scripts":{"test":"node -e \\"process.exit(0)\\""}}\n');
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "seed"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    const first = contract("T-001", baseCommit, ["src/dependency.ts"], [], "Predecessor changes dependency behavior.");
    const second = contract("T-002", baseCommit, ["src/consumer.ts"], ["src/dependency.ts"], "Dependent consumes the verified behavior.");
    await prepareRatifiedPlan(repo, first, second);
    await writeContract(repo, first);

    const verificationTree = await createVerifiedPredecessor(repo, baseCommit, first);
    const inputs = await captureVerificationInputs(repo, ["T-001"]);
    assert.equal(inputs.ok, true);
    if (!inputs.ok) return;
    const stored = await writeVerificationSet(repo, {
      base_branch: "master",
      base_commit: baseCommit,
      task_ids: ["T-001"],
      inputs: inputs.value.inputs,
      changed_files: ["src/dependency.ts"],
      result_tree: verificationTree,
      config_path: ".hivemind/config.json",
      config_sha256: inputs.value.config_sha256,
      verification: { audit: {}, checks: {}, runtime_coverage: {}, tests: "pass" },
      oracle: {
        coverage_configured: false,
        binding: false,
        task_tier: "medium",
        status: "unconfigured",
        decision: "proceed",
        diagnostic: "fixture verification",
        uncovered_changed_lines: [],
        uncovered_impact_files: [],
        unknown_files: [],
        unknown_reasons: [],
        recommendation: null,
        automatic_generation_launched: false
      }
    });
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    assert.equal((await appendEvent(repo, {
      type: "integration.passed",
      task_id: null,
      data: {
        applied: ["T-001"],
        tests: "pass",
        verification_id: stored.value.manifest.verification_id,
        verification_manifest_path: stored.value.manifest_path,
        verification_manifest_sha256: stored.value.manifest_sha256
      }
    })).ok, true);

    await writeContract(repo, second);
    assert.equal((await requestLease(repo, "T-002", ["src/consumer.ts"])).ok, true);
    const created = await createTaskWorktree(repo, "T-002");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const loaded = await loadAndValidateContract(repo, "T-002");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const authoringBase = await resolveTaskAuthoringBase(repo, loaded.contract);
    assert.equal(authoringBase.ok, true);
    if (!authoringBase.ok) return;

    assert.equal(await gitStdout(created.value.worktree, ["rev-parse", "HEAD"]), authoringBase.value.commit);
    assert.equal(await gitStdout(created.value.worktree, ["rev-parse", "HEAD^{tree}"]), verificationTree);
    assert.equal(await gitStdout(created.value.worktree, ["rev-parse", "HEAD^1"]), baseCommit);
    assert.equal((await readFile(path.join(created.value.worktree, "src", "dependency.ts"), "utf8")).replaceAll("\r\n", "\n"), "export const dependency = 'verified';\n");
    const prompt = await assembleAgentPrompt(repo, loaded.contract);
    assert.equal(prompt.ok, true);
    if (!prompt.ok) return;
    assert.match(prompt.value.full_prompt, /dependency = 'verified'/);
    assert.doesNotMatch(prompt.value.full_prompt, /dependency = 'old'/);

    await writeFile(path.join(created.value.worktree, "src", "consumer.ts"), "export { dependency as consumer } from './dependency.js';\n");
    const captured = await captureWorktreeDiff(created.value.worktree, authoringBase.value.commit);
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    assert.equal(captured.value.changedFiles, 1);
    assert.match(captured.value.diff, /src\/consumer\.ts/);
    assert.doesNotMatch(captured.value.diff, /src\/dependency\.ts/);
    const patchPath = path.join(repo, "dependent.patch");
    await writeFile(patchPath, captured.value.diff);
    const config = await loadConfig(repo);
    assert.equal(config.ok, true);
    if (!config.ok) return;
    const gated = await runGate(authoringBase.value.commit, patchPath, loaded.contract, config.config);
    assert.equal(gated.verdict, "accept");
    assert.equal(gated.reason, "all changes are within scope");

    await writeFile(
      path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"),
      `${await readFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), "utf8")}\n# changed after verification\n`
    );
    const stale = await resolveTaskAuthoringBase(repo, loaded.contract);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.match(stale.reason, /verified-then-stale: patch hash changed for T-001/);
  } finally {
    await cleanup(repo);
  }
});

async function createVerifiedPredecessor(repo: string, baseCommit: string, first: TaskContract): Promise<string> {
  const checkout = path.join(repo, ".verified-predecessor");
  await git(repo, ["worktree", "add", "--detach", checkout, baseCommit]);
  await writeFile(path.join(checkout, "src", "dependency.ts"), "export const dependency = 'verified';\n");
  const patch = await gitStdout(checkout, ["diff", baseCommit]);
  await mkdir(path.join(repo, ".hivemind", "patches", first.task_id), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "patches", first.task_id, "diff.patch"), patch);
  await git(checkout, ["add", "src/dependency.ts"]);
  const tree = await gitStdout(checkout, ["write-tree"]);
  await git(repo, ["worktree", "remove", "--force", checkout]);
  return tree;
}

async function prepareRatifiedPlan(repo: string, first: TaskContract, second: TaskContract): Promise<void> {
  const proposal = {
    tasks: [planTask(first, []), planTask(second, [first.task_id])],
    execution_groups: [
      { group_id: "G-1", mode: "sequence", task_ids: [first.task_id, second.task_id] }
    ]
  };
  const proposalPath = path.join(repo, "plan.json");
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
  for (const args of [["plan", "S-001", "--propose", proposalPath], ["plan", "S-001", "--ground"], ["plan", "S-001", "--lint"]]) {
    await execFileAsync("node", [cliPath, ...args], { cwd: repo, windowsHide: true });
  }
  const review = JSON.parse((await execFileAsync("node", [cliPath, "plan", "S-001", "--review"], { cwd: repo, windowsHide: true })).stdout) as { plan_hash: string };
  await execFileAsync("node", [cliPath, "plan", "S-001", "--ratify", review.plan_hash], { cwd: repo, windowsHide: true });
}

function planTask(value: TaskContract, dependsOn: string[]) {
  return {
    task_id: value.task_id,
    title: value.title,
    task_type: "deterministic",
    routing_task_type: value.routing_task_type,
    mode: "write",
    agent_role: value.agent_role,
    draft_scope: {
      allowed_files: value.allowed_files,
      read_only_files: value.read_only_files,
      forbidden_files: value.forbidden_files,
      must_not_change: value.must_not_change
    },
    depends_on: dependsOn,
    parallel_safe: false,
    acceptance_criterion: value.acceptance_criterion,
    required_tests: value.required_tests,
    patch_requirements: value.patch_requirements
  };
}

function contract(taskId: string, baseCommit: string, allowed: string[], readOnly: string[], acceptance: string): TaskContract {
  return {
    task_id: taskId,
    title: taskId === "T-001" ? "Build dependency" : "Use dependency",
    agent_role: "builder",
    routing_task_type: "data_model",
    base_commit: baseCommit,
    acceptance_criterion: acceptance,
    allowed_files: allowed,
    allowed_file_intents: Object.fromEntries(allowed.map((entry) => [entry, "modify" as const])),
    read_only_files: readOnly,
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: ["Keep the task scoped."]
  };
}

async function writeContract(repo: string, value: TaskContract): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "tasks", `${value.task_id}.contract.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function cleanup(repo: string): Promise<void> {
  try {
    const list = await gitStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of list.split(/\r?\n/u)) {
      if (!line.startsWith("worktree ")) continue;
      const checkout = line.slice("worktree ".length);
      if (path.resolve(checkout) !== path.resolve(repo)) await git(repo, ["worktree", "remove", "--force", checkout]);
    }
  } catch {
    // Best-effort fixture cleanup.
  }
  await rm(repo, { recursive: true, force: true, maxRetries: 3 });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 })).stdout.trim();
}
