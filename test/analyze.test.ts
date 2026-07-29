import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { analyzeTask } from "../src/analyze.js";
import { readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("analyzeTask returns accept for a clean in-scope bundle", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await appendFile(repo, "README.md", "accepted change\n");
    await writePatch(repo, "T-001");
    await resetRepo(repo, baseCommit);

    const result = await analyzeTask(repo, "T-001");

    assert.deepEqual(result, {
      ok: true,
      value: {
        verdict: "accept",
        reason: "all changes are within scope"
      }
    });
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.at(-1)?.type, "patch.accepted");
    assert.equal(events.value.at(-1)?.task_id, "T-001");
    assert.equal(events.value.at(-1)?.data.verdict, "accept");
  });
});

test("CLI analyze prints accept JSON and exits zero for an in-scope bundle", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await appendFile(repo, "README.md", "accepted by cli\n");
    await writePatch(repo, "T-001");
    await resetRepo(repo, baseCommit);

    const result = await execFileAsync("node", [cliPath, "analyze", "T-001"], { cwd: repo, windowsHide: true });

    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      verdict: "accept",
      reason: "all changes are within scope"
    });
  });
});

test("CLI analyze prints reject JSON and exits non-zero for an out-of-scope bundle", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await appendFile(repo, "outside.txt", "outside change\n");
    await writePatch(repo, "T-001");
    await resetRepo(repo, baseCommit);

    await assert.rejects(
      execFileAsync("node", [cliPath, "analyze", "T-001"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.equal(String((error as { stderr?: string }).stderr), "");
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as { verdict: string; reason: string };
        assert.equal(parsed.verdict, "reject");
        assert.match(parsed.reason, /outside\.txt/);
        return true;
      }
    );
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.at(-1)?.type, "patch.rejected");
    assert.equal(events.value.at(-1)?.task_id, "T-001");
    assert.equal(events.value.at(-1)?.data.verdict, "reject");
  });
});

test("CLI analyze prints escalate JSON and exits non-zero for an escalated bundle", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["script.sh"]);
    await git(repo, ["update-index", "--chmod=+x", "script.sh"]);
    await writePatch(repo, "T-001");
    await resetRepo(repo, baseCommit);

    await assert.rejects(
      execFileAsync("node", [cliPath, "analyze", "T-001"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.equal(String((error as { stderr?: string }).stderr), "");
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as { verdict: string; reason: string };
        assert.equal(parsed.verdict, "escalate");
        assert.match(parsed.reason, /script\.sh/);
        return true;
      }
    );
  });
});

test("CLI analyze reports a missing diff patch before running the gate", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);

    await assert.rejects(
      execFileAsync("node", [cliPath, "analyze", "T-001"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.equal(String((error as { stdout?: string }).stdout), "");
        assert.equal(
          String((error as { stderr?: string }).stderr).trim(),
          "error: patch not found: .hivemind/patches/T-001/diff.patch"
        );
        return true;
      }
    );
  });
});

test("analyzeTask rejects an empty patch instead of accepting no changes", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-EMPTY", baseCommit, ["README.md"]);
    const patchDir = path.join(repo, ".hivemind", "patches", "T-EMPTY");
    await mkdir(patchDir, { recursive: true });
    await writeFile(path.join(patchDir, "diff.patch"), "");

    const result = await analyzeTask(repo, "T-EMPTY");

    assert.deepEqual(result, {
      ok: true,
      value: {
        verdict: "reject",
        reason: "empty patch: no changes to analyze"
      }
    });
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.at(-1)?.type, "patch.rejected");
    assert.equal(events.value.at(-1)?.task_id, "T-EMPTY");
    assert.equal(events.value.at(-1)?.data.verdict, "reject");
  });
});

test("CLI analyze rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "analyze"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind analyze <id>/);
        return true;
      }
    );
  });
});

test("CLI analyze rejects invalid config before running the gate", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await appendFile(repo, "README.md", "accepted change\n");
    await writePatch(repo, "T-001");
    await resetRepo(repo, baseCommit);
    await writeFile(path.join(repo, ".hivemind", "config.json"), "{\"version\":1,\"stack\":\"typescript-node\"}\n");

    await assert.rejects(
      execFileAsync("node", [cliPath, "analyze", "T-001"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.equal(String((error as { stdout?: string }).stdout), "");
        const stderr = String((error as { stderr?: string }).stderr);
        assert.match(stderr, /repo_root must be a string/);
        assert.match(stderr, /allowed_globs must be an array of strings/);
        return true;
      }
    );
  });
});

test("CLI analyze fails closed when config repo_root points at another repository", async () => {
  const otherRepo = await mkdtemp(path.join(tmpdir(), "hivemind-analyze-other-repo-"));
  try {
    await withTempRepo(async ({ repo, baseCommit }) => {
      await mkdir(path.join(otherRepo, ".hivemind"), { recursive: true });
      await writeContract(repo, "T-001", baseCommit, ["README.md"]);
      await appendFile(repo, "README.md", "accepted change\n");
      await writePatch(repo, "T-001");
      await resetRepo(repo, baseCommit);
      await writeFile(
        path.join(repo, ".hivemind", "config.json"),
        `${JSON.stringify(
          {
            version: 1,
            stack: "typescript-node",
            repo_root: otherRepo,
            test_command: "",
            allowed_globs: [],
            forbidden_globs: ["**/*.lock", "**/package.json", "**/.git/**"]
          },
          null,
          2
        )}\n`
      );

      await assert.rejects(
        execFileAsync("node", [cliPath, "analyze", "T-001"], { cwd: repo, windowsHide: true }),
        (error: unknown) => {
          assert.equal((error as { code?: number }).code, 1);
          assert.equal(String((error as { stdout?: string }).stdout), "");
          assert.match(String((error as { stderr?: string }).stderr), /repo_root must match the current git repository root/);
          return true;
        }
      );
    });
  } finally {
    await rm(otherRepo, { recursive: true, force: true });
  }
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-analyze-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "outside.txt"), "outside\n");
    await writeFile(path.join(repo, "script.sh"), "#!/bin/sh\necho fixture\n");
    await git(repo, ["add", "README.md", "outside.txt", "script.sh"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Analyze submitted patch",
        agent_role: "builder",
        routing_task_type: "other",
        base_commit: baseCommit,
        acceptance_criterion: "Analyze fixture produces one gate verdict.",
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
}

async function writePatch(repo: string, taskId: string): Promise<void> {
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  await writeFile(path.join(patchDir, "diff.patch"), await gitRawStdout(repo, ["diff", "--no-renames", "HEAD"]));
}

async function appendFile(repo: string, repoPath: string, content: string): Promise<void> {
  await writeFile(path.join(repo, repoPath), content, { flag: "a" });
}

async function resetRepo(repo: string, commit: string): Promise<void> {
  await git(repo, ["reset", "--hard", commit]);
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
