import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createTaskContract } from "../src/contract.js";
import { initProject } from "../src/init.js";
import { readEvents } from "../src/events.js";
import { requestLease } from "../src/lease.js";
import { createTaskWorktree, removeTaskWorktree } from "../src/worktree.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("worktree create creates task branch at contract base commit", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);

    const result = await createTaskWorktree(repo, "T-001");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.branch, "hivemind/T-001");
    assert.equal(result.value.worktree, path.join(repo, ".hivemind", "worktrees", "T-001"));
    await assertExists(result.value.worktree);
    assert.equal(await gitStdout(result.value.worktree, ["branch", "--show-current"]), "hivemind/T-001");
    assert.equal(await gitStdout(result.value.worktree, ["rev-parse", "HEAD"]), baseCommit);
  });
});

test("worktree create does not duplicate task.created after explicit task creation", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const plannedContract = fullContract("T-001", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, plannedContract);
    const contract = await createTaskContract(repo, plannedContract);
    assert.equal(contract.ok, true);

    const created = await createTaskWorktree(repo, "T-001");

    assert.equal(created.ok, true);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.filter((event) => event.type === "task.created" && event.task_id === "T-001").length, 1);
  });
});

test("worktree create keeps leased files writable and marks non-leased files read-only", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md", "src/nonleased.ts"]);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await createTaskWorktree(repo, "T-001");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    await assertOwnerWritable(path.join(result.value.worktree, "README.md"));
    await assertOwnerReadOnly(path.join(result.value.worktree, "src", "nonleased.ts"));
  });
});

test("worktree create is idempotent when worktree already exists", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    await grantLease(repo, "T-001", ["README.md"]);

    const first = await createTaskWorktree(repo, "T-001");
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    await chmod(path.join(first.value.worktree, "src", "nonleased.ts"), 0o644);
    const second = await createTaskWorktree(repo, "T-001");

    assert.deepEqual(second, first);
    await assertOwnerReadOnly(path.join(first.value.worktree, "src", "nonleased.ts"));
  });
});

test("worktree create fails closed when an existing worktree is stale", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);

    const first = await createTaskWorktree(repo, "T-001");
    assert.equal(first.ok, true);

    await writeFile(path.join(repo, "SECOND.md"), "second commit\n");
    await git(repo, ["add", "SECOND.md"]);
    await git(repo, ["commit", "-m", "second"]);
    const nextBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeContract(repo, "T-001", nextBase);

    const second = await createTaskWorktree(repo, "T-001");

    assert.equal(second.ok, false);
    if (second.ok) {
      return;
    }
    assert.match(second.reason, /existing worktree \.hivemind\/worktrees\/T-001 is at/);
    assert.match(second.reason, /expected verified authoring base/);
  });
});

test("worktree create rejects unsafe task ids before constructing paths", async () => {
  await withTempRepo(async ({ repo }) => {
    const result = await createTaskWorktree(repo, "../evil");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /invalid task id "\.\.\/evil"/);
    await assertMissing(path.join(repo, ".hivemind", "evil"));
  });
});

test("worktree remove cleans up worktree and branch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const created = await createTaskWorktree(repo, "T-001");
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }

    const removed = await removeTaskWorktree(repo, "T-001");

    assert.deepEqual(removed, created);
    await assertMissing(created.value.worktree);
    const branches = await gitStdout(repo, ["branch", "--list", "hivemind/T-001"]);
    assert.equal(branches, "");
  });
});

test("worktree remove succeeds after read-only prep", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    await grantLease(repo, "T-001", ["README.md"]);
    const created = await createTaskWorktree(repo, "T-001");
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    await assertOwnerReadOnly(path.join(created.value.worktree, "src", "nonleased.ts"));

    const removed = await removeTaskWorktree(repo, "T-001");

    assert.deepEqual(removed, created);
    await assertMissing(created.value.worktree);
  });
});

test("worktree create rejects invalid contracts without creating a worktree", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeContract(repo, "T-001", "");

    const result = await createTaskWorktree(repo, "T-001");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /base_commit is required/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-001"));
  });
});

test("worktree create ignores unleased glob allowed_files during read-only prep", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["src/*.ts"]);

    const result = await createTaskWorktree(repo, "T-001");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    await assertOwnerReadOnly(path.join(result.value.worktree, "README.md"));
    await assertOwnerReadOnly(path.join(result.value.worktree, "src", "nonleased.ts"));
  });
});

test("CLI worktree create and remove print stable JSON", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);

    const created = await execFileAsync("node", [cliPath, "worktree", "T-001"], {
      cwd: repo,
      windowsHide: true
    });
    const createJson = JSON.parse(created.stdout) as { worktree: string; branch: string };
    assert.equal(createJson.worktree, path.join(repo, ".hivemind", "worktrees", "T-001"));
    assert.equal(createJson.branch, "hivemind/T-001");
    assert.equal(created.stderr, "");

    const removed = await execFileAsync("node", [cliPath, "worktree", "T-001", "--remove"], {
      cwd: repo,
      windowsHide: true
    });
    assert.deepEqual(JSON.parse(removed.stdout), createJson);
    assert.equal(removed.stderr, "");
    await assertMissing(createJson.worktree);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-worktree-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "nonleased.ts"), "export const nonleased = true;\n");
    await git(repo, ["add", "README.md", "src/nonleased.ts"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

async function cleanupTempRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const worktreePath = line.slice("worktree ".length);
      if (worktreePath !== repo) {
        await restoreTrackedWrites(worktreePath);
        await git(repo, ["worktree", "remove", "--force", worktreePath]);
      }
    }
  } catch {
    // Best-effort cleanup before deleting the temp repo.
  }
  await rm(repo, { recursive: true, force: true });
}

async function writeContract(
  repo: string,
  taskId: string,
  baseCommit: string,
  allowedFiles: string[] = ["README.md"]
): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Worktree fixture",
        routing_task_type: "other",
        base_commit: baseCommit,
        acceptance_criterion: "Worktree fixture creates one worktree.",
        allowed_files: allowedFiles,
        required_tests: ["node -e \"process.exit(0)\""]
      },
      null,
      2
    )}\n`
  );
}

function fullContract(taskId: string, baseCommit: string, allowedFiles: string[]): Record<string, unknown> {
  return {
    task_id: taskId,
    title: "Worktree fixture",
    agent_role: "builder",
    routing_task_type: "other",
    base_commit: baseCommit,
    acceptance_criterion: "Worktree fixture creates one worktree.",
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

async function prepareLintedPlan(repo: string, contract: Record<string, unknown>): Promise<void> {
  const planPath = path.join(repo, `${String(contract.task_id)}-plan.json`);
  await writeFile(
    planPath,
    `${JSON.stringify(
      {
        tasks: [
          {
            task_id: contract.task_id,
            title: contract.title,
            task_type: "deterministic",
            routing_task_type: contract.routing_task_type,
            mode: "write",
            agent_role: contract.agent_role,
            draft_scope: {
              allowed_files: contract.allowed_files,
              read_only_files: [],
              forbidden_files: [],
              must_not_change: contract.must_not_change
            },
            depends_on: [],
            parallel_safe: true,
            acceptance_criterion: contract.acceptance_criterion,
            required_tests: contract.required_tests,
            patch_requirements: contract.patch_requirements
          }
        ],
        execution_groups: [{ group_id: "G-1", mode: "parallel", task_ids: [contract.task_id] }]
      },
      null,
      2
    )}\n`
  );
  await execFileAsync("node", [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
  await execFileAsync("node", [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
  await execFileAsync("node", [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
  const review = JSON.parse((await execFileAsync("node", [cliPath, "plan", "S-001", "--review"], { cwd: repo, windowsHide: true })).stdout) as { plan_hash: string };
  await execFileAsync("node", [cliPath, "plan", "S-001", "--ratify", review.plan_hash], { cwd: repo, windowsHide: true });
}

async function restoreTrackedWrites(worktreePath: string): Promise<void> {
  const files = (await gitStdout(worktreePath, ["ls-files", "-z"])).split("\0").filter((entry) => entry.length > 0);
  for (const file of files) {
    await chmod(path.join(worktreePath, file), 0o644);
  }
}

async function grantLease(repo: string, taskId: string, files: string[]): Promise<void> {
  const result = await requestLease(repo, taskId, files);
  assert.equal(result.ok, true);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function assertExists(filePath: string): Promise<void> {
  await stat(filePath);
}

async function assertOwnerWritable(filePath: string): Promise<void> {
  const fileStat = await stat(filePath);
  assert.notEqual(fileStat.mode & 0o200, 0);
}

async function assertOwnerReadOnly(filePath: string): Promise<void> {
  const fileStat = await stat(filePath);
  assert.equal(fileStat.mode & 0o200, 0);
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}
