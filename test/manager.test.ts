import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { executeManagerAction, startManagerSession } from "../src/manager.js";
import { createSpec } from "../src/spec.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
}

test("manager session shell records a user message against the active ratified spec", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    const result = await startManagerSession(repo, "Build the next safe slice");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.spec_id, "S-001");
    assert.equal(result.value.proposed_action.type, "await_planning_loop");
    assert.equal(result.value.proposed_action.requires, "M5.4");

    const session = JSON.parse(await readFile(path.join(repo, result.value.session_path), "utf8")) as {
      version: number;
      spec_id: string;
      working_set: { spec: { title: string; status: string }; status: { task_count: number; active_lease_count: number } };
      turns: Array<{ role: string; content: string }>;
      proposed_action: { type: string };
    };
    assert.equal(session.version, 1);
    assert.equal(session.spec_id, "S-001");
    assert.equal(session.working_set.spec.title, "Test spec");
    assert.equal(session.working_set.spec.status, "ratified");
    assert.equal(session.working_set.status.task_count, 0);
    assert.equal(session.working_set.status.active_lease_count, 0);
    assert.deepEqual(session.turns.map((turn) => turn.role), ["user", "manager"]);
    assert.equal(session.turns[0].content, "Build the next safe slice");
    assert.equal(session.proposed_action.type, "await_planning_loop");
  });
});

test("manager CLI writes only the session artifact and does not create task execution state", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    const result = await execFileAsync(process.execPath, [cliPath, "manager", "--message", "Start from the ratified spec"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { session_path: string; proposed_action: { type: string } };

    assert.equal(parsed.proposed_action.type, "await_planning_loop");
    await assertExists(path.join(repo, parsed.session_path));
    assert.deepEqual(await contractFiles(repo), []);
    assert.equal(await exists(path.join(repo, ".hivemind", "leases", "active.json")), false);
    assert.deepEqual(await childNames(path.join(repo, ".hivemind", "patches")), []);
    assert.equal(await exists(path.join(repo, ".hivemind", "integration", "status.json")), false);
  });
});

test("manager chat fails closed for draft or missing specs and records no session", async () => {
  await withTempRepo(async ({ repo }) => {
    const draft = await createSpec(repo, "S-DRAFT", "Draft manager gate");
    assert.equal(draft.ok, true);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Please start"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /active spec S-DRAFT is draft/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });

  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "Please start"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /no active spec/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager CLI rejects empty messages before writing a session", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--message", "   "], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /manager message must not be empty/);
        return true;
      }
    );
    assert.equal(await exists(path.join(repo, ".hivemind", "orchestrator", "sessions")), false);
  });
});

test("manager executor records a read-only status action in the session", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const sessionResult = await startManagerSession(repo, "Check status");
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const actionPath = path.join(repo, "status-action.json");
    await writeFile(actionPath, `${JSON.stringify({ type: "get_status" }, null, 2)}\n`);
    const result = await execFileAsync(process.execPath, [cliPath, "manager", "--session", sessionResult.value.session_id, "--action", actionPath], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { action_type: string; result: { ok: boolean; value: { tasks: unknown[] } } };

    assert.equal(parsed.action_type, "get_status");
    assert.equal(parsed.result.ok, true);
    assert.deepEqual(parsed.result.value.tasks, []);
    const session = await readSession(repo, sessionResult.value.session_path);
    assert.equal(session.executed_actions.length, 1);
    assert.equal(session.executed_actions[0].type, "get_status");
    assert.equal(session.executed_actions[0].result.ok, true);
  });
});

test("manager executor drives deterministic task actions through shadow integration with no paid provider", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    const agentPath = await writeAgent(repo, "manager-fake-agent.mjs", [
      "const { appendFile } = await import('node:fs/promises');",
      "await appendFile('README.md', 'changed by manager executor\\n');"
    ]);
    await writeProfile(repo, "fake", agentPath);
    const sessionResult = await startManagerSession(repo, "Run the deterministic executor");
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }
    const sessionId = sessionResult.value.session_id;

    const contract = {
      task_id: "T-001",
      title: "Manager executor fixture",
      agent_role: "builder",
      base_commit: baseCommit,
      allowed_files: ["README.md"],
      read_only_files: [],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["node -e \"process.exit(0)\""],
      patch_requirements: ["submit diff only"]
    };
    const actions = [
      { type: "create_task_contract", contract },
      { type: "request_lease", task_id: "T-001" },
      { type: "create_worktree", task_id: "T-001" },
      { type: "run_worker", task_id: "T-001", tool: "fake" },
      { type: "submit_patch", task_id: "T-001" },
      { type: "analyze_patch", task_id: "T-001" },
      { type: "enqueue_patch", task_id: "T-001" },
      { type: "integrate_shadow" }
    ] as const;

    for (const action of actions) {
      const result = await executeManagerAction(repo, sessionId, action);
      assert.equal(result.ok, true);
      if (!result.ok) {
        return;
      }
      assert.equal(result.value.result.ok, true, `${action.type} failed`);
    }

    const diff = await readFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), "utf8");
    assert.match(diff, /\+changed by manager executor/);
    const queue = JSON.parse(await readFile(path.join(repo, ".hivemind", "integration", "queue.json"), "utf8")) as Array<{ task_id: string }>;
    assert.deepEqual(queue, [{ task_id: "T-001" }]);
    const status = JSON.parse(await readFile(path.join(repo, ".hivemind", "integration", "status.json"), "utf8")) as { applied: string[]; tests: string };
    assert.deepEqual(status.applied, ["T-001"]);
    assert.equal(status.tests, "pass");

    const session = await readSession(repo, sessionResult.value.session_path);
    assert.deepEqual(session.executed_actions.map((action) => action.type), actions.map((action) => action.type));
    assert.equal(session.executed_actions.every((action) => action.result.ok), true);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.some((event) => event.type === "integration.queued" && event.task_id === "T-001"), true);
    assert.equal(events.value.at(-1)?.type, "integration.passed");
  });
});

test("manager executor records deterministic failures but fails the CLI closed", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    const sessionResult = await startManagerSession(repo, "Try to run without a lease");
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }
    const actionPath = path.join(repo, "run-without-lease.json");
    await writeFile(actionPath, `${JSON.stringify({ type: "run_worker", task_id: "T-001", tool: "missing" }, null, 2)}\n`);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--session", sessionResult.value.session_id, "--action", actionPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as { result: { ok: boolean; reason: string } };
        assert.equal(parsed.result.ok, false);
        assert.match(parsed.result.reason, /active lease does not cover task allowed_files/);
        return true;
      }
    );

    const session = await readSession(repo, sessionResult.value.session_path);
    assert.equal(session.executed_actions.length, 1);
    const recorded = session.executed_actions[0];
    assert.equal(recorded.result.ok, false);
    assert.match(recorded.result.reason ?? "", /active lease does not cover task allowed_files/);
  });
});

test("manager executor rejects malformed actions before mutating the session", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const sessionResult = await startManagerSession(repo, "Reject bad action");
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }
    const actionPath = path.join(repo, "bad-action.json");
    await writeFile(actionPath, `${JSON.stringify({ type: "unknown_action" }, null, 2)}\n`);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "manager", "--session", sessionResult.value.session_id, "--action", actionPath], {
        cwd: repo,
        windowsHide: true
      }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /unknown manager action type/);
        return true;
      }
    );

    const session = await readSession(repo, sessionResult.value.session_path);
    assert.deepEqual(session.executed_actions, []);
    assert.deepEqual(await contractFiles(repo), []);
  });
});

test("manager executor refuses actions when the active spec is not ratified", async () => {
  await withTempRepo(async ({ repo }) => {
    await createRatifiedSpec(repo, "S-001");
    const sessionResult = await startManagerSession(repo, "Spec must stay ratified");
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const draft = await createSpec(repo, "S-DRAFT", "Draft spec");
    assert.equal(draft.ok, true);
    const result = await executeManagerAction(repo, sessionResult.value.session_id, { type: "get_status" });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /active spec S-DRAFT is draft/);
    const session = await readSession(repo, sessionResult.value.session_path);
    assert.deepEqual(session.executed_actions, []);
  });
});

test("manager enqueue_patch rejects missing and duplicate patch bundles deterministically", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    const sessionResult = await startManagerSession(repo, "Queue patch once");
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }

    const missing = await executeManagerAction(repo, sessionResult.value.session_id, { type: "enqueue_patch", task_id: "T-001" });
    assert.equal(missing.ok, true);
    if (!missing.ok) {
      return;
    }
    assert.equal(missing.value.result.ok, false);
    if (!missing.value.result.ok) {
      assert.match(missing.value.result.reason, /patch bundle not found/);
    }

    await mkdir(path.join(repo, ".hivemind", "patches", "T-001"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), "");
    const queued = await executeManagerAction(repo, sessionResult.value.session_id, { type: "enqueue_patch", task_id: "T-001" });
    assert.equal(queued.ok, true);
    if (!queued.ok) {
      return;
    }
    assert.equal(queued.value.result.ok, true);

    const duplicate = await executeManagerAction(repo, sessionResult.value.session_id, { type: "enqueue_patch", task_id: "T-001" });
    assert.equal(duplicate.ok, true);
    if (!duplicate.ok) {
      return;
    }
    assert.equal(duplicate.value.result.ok, false);
    if (!duplicate.value.result.ok) {
      assert.match(duplicate.value.result.reason, /already contains T-001/);
    }
    const queue = JSON.parse(await readFile(path.join(repo, ".hivemind", "integration", "queue.json"), "utf8")) as Array<{ task_id: string }>;
    assert.deepEqual(queue, [{ task_id: "T-001" }]);
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.equal(events.value.filter((event) => event.type === "integration.queued").length, 1);
  });
});

test("manager enqueue_patch routes through a live daemon instead of direct queue writes", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await createRatifiedSpec(repo, "S-001");
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await mkdir(path.join(repo, ".hivemind", "patches", "T-001"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"), "");
    const sessionResult = await startManagerSession(repo, "Queue through daemon");
    assert.equal(sessionResult.ok, true);
    if (!sessionResult.ok) {
      return;
    }
    const actionPath = path.join(repo, "enqueue-action.json");
    await writeFile(actionPath, `${JSON.stringify({ type: "enqueue_patch", task_id: "T-001" }, null, 2)}\n`);

    const daemon = await startDaemon(repo);
    try {
      const routed = await execFileAsync(process.execPath, [cliPath, "manager", "--session", sessionResult.value.session_id, "--action", actionPath], {
        cwd: repo,
        env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
        windowsHide: true
      });
      const parsed = JSON.parse(routed.stdout) as { result: { ok: boolean; value: { queue: string[] } } };
      assert.equal(parsed.result.ok, true);
      assert.deepEqual(parsed.result.value.queue, ["T-001"]);
    } finally {
      await stopDaemon(daemon);
    }

    const queue = JSON.parse(await readFile(path.join(repo, ".hivemind", "integration", "queue.json"), "utf8")) as Array<{ task_id: string }>;
    assert.deepEqual(queue, [{ task_id: "T-001" }]);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-manager-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await git(repo, ["checkout", "-b", "main"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

async function contractFiles(repo: string): Promise<string[]> {
  return (await childNames(path.join(repo, ".hivemind", "tasks"))).filter((name) => name.endsWith(".contract.json"));
}

async function childNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort((left, right) => left.localeCompare(right));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function assertExists(filePath: string): Promise<void> {
  await stat(filePath);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readSession(
  repo: string,
  sessionPath: string
): Promise<{ executed_actions: Array<{ type: string; result: { ok: boolean; reason?: string } }> }> {
  return JSON.parse(await readFile(path.join(repo, sessionPath), "utf8")) as {
    executed_actions: Array<{ type: string; result: { ok: boolean; reason?: string } }>;
  };
}

async function setConfigTestCommand(repo: string, testCommand: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.test_command = testCommand;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeAgent(repo: string, fileName: string, lines: string[]): Promise<string> {
  const agentsDir = path.join(repo, "fake-agents");
  await mkdir(agentsDir, { recursive: true });
  const agentPath = path.join(agentsDir, fileName);
  await writeFile(agentPath, `${lines.join("\n")}\n`);
  return agentPath;
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
        verified_on: "2026-06-16",
        context_window: 1024,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Manager executor fixture",
        agent_role: "builder",
        base_commit: baseCommit,
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: [],
        patch_requirements: []
      },
      null,
      2
    )}\n`
  );
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
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
  await rm(repo, { recursive: true, force: true, maxRetries: 3 });
}

async function startDaemon(repo: string): Promise<DaemonProcess> {
  const child = spawn(process.execPath, [cliPath, "daemon", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
  const line = await readLine(child);
  const parsed = JSON.parse(line) as { event: string; url: string };
  assert.equal(parsed.event, "daemon.ready");
  return { child, url: parsed.url };
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
  if (daemon.child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    daemon.child.once("exit", () => resolve());
    daemon.child.kill();
  });
}

function readLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon did not become ready; stderr: ${stderr}`));
    }, 5000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolve(stdout.slice(0, newline).trim());
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`daemon exited before ready with code ${code}; stderr: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}
