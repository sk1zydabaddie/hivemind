import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { createTaskWorktree, removeTaskWorktree } from "../src/worktree.js";

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

test("worktree create is idempotent when worktree already exists", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);

    const first = await createTaskWorktree(repo, "T-001");
    const second = await createTaskWorktree(repo, "T-001");

    assert.deepEqual(second, first);
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
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
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
        await git(repo, ["worktree", "remove", "--force", worktreePath]);
      }
    }
  } catch {
    // Best-effort cleanup before deleting the temp repo.
  }
  await rm(repo, { recursive: true, force: true });
}

async function writeContract(repo: string, taskId: string, baseCommit: string): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        base_commit: baseCommit,
        allowed_files: ["README.md"]
      },
      null,
      2
    )}\n`
  );
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

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}
