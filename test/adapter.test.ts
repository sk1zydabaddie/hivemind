import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { buildAgentPrompt, findDangerousAdapterArgs, invokeAgent, loadAdapterProfile, validateAdapterProfile } from "../src/adapter.js";
import { initProject } from "../src/init.js";
import { createTaskWorktree } from "../src/worktree.js";

const execFileAsync = promisify(execFile);

test("buildAgentPrompt includes the scoped contract fields and diff-only instruction", () => {
  const prompt = buildAgentPrompt({
    task_id: "T-001",
    title: "Add adapter invocation",
    agent_role: "builder",
    base_commit: "abc123",
    allowed_files: ["src/adapter.ts"],
    read_only_files: ["Hivemind_AI_Overview.md"],
    forbidden_files: ["src/gate.ts"],
    allowed_symbols: ["invokeAgent"],
    forbidden_symbols: ["forbiddenCall"],
    must_not_change: ["diff capture"],
    required_tests: ["npm test"],
    patch_requirements: ["no commits"]
  });

  assert.match(prompt, /Submit a diff only/);
  assert.match(prompt, /Title: Add adapter invocation/);
  assert.match(prompt, /Allowed files:\n- src\/adapter\.ts/);
  assert.match(prompt, /Forbidden files:\n- src\/gate\.ts/);
  assert.match(prompt, /Required tests:\n- npm test/);
  assert.match(prompt, /Must not change:\n- diff capture/);
});

test("loadAdapterProfile validates the requested tool profile", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const profile = await loadAdapterProfile(repo, "fake");

    assert.equal(profile.ok, true);
    if (!profile.ok) {
      return;
    }
    assert.equal(profile.profile.tool, "fake");
    assert.deepEqual(profile.profile.invoke, ["node", "fake-agent.mjs"]);
  });
});

test("loadAdapterProfile accepts UTF-8 BOM prefixed JSON", async () => {
  await withTempRepo(async ({ repo }) => {
    await writeProfile(
      repo,
      "fake",
      {
        tool: "fake",
        invoke: ["node", "fake-agent.mjs"],
        prompt_arg: "stdin",
        verified_on: "2026-06-15",
        context_window: 1024
      },
      true
    );

    const profile = await loadAdapterProfile(repo, "fake");

    assert.equal(profile.ok, true);
  });
});

test("validateAdapterProfile rejects missing volatile invocation data", () => {
  assert.deepEqual(validateAdapterProfile({ tool: "fake" }, "fake"), [
    "invoke must be a non-empty array of non-empty strings",
    "prompt_arg must be stdin or arg",
    "verified_on is required",
    "context_window must be a positive integer"
  ]);
});

test("validateAdapterProfile rejects empty invoke entries", () => {
  assert.deepEqual(
    validateAdapterProfile(
      {
        tool: "fake",
        invoke: ["node", ""],
        prompt_arg: "stdin",
        verified_on: "2026-06-15",
        context_window: 1024
      },
      "fake"
    ),
    ["invoke must be a non-empty array of non-empty strings"]
  );
});

test("validateAdapterProfile rejects invalid timeout values", () => {
  assert.deepEqual(
    validateAdapterProfile(
      {
        tool: "fake",
        invoke: ["node", "fake-agent.mjs"],
        prompt_arg: "stdin",
        verified_on: "2026-06-15",
        context_window: 1024,
        timeout_ms: 0
      },
      "fake"
    ),
    ["timeout_ms must be a positive integer when provided"]
  );
});

test("findDangerousAdapterArgs detects provider bypass flags", () => {
  assert.deepEqual(findDangerousAdapterArgs(["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"]), [
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
  assert.deepEqual(findDangerousAdapterArgs(["claude", "--permission-mode", "bypassPermissions"]), ["bypassPermissions"]);
});

test("invokeAgent runs stdin adapter inside the task worktree and writes agent.log", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(
      path.join(worktree.value.worktree, "fake-stdin-agent.mjs"),
      [
        "let prompt = '';",
        "for await (const chunk of process.stdin) prompt += chunk;",
        "console.log(JSON.stringify({ cwd: process.cwd(), sawTitle: prompt.includes('Title: Invoke fake adapter') }));",
        "console.error('stderr from fake stdin adapter');"
      ].join("\n")
    );
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-stdin-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.exitCode, 0);
    assert.equal(result.value.logPath, path.join(worktree.value.worktree, "agent.log"));
    const log = await readFile(result.value.logPath, "utf8");
    assert.match(log, /exit_code: 0/);
    assert.match(log, /"cwd":/);
    assert.match(log, /"sawTitle":true/);
    assert.match(log, /stderr from fake stdin adapter/);
  });
});

test("invokeAgent rejects dangerous adapter flags unless explicitly approved", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(path.join(worktree.value.worktree, "dangerous-agent.mjs"), "console.log('should not run without approval');\n");
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "dangerous-agent.mjs", "--dangerously-skip-permissions"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /dangerous invocation flags/);
    await assertMissing(path.join(worktree.value.worktree, "agent.log"));
  });
});

test("invokeAgent runs dangerous adapter flags with explicit approval", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(path.join(worktree.value.worktree, "approved-dangerous-agent.mjs"), "console.log('approved dangerous adapter run');\n");
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "approved-dangerous-agent.mjs", "--dangerously-skip-permissions"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake", { allowDangerousAdapter: true });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.match(await readFile(result.value.logPath, "utf8"), /approved dangerous adapter run/);
  });
});

test("invokeAgent passes the prompt as an argument when the profile requests arg mode", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(
      path.join(worktree.value.worktree, "fake-arg-agent.mjs"),
      "console.log(process.argv[2].includes('Submit a diff only') ? 'arg prompt ok' : 'arg prompt missing');\n"
    );
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-arg-agent.mjs"],
      prompt_arg: "arg",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.exitCode, 0);
    assert.match(await readFile(result.value.logPath, "utf8"), /arg prompt ok/);
  });
});

test("invokeAgent surfaces non-zero adapter exits without crashing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(path.join(worktree.value.worktree, "fake-fail-agent.mjs"), "console.error('planned exit'); process.exit(7);\n");
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-fail-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.exitCode, 7);
    const log = await readFile(result.value.logPath, "utf8");
    assert.match(log, /exit_code: 7/);
    assert.match(log, /planned exit/);
  });
});

test("invokeAgent times out a wedged adapter and writes agent.log", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    if (!worktree.ok) {
      return;
    }

    await writeFile(
      path.join(worktree.value.worktree, "fake-timeout-agent.mjs"),
      [
        "await import('node:fs/promises').then(({ appendFile }) => appendFile('README.md', 'changed before timeout\\n'));",
        "setInterval(() => undefined, 1000);"
      ].join("\n")
    );
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "fake-timeout-agent.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024,
      timeout_ms: 50
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.exitCode, 124);
    const log = await readFile(result.value.logPath, "utf8");
    assert.match(log, /exit_code: 124/);
    assert.match(log, /timed_out: true/);
    assert.match(log, /adapter timed out after 50ms/);
  });
});

test("invokeAgent returns a scoped error when the profile is missing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);

    const result = await invokeAgent(repo, "T-001", "missing");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /adapter profile not found/);
  });
});

test("invokeAgent returns a scoped error when the worktree is missing", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["node", "unused.mjs"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /worktree not found/);
    await assertMissing(path.join(repo, ".hivemind", "worktrees", "T-001", "agent.log"));
  });
});

test("invokeAgent returns a scoped error when the adapter command cannot start", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);
    await writeProfile(repo, "fake", {
      tool: "fake",
      invoke: ["definitely-missing-hivemind-command"],
      prompt_arg: "stdin",
      verified_on: "2026-06-15",
      context_window: 1024
    });

    const result = await invokeAgent(repo, "T-001", "fake");

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /failed to start adapter "fake"/);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-adapter-test-"));
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
        title: "Invoke fake adapter",
        agent_role: "builder",
        base_commit: baseCommit,
        allowed_files: ["README.md"],
        read_only_files: ["package.json"],
        forbidden_files: ["src/gate.ts"],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: ["gate"],
        required_tests: ["npm test"],
        patch_requirements: ["small diff"]
      },
      null,
      2
    )}\n`
  );
}

async function writeProfile(repo: string, tool: string, profile: unknown, bom = false): Promise<void> {
  const adaptersDir = path.join(repo, ".hivemind", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(path.join(adaptersDir, `${tool}.profile.json`), `${bom ? "\uFEFF" : ""}${JSON.stringify(profile, null, 2)}\n`);
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
