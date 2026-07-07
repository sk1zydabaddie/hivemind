import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { checkpointTask, loadTaskCheckpointResumeState, loadTaskCheckpointSnapshot } from "../src/checkpoint.js";
import { createTaskContract } from "../src/contract.js";
import { writeContextPack } from "../src/context-pack.js";
import { initProject } from "../src/init.js";
import { checkWriteIntent } from "../src/intent.js";
import { releaseLease, requestLeaseForContract } from "../src/lease.js";
import { createTentativePlan, groundTentativePlan, lintTentativePlan } from "../src/plan.js";
import { createTaskWorktree } from "../src/worktree.js";
import { readEvents } from "../src/events.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);

test("checkpointTask captures provider-neutral task state refs plus the partial worktree diff", async () => {
  await withCheckpointFixture(async ({ repo, taskId }) => {
    await writeContextPack(repo, {
      taskId,
      baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]),
      tool: "codex-scout",
      createdAt: "2026-07-07T00:00:00.000Z",
      reads: [],
      stdout: "ORIGINAL_FINDING: README is the only scoped file.",
      stderr: ""
    });
    await writeFile(path.join(repo, ".hivemind", "worktrees", taskId, "README.md"), "# Fixture\n\ncheckpointed partial work\n");

    const checkpoint = await checkpointTask(repo, taskId);

    assert.equal(checkpoint.ok, true);
    if (!checkpoint.ok) {
      return;
    }
    assert.equal(checkpoint.value.snapshot_path, `.hivemind/resource/checkpoints/${taskId}.snapshot.json`);
    assert.equal(checkpoint.value.context_pack_ref, `.hivemind/cache/context-packs/${taskId}.json`);
    assert.equal(checkpoint.value.task_knowledge_ref, `.hivemind/tasks/${taskId}.knowledge.md`);
    assert.equal(checkpoint.value.changed_files, 1);

    const snapshotText = await readFile(path.join(repo, checkpoint.value.snapshot_path), "utf8");
    const snapshot = JSON.parse(snapshotText) as {
      authoritative_refs: {
        contract_ref: { path: string };
        plan_ref: { path: string; task_id: string };
        context_pack_ref: { path: string };
        task_knowledge_ref: { path: string; present: boolean };
      };
      partial_diff: { source: string; diff: string; changed_files: number; diff_hash: string };
    };
    assert.equal(snapshot.authoritative_refs.contract_ref.path, `.hivemind/tasks/${taskId}.contract.json`);
    assert.equal(snapshot.authoritative_refs.plan_ref.path, ".hivemind/plans/S-001.tentative.json");
    assert.equal(snapshot.authoritative_refs.plan_ref.task_id, taskId);
    assert.equal(snapshot.authoritative_refs.context_pack_ref.path, `.hivemind/cache/context-packs/${taskId}.json`);
    assert.equal(snapshot.authoritative_refs.task_knowledge_ref.path, `.hivemind/tasks/${taskId}.knowledge.md`);
    assert.equal(snapshot.authoritative_refs.task_knowledge_ref.present, true);
    assert.equal(snapshot.partial_diff.source, "worktree");
    assert.equal(snapshot.partial_diff.changed_files, 1);
    assert.match(snapshot.partial_diff.diff, /\+checkpointed partial work/);

    assert.doesNotMatch(snapshotText, /codex-scout/);
    assert.doesNotMatch(snapshotText, /ORIGINAL_FINDING/);
    assert.doesNotMatch(snapshotText, /provider_session|session_id|provider_handle|Claude|Codex/);

    const loaded = await loadTaskCheckpointSnapshot(repo, taskId);
    assert.equal(loaded.ok, true);
    const resume = await loadTaskCheckpointResumeState(repo, taskId);
    assert.equal(resume.ok, true);
    if (!resume.ok) {
      return;
    }
    assert.equal(resume.value.context_pack.present, true);
    assert.equal(resume.value.task_knowledge.present, true);
    assert.deepEqual(resume.value.lease_files, ["README.md"]);
    assert.equal(resume.value.task_status.lease.held, true);

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    assert.equal(events.ok && events.value.some((event) => event.type === "task.checkpointed" && event.task_id === taskId), true);
  });
});

test("resume state re-derives lease coverage from the authoritative store instead of trusting the snapshot", async () => {
  await withCheckpointFixture(async ({ repo, taskId }) => {
    await writeFile(path.join(repo, ".hivemind", "worktrees", taskId, "README.md"), "# Fixture\n\npartial work before lease release\n");
    const checkpoint = await checkpointTask(repo, taskId);
    assert.equal(checkpoint.ok, true);

    const released = await releaseLease(repo, taskId);
    assert.equal(released.ok, true);
    const resume = await loadTaskCheckpointResumeState(repo, taskId);

    assert.equal(resume.ok, false);
    if (resume.ok) {
      return;
    }
    assert.match(resume.reason, /active lease does not cover task allowed_files/);
  });
});

test("checkpoint references context and knowledge durability instead of copying bodies that can diverge", async () => {
  await withCheckpointFixture(async ({ repo, taskId, baseCommit }) => {
    await writeContextPack(repo, {
      taskId,
      baseCommit,
      tool: "codex-scout",
      createdAt: "2026-07-07T00:00:00.000Z",
      reads: [],
      stdout: "ORIGINAL_FINDING: first durable context body.",
      stderr: ""
    });
    await writeFile(path.join(repo, ".hivemind", "worktrees", taskId, "README.md"), "# Fixture\n\npartial work\n");
    const checkpoint = await checkpointTask(repo, taskId);
    assert.equal(checkpoint.ok, true);
    const snapshotText = await readFile(path.join(repo, ".hivemind", "resource", "checkpoints", `${taskId}.snapshot.json`), "utf8");
    assert.doesNotMatch(snapshotText, /ORIGINAL_FINDING/);

    const before = await loadTaskCheckpointResumeState(repo, taskId);
    assert.equal(before.ok, true);
    if (!before.ok) {
      return;
    }
    const beforeKnowledgeBytes = before.value.task_knowledge.bytes;
    assert.equal(before.value.context_pack.created_at, "2026-07-07T00:00:00.000Z");

    await writeContextPack(repo, {
      taskId,
      baseCommit,
      tool: "codex-scout",
      createdAt: "2026-07-07T00:01:00.000Z",
      reads: [],
      stdout: "UPDATED_FINDING: current durable context body.",
      stderr: ""
    });
    const after = await loadTaskCheckpointResumeState(repo, taskId);

    assert.equal(after.ok, true);
    if (!after.ok) {
      return;
    }
    assert.equal(after.value.context_pack.created_at, "2026-07-07T00:01:00.000Z");
    assert.ok(after.value.task_knowledge.bytes > beforeKnowledgeBytes);
  });
});

async function withCheckpointFixture(
  run: (input: { repo: string; taskId: string; baseCommit: string }) => Promise<void>
): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-checkpoint-test-"));
  const taskId = "T-CHECKPOINT";
  try {
    await writeFile(path.join(repo, "README.md"), "# Fixture\n\nOnly this file is in scope.\n");
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "hivemind@example.invalid"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo, "S-001");
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await preparePlanAndContract(repo, taskId, baseCommit);

    const lease = await requestLeaseForContract(repo, taskId);
    assert.equal(lease.ok, true);
    const intent = await checkWriteIntent(repo, taskId, {
      task_id: taskId,
      intended_files: ["README.md"],
      intended_symbols: [],
      possible_risks: [],
      will_not_change: []
    });
    assert.equal(intent.ok, true);
    const worktree = await createTaskWorktree(repo, taskId);
    assert.equal(worktree.ok, true);

    await run({ repo, taskId, baseCommit });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function preparePlanAndContract(repo: string, taskId: string, baseCommit: string): Promise<void> {
  const plan = await createTentativePlan(repo, "S-001", {
    tasks: [
      {
        task_id: taskId,
        title: "Checkpoint README task",
        task_type: "deterministic",
        mode: "write",
        agent_role: "builder",
        draft_scope: {
          allowed_files: ["README.md"],
          allowed_file_intents: { "README.md": "modify" },
          read_only_files: [],
          forbidden_files: [],
          must_not_change: []
        },
        depends_on: [],
        parallel_safe: true,
        acceptance_criterion: "README.md includes the checkpoint fixture change.",
        required_tests: ["node -e \"process.exit(0)\""],
        patch_requirements: ["Only edit README.md."]
      }
    ],
    execution_groups: [{ group_id: "G-1", mode: "sequence", task_ids: [taskId] }]
  });
  assert.equal(plan.ok, true);
  const grounded = await groundTentativePlan(repo, "S-001");
  assert.equal(grounded.ok, true);
  const linted = await lintTentativePlan(repo, "S-001");
  assert.equal(linted.ok, true);
  const contract = await createTaskContract(repo, {
    task_id: taskId,
    title: "Checkpoint README task",
    agent_role: "builder",
    base_commit: baseCommit,
    acceptance_criterion: "README.md includes the checkpoint fixture change.",
    allowed_files: ["README.md"],
    allowed_file_intents: { "README.md": "modify" },
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: ["Only edit README.md."]
  });
  assert.equal(contract.ok, true);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
