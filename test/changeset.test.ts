import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolveChangeset } from "../src/changeset.js";

const execFileAsync = promisify(execFile);

test("resolveChangeset returns ops for clean add modify and delete patch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "README.md"), "# Fixture\nchanged\n");
    await writeFile(path.join(repo, "added.txt"), "new file\n");
    await rm(path.join(repo, "delete-me.txt"));
    const patchPath = await writePatch(repo, "clean.patch");
    await git(repo, ["reset", "--hard", baseCommit]);
    await rm(path.join(repo, "added.txt"), { force: true });

    const result = await resolveChangeset(repo, baseCommit, patchPath);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(sortOps(result.ops), [
      { path: "added.txt", op: "add" },
      { path: "delete-me.txt", op: "delete" },
      { path: "README.md", op: "modify" }
    ]);
  });
});

test("resolveChangeset disables rename detection so renames are delete plus add", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await git(repo, ["mv", "delete-me.txt", "renamed.txt"]);
    const patchPath = await writePatch(repo, "rename.patch");
    await git(repo, ["reset", "--hard", baseCommit]);

    const result = await resolveChangeset(repo, baseCommit, patchPath);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(sortOps(result.ops), [
      { path: "delete-me.txt", op: "delete" },
      { path: "renamed.txt", op: "add" }
    ]);
  });
});

test("resolveChangeset rejects patches that do not apply to declared base", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "README.md"), "# Fixture\nsecond base\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "second base"]);
    const secondBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\npatch against second base\n");
    const patchPath = await writePatch(repo, "wrong-base.patch");
    await git(repo, ["reset", "--hard", secondBase]);

    const result = await resolveChangeset(repo, baseCommit, patchPath);

    assert.deepEqual(result, { ok: false, reason: "patch does not apply to declared base" });
  });
});

test("resolveChangeset classifies mode-only changes as chmod", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await git(repo, ["update-index", "--chmod=+x", "script.sh"]);
    const patchPath = await writePatch(repo, "mode.patch");
    await git(repo, ["reset", "--hard", baseCommit]);

    const result = await resolveChangeset(repo, baseCommit, patchPath);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.ops, [{ path: "script.sh", op: "chmod" }]);
  });
});

test("resolveChangeset classifies gitattributes changes as gitattr", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, ".gitattributes"), "*.txt text\n");
    const patchPath = await writePatch(repo, "attributes.patch");
    await git(repo, ["reset", "--hard", baseCommit]);
    await rm(path.join(repo, ".gitattributes"), { force: true });

    const result = await resolveChangeset(repo, baseCommit, patchPath);

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.ops, [{ path: ".gitattributes", op: "gitattr" }]);
  });
});

test("resolveChangeset cleans up throwaway worktrees on success and failure", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "README.md"), "# Fixture\ncleanup success\n");
    const patchPath = await writePatch(repo, "cleanup.patch");
    await git(repo, ["reset", "--hard", baseCommit]);

    const success = await resolveChangeset(repo, baseCommit, patchPath);
    const failure = await resolveChangeset(repo, "missing-base-commit", patchPath);

    assert.equal(success.ok, true);
    assert.equal(failure.ok, false);
    assert.doesNotMatch(await gitStdout(repo, ["worktree", "list", "--porcelain"]), /hivemind-changeset-/);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-resolver-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "delete-me.txt"), "delete me\n");
    await writeFile(path.join(repo, "script.sh"), "#!/bin/sh\necho fixture\n");
    await git(repo, ["add", "README.md", "delete-me.txt", "script.sh"]);
    await git(repo, ["commit", "-m", "initial"]);
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

async function writePatch(repo: string, fileName: string): Promise<string> {
  const patchDir = path.join(repo, "patches");
  await mkdir(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, fileName);
  await makeUntrackedFilesDiffable(repo);
  const patch = await gitRawStdout(repo, ["diff", "--no-renames", "HEAD"]);
  await writeFile(patchPath, patch);
  return patchPath;
}

async function makeUntrackedFilesDiffable(repo: string): Promise<void> {
  const result = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repo,
    windowsHide: true
  });
  const files = result.stdout.split("\0").filter((entry) => entry.length > 0);
  if (files.length > 0) {
    await git(repo, ["add", "--intent-to-add", "--", ...files]);
  }
}

function sortOps<T extends { path: string; op: string }>(ops: T[]): T[] {
  return [...ops].sort((left, right) => `${left.path}:${left.op}`.localeCompare(`${right.path}:${right.op}`));
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
  return result.stdout;
}
