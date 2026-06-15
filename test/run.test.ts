import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { runTask } from "../src/run.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("runTask captures an untracked worker-created file in diff.patch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "create-file-agent.mjs", [
      "await import('node:fs/promises').then(({ writeFile }) => writeFile('new-file.txt', 'created by fake agent\\n'));"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["new-file.txt"]);
    await writeProfile(repo, "fake", agentPath);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.task_id, "T-001");
    assert.equal(result.value.tool_exit, 0);
    assert.equal(result.value.changed_files, 1);
    assert.equal(result.value.diff_path, path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
    const diff = await readFile(result.value.diff_path, "utf8");
    assert.match(diff, /diff --git a\/new-file\.txt b\/new-file\.txt/);
    assert.match(diff, /\+created by fake agent/);
    assert.doesNotMatch(diff, /agent\.log/);
  });
});

test("runTask writes an empty diff when the adapter makes no changes", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "noop-agent.mjs", ["console.log('no changes');"]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.tool_exit, 0);
    assert.equal(result.value.changed_files, 0);
    assert.equal(await readFile(result.value.diff_path, "utf8"), "");
  });
});

test("runTask captures diff even when the adapter exits non-zero", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "nonzero-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed before nonzero exit\\n');",
      "process.exit(7);"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.tool_exit, 7);
    assert.equal(result.value.changed_files, 1);
    assert.match(await readFile(result.value.diff_path, "utf8"), /\+changed before nonzero exit/);
  });
});

test("CLI run prints stable JSON", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "cli-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by cli fake agent\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);

    const result = await execFileAsync("node", [cliPath, "run", "T-001", "--tool", "fake"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { task_id: string; diff_path: string; tool_exit: number; changed_files: number };

    assert.equal(result.stderr, "");
    assert.deepEqual(parsed, {
      task_id: "T-001",
      diff_path: path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"),
      tool_exit: 0,
      changed_files: 1
    });
    assert.match(await readFile(parsed.diff_path, "utf8"), /\+changed by cli fake agent/);
  });
});

test("CLI run rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "run", "T-001"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.notEqual(error, null);
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind run <id> --tool <tool>/);
        return true;
      }
    );
  });
});

test("runTask returns a scoped error when the adapter profile is missing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);

    const result = await runTask(repo, "T-001", "missing");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /adapter profile not found/);
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-run-test-"));
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

async function writeAgent(repo: string, fileName: string, lines: string[]): Promise<string> {
  const agentsDir = path.join(repo, "fake-agents");
  await mkdir(agentsDir, { recursive: true });
  const agentPath = path.join(agentsDir, fileName);
  await writeFile(agentPath, `${lines.join("\n")}\n`);
  return agentPath;
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Run fake adapter and capture diff",
        agent_role: "builder",
        base_commit: baseCommit,
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: ["src/gate.ts"],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: ["scope gate", "coordination state"],
        required_tests: ["node -e \"console.log('fake acceptance')\""],
        patch_requirements: ["submit diff only"]
      },
      null,
      2
    )}\n`
  );
}

async function writeProfile(repo: string, tool: string, agentPath: string): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-06-15",
        context_window: 1024
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

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}
