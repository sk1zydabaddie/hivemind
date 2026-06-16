import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { requestLease } from "../src/lease.js";
import { runTask } from "../src/run.js";
import { createRatifiedSpec } from "./support/spec.js";

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
    await grantLease(repo, "T-001", ["new-file.txt"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.task_id, "T-001");
    assert.equal(result.value.status, "completed");
    assert.equal(result.value.tool, "fake");
    assert.equal(result.value.tool_exit, 0);
    assert.equal(result.value.changed_files, 1);
    assert.equal(result.value.diff_path, path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
    const diff = await readFile(result.value.diff_path, "utf8");
    assert.match(diff, /diff --git a\/new-file\.txt b\/new-file\.txt/);
    assert.match(diff, /\+created by fake agent/);
    assert.doesNotMatch(diff, /agent\.log/);
  });
});

test("runTask refuses to invoke an agent without a covering active lease", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "should-not-run-without-lease.mjs", [
      "await import('node:fs/promises').then(({ writeFile }) => writeFile('README.md', '# Fixture\\nagent ran without lease\\n'));"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);

    const noLease = await runTask(repo, "T-001", "fake");

    assert.equal(noLease.ok, false);
    if (noLease.ok) {
      return;
    }
    assert.match(noLease.reason, /active lease does not cover task allowed_files/);
    assert.match(noLease.reason, /README\.md is not leased/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-001"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));

    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "extra.ts"), "export const extra = true;\n");
    await git(repo, ["add", "src/extra.ts"]);
    await git(repo, ["commit", "-m", "add extra"]);
    const nextBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeContract(repo, "T-002", nextBase, ["README.md", "src/extra.ts"]);
    await grantLease(repo, "T-002", ["README.md"]);

    const partialLease = await runTask(repo, "T-002", "fake");

    assert.equal(partialLease.ok, false);
    if (partialLease.ok) {
      return;
    }
    assert.match(partialLease.reason, /src\/extra\.ts is not leased/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-002"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-002", "diff.patch"));
  });
});

test("runTask writes an empty diff when the adapter makes no changes", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "noop-agent.mjs", ["console.log('no changes');"]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

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
    await grantLease(repo, "T-001", ["README.md"]);

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

test("runTask captures diff even when the adapter times out", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "timeout-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed before timeout\\n');",
      "setInterval(() => undefined, 1000);"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath, 50);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.tool_exit, 124);
    assert.equal(result.value.changed_files, 1);
    assert.match(await readFile(result.value.diff_path, "utf8"), /\+changed before timeout/);
    const log = await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "agent.log"), "utf8");
    assert.match(log, /timed_out: true/);
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
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await execFileAsync("node", [cliPath, "run", "T-001", "--tool", "fake"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as {
      task_id: string;
      status: string;
      tool: string;
      diff_path: string;
      tool_exit: number;
      changed_files: number;
    };

    assert.equal(result.stderr, "");
    assert.deepEqual(parsed, {
      task_id: "T-001",
      status: "completed",
      tool: "fake",
      diff_path: path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"),
      tool_exit: 0,
      changed_files: 1
    });
    assert.match(await readFile(parsed.diff_path, "utf8"), /\+changed by cli fake agent/);
  });
});

test("CLI run auto-routes to the cheapest Low-tier provider", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const localAgent = await writeAgent(repo, "local-auto-route-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by local auto route\\n');"
    ]);
    const strongAgent = await writeAgent(repo, "strong-auto-route-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by strong auto route\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeConfig(repo, { low_globs: ["README.md"] });
    await writeProfile(repo, "local", localAgent, undefined, false, "local", 1);
    await writeProfile(repo, "strong", strongAgent, undefined, false, "strong", 20);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await execFileAsync("node", [cliPath, "run", "T-001"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { tool: string; diff_path: string };

    assert.equal(result.stderr, "");
    assert.equal(parsed.tool, "local");
    const diff = await readFile(parsed.diff_path, "utf8");
    assert.match(diff, /\+changed by local auto route/);
    assert.doesNotMatch(diff, /strong auto route/);
  });
});

test("runTask rejects explicit below-floor provider before invocation", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "weak-critical-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('src/schema.ts', 'weak provider should not run\\n');"
    ]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "schema.ts"), "export const schema = true;\n");
    await git(repo, ["add", "src/schema.ts"]);
    await git(repo, ["commit", "-m", "add schema"]);
    const nextBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeContract(repo, "T-CRIT", nextBase, ["src/schema.ts"]);
    await writeConfig(repo, { critical_globs: ["src/schema.ts"] });
    await writeProfile(repo, "weak", agentPath, undefined, false, "standard", 1);
    await grantLease(repo, "T-CRIT", ["src/schema.ts"]);

    const result = await runTask(repo, "T-CRIT", "weak");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /below required floor for critical task tier/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-CRIT"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-CRIT", "diff.patch"));
  });
});

test("runTask pauses before invocation when request ceiling is already exhausted", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "request-ceiling-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'request ceiling should block this\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeConfig(repo, { resource_policy: { run_ceiling: { requests: 0 } } });
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /run paused: request ceiling 0/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-001"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
  });
});

test("runTask pauses before invocation when adapter timeout exceeds wall-time ceiling", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "timeout-ceiling-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'timeout ceiling should block this\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeConfig(repo, { resource_policy: { run_ceiling: { wall_time_ms: 1 } } });
    await writeProfile(repo, "fake", agentPath, 50);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /run paused: fake timeout 50ms exceeds wall-time ceiling 1ms/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-001"));
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
  });
});

test("runTask pauses after invocation when actual wall time exceeds the ceiling", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "actual-wall-ceiling-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await new Promise((resolve) => setTimeout(resolve, 25));",
      "await appendFile('README.md', 'changed before wall ceiling pause\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeConfig(repo, { resource_policy: { run_ceiling: { wall_time_ms: 1 } } });
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /run paused: wall-time ceiling 1ms exceeded/);
    assert.match(await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "README.md"), "utf8"), /changed before wall ceiling pause/);
    assert.match(await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "agent.log"), "utf8"), /exit_code: 0/);
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
  });
});

test("CLI run requires explicit approval for dangerous adapter flags", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "dangerous-cli-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by approved dangerous cli fake agent\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath, undefined, true);
    await grantLease(repo, "T-001", ["README.md"]);

    await assert.rejects(
      execFileAsync("node", [cliPath, "run", "T-001", "--tool", "fake"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /dangerous invocation flags/);
        return true;
      }
    );

    const result = await execFileAsync("node", [cliPath, "run", "T-001", "--tool", "fake", "--allow-dangerous-adapter"], {
      cwd: repo,
      windowsHide: true
    });

    const parsed = JSON.parse(result.stdout) as { changed_files: number; tool_exit: number; diff_path: string };
    assert.equal(parsed.tool_exit, 0);
    assert.equal(parsed.changed_files, 1);
    assert.match(await readFile(parsed.diff_path, "utf8"), /\+changed by approved dangerous cli fake agent/);
  });
});

test("CLI run rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "run"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.notEqual(error, null);
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind run <id> \[--tool <tool>\]/);
        return true;
      }
    );
  });
});

test("runTask returns a scoped error when the adapter profile is missing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await grantLease(repo, "T-001", ["README.md"]);

    const result = await runTask(repo, "T-001", "missing");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /adapter profile not found/);
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));
  });
});

test("runTask rejects an existing dirty worktree before invoking the adapter", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "should-not-run-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'agent should not run\\n');"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const firstRun = await runTask(repo, "T-001", "fake");
    assert.equal(firstRun.ok, true);
    if (!firstRun.ok) {
      return;
    }
    const previousPatch = await readFile(firstRun.value.diff_path, "utf8");

    const secondRun = await runTask(repo, "T-001", "fake");

    assert.equal(secondRun.ok, false);
    if (secondRun.ok) {
      return;
    }
    assert.match(secondRun.reason, /existing changes/);
    assert.match(secondRun.reason, /README\.md/);
    assert.equal(await readFile(firstRun.value.diff_path, "utf8"), previousPatch);
  });
});

test("runTask allows rerun when only the Hivemind-owned agent.log remains", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const agentPath = await writeAgent(repo, "noop-rerun-agent.mjs", ["console.log('rerun ok');"]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake", agentPath);
    await grantLease(repo, "T-001", ["README.md"]);

    const firstRun = await runTask(repo, "T-001", "fake");
    assert.equal(firstRun.ok, true);
    if (!firstRun.ok) {
      return;
    }

    const secondRun = await runTask(repo, "T-001", "fake");

    assert.equal(secondRun.ok, true);
    if (!secondRun.ok) {
      return;
    }
    assert.equal(secondRun.value.changed_files, 0);
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

async function writeConfig(repo: string, overrides: Record<string, unknown>): Promise<void> {
  await writeFile(
    path.join(repo, ".hivemind", "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        stack: "typescript-node",
        repo_root: repo,
        test_command: "",
        allowed_globs: [],
        forbidden_globs: [],
        ...overrides
      },
      null,
      2
    )}\n`
  );
}

async function writeProfile(
  repo: string,
  tool: string,
  agentPath: string,
  timeoutMs?: number,
  dangerous = false,
  routingTier = "strong",
  costRank = 10
): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const profile = {
    tool,
    invoke: dangerous ? ["node", agentPath, "--dangerously-skip-permissions"] : ["node", agentPath],
    prompt_arg: "stdin",
    verified_on: "2026-06-15",
    context_window: 1024,
    routing_tier: routingTier,
    cost_rank: costRank,
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs })
  };
  await writeFile(
    path.join(adaptersDir, `${tool}.profile.json`),
    `${JSON.stringify(profile, null, 2)}\n`
  );
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

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}
