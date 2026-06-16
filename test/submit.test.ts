import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { submitTask } from "../src/submit.js";
import { createTaskWorktree } from "../src/worktree.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");
const bundleFiles = [
  "diff.patch",
  "files_changed.json",
  "memory_proposals.json",
  "risks.md",
  "summary.md",
  "symbols_changed.json",
  "tests_run.json"
];

test("submitTask assembles exactly the seven patch bundle files", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }
    await writeFile(path.join(worktree.value.worktree, "README.md"), "# Fixture\nsubmitted change\n");

    const result = await submitTask(repo, "T-001");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.value, {
      task_id: "T-001",
      bundle_path: path.join(repo, ".hivemind", "patches", "T-001"),
      files: [
        "diff.patch",
        "summary.md",
        "files_changed.json",
        "symbols_changed.json",
        "tests_run.json",
        "risks.md",
        "memory_proposals.json"
      ]
    });
    assert.deepEqual(await bundleListing(repo, "T-001"), bundleFiles);
    assert.match(await readBundle(repo, "T-001", "diff.patch"), /\+submitted change/);
    assert.equal(await readBundle(repo, "T-001", "summary.md"), "");
    assert.equal(await readBundle(repo, "T-001", "files_changed.json"), "");
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.at(-1)?.type, "patch.submitted");
    assert.equal(events.value.at(-1)?.task_id, "T-001");
    assert.deepEqual(events.value.at(-1)?.data.files, [
      "diff.patch",
      "summary.md",
      "files_changed.json",
      "symbols_changed.json",
      "tests_run.json",
      "risks.md",
      "memory_proposals.json"
    ]);
  });
});

test("submitTask copies advisory files from the worktree and creates missing advisory files empty", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }
    await writeFile(path.join(worktree.value.worktree, "README.md"), "# Fixture\nadvisory change\n");
    await writeFile(path.join(worktree.value.worktree, "summary.md"), "Implemented advisory summary.\n");
    await writeFile(path.join(worktree.value.worktree, "tests_run.json"), "[\"npm test\"]\n");

    const result = await submitTask(repo, "T-001");

    assert.equal(result.ok, true);
    assert.equal(await readBundle(repo, "T-001", "summary.md"), "Implemented advisory summary.\n");
    assert.equal(await readBundle(repo, "T-001", "tests_run.json"), "[\"npm test\"]\n");
    assert.equal(await readBundle(repo, "T-001", "risks.md"), "");
    assert.equal(await readBundle(repo, "T-001", "memory_proposals.json"), "");
  });
});

test("submitTask captures untracked source files but excludes bundle metadata from diff.patch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["new-file.txt"]);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }
    await writeFile(path.join(worktree.value.worktree, "new-file.txt"), "new source file\n");
    await writeFile(path.join(worktree.value.worktree, "summary.md"), "This should be copied, not diffed.\n");

    const result = await submitTask(repo, "T-001");

    assert.equal(result.ok, true);
    const diff = await readBundle(repo, "T-001", "diff.patch");
    assert.match(diff, /diff --git a\/new-file\.txt b\/new-file\.txt/);
    assert.doesNotMatch(diff, /summary\.md/);
    assert.equal(await readBundle(repo, "T-001", "summary.md"), "This should be copied, not diffed.\n");
  });
});

test("submitTask removes stale extra entries from an existing bundle directory", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }
    await writeFile(path.join(worktree.value.worktree, "README.md"), "# Fixture\nstale cleanup change\n");
    const patchDir = path.join(repo, ".hivemind", "patches", "T-001");
    await mkdir(path.join(patchDir, "stale-dir"), { recursive: true });
    await writeFile(path.join(patchDir, "old.txt"), "stale\n");

    const result = await submitTask(repo, "T-001");

    assert.equal(result.ok, true);
    assert.deepEqual(await bundleListing(repo, "T-001"), bundleFiles);
    await assertMissing(path.join(patchDir, "old.txt"));
    await assertMissing(path.join(patchDir, "stale-dir"));
  });
});

test("submitTask fails closed when the task worktree is missing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);

    const result = await submitTask(repo, "T-001");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /worktree not found: \.hivemind\/worktrees\/T-001/);
  });
});

test("submitTask rejects advisory bundle entries that are directories in the worktree", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }
    await mkdir(path.join(worktree.value.worktree, "summary.md"));

    const result = await submitTask(repo, "T-001");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /advisory file summary\.md is not a file in worktree/);
  });
});

test("CLI submit prints stable JSON", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }
    await writeFile(path.join(worktree.value.worktree, "README.md"), "# Fixture\ncli submit change\n");

    const result = await execFileAsync("node", [cliPath, "submit", "T-001"], {
      cwd: repo,
      windowsHide: true
    });

    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      task_id: "T-001",
      bundle_path: path.join(repo, ".hivemind", "patches", "T-001"),
      files: [
        "diff.patch",
        "summary.md",
        "files_changed.json",
        "symbols_changed.json",
        "tests_run.json",
        "risks.md",
        "memory_proposals.json"
      ]
    });
    assert.match(await readBundle(repo, "T-001", "diff.patch"), /\+cli submit change/);
  });
});

test("CLI submit rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "submit"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind submit <id>/);
        return true;
      }
    );
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-submit-test-"));
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

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        base_commit: baseCommit,
        allowed_files: allowedFiles
      },
      null,
      2
    )}\n`
  );
}

async function bundleListing(repo: string, taskId: string): Promise<string[]> {
  return (await readdir(path.join(repo, ".hivemind", "patches", taskId))).sort();
}

async function readBundle(repo: string, taskId: string, fileName: string): Promise<string> {
  return readFile(path.join(repo, ".hivemind", "patches", taskId, fileName), "utf8");
}

async function restoreTrackedWrites(worktreePath: string): Promise<void> {
  const files = (await gitStdout(worktreePath, ["ls-files", "-z"])).split("\0").filter((entry) => entry.length > 0);
  for (const file of files) {
    await chmod(path.join(worktreePath, file), 0o644);
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}
