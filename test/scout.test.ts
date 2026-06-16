import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";
import { requestLease } from "../src/lease.js";
import { readEvents } from "../src/events.js";
import { runTask } from "../src/run.js";
import { runScout } from "../src/scout.js";
import { createTaskWorktree } from "../src/worktree.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
}

test("Scout pass seeds a reusable context pack consumed by a later worker with cache hits", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const scoutAgent = await writeAgent(repo, "scout-agent.mjs", [
      "let prompt = '';",
      "for await (const chunk of process.stdin) prompt += chunk;",
      "console.log('SCOUT_FINDING: README owns the fixture behavior');",
      "console.log(JSON.stringify({ scout_prompt: prompt.includes('Hivemind Scout rules') && prompt.includes('# Fixture') }));"
    ]);
    const builderAgent = await writeAgent(repo, "builder-agent.mjs", [
      "let prompt = '';",
      "for await (const chunk of process.stdin) prompt += chunk;",
      "console.log(JSON.stringify({ hasScout: prompt.includes('Scout context pack:') && prompt.includes('SCOUT_FINDING') && prompt.includes('Task Knowledge') && prompt.includes('Reused cached read README.md') }));"
    ]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake-scout", scoutAgent);
    await writeProfile(repo, "fake-builder", builderAgent);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);

    const scout = await runScout(repo, "T-001", "fake-scout");

    assert.equal(scout.ok, true);
    if (!scout.ok) {
      return;
    }
    assert.equal(scout.value.context_pack_path, ".hivemind/cache/context-packs/T-001.json");
    assert.equal(scout.value.knowledge_path, ".hivemind/tasks/T-001.knowledge.md");
    assert.equal(scout.value.read_cache.misses, 1);
    assert.equal(scout.value.read_cache.hits, 0);
    assert.match(await readFile(path.join(repo, scout.value.context_pack_path), "utf8"), /SCOUT_FINDING/);
    assert.match(await readFile(path.join(repo, scout.value.knowledge_path), "utf8"), /SCOUT_FINDING/);
    await assertMissing(path.join(repo, ".hivemind", "patches", "T-001", "diff.patch"));

    await grantLease(repo, "T-001", ["README.md"]);
    const worker = await runTask(repo, "T-001", "fake-builder");
    const events = await readEvents(repo);

    assert.equal(worker.ok, true);
    assert.equal(events.ok, true);
    if (!worker.ok || !events.ok) {
      return;
    }
    assert.match(await readFile(path.join(repo, ".hivemind", "worktrees", "T-001", "agent.log"), "utf8"), /"hasScout":true/);
    assert.equal(events.value.some((event) => event.type === "scout.completed" && event.task_id === "T-001"), true);
    assert.equal(
      events.value.some((event) => event.type === "cache.read" && event.task_id === "T-001" && event.data.path === "README.md" && event.data.result === "hit"),
      true
    );
  });
});

test("Scout rejects dangerous profiles and adapters that dirty the worktree", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const noopAgent = await writeAgent(repo, "noop-scout.mjs", ["console.log('noop scout');"]);
    const dirtyAgent = await writeAgent(repo, "dirty-scout.mjs", ["await import('node:fs/promises').then(({ writeFile }) => writeFile('NEW.md', 'not read only\\n'));"]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "dangerous-scout", noopAgent, true);
    await writeProfile(repo, "dirty-scout", dirtyAgent);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);

    const dangerous = await runScout(repo, "T-001", "dangerous-scout");
    assert.equal(dangerous.ok, false);
    if (dangerous.ok) {
      return;
    }
    assert.match(dangerous.reason, /Scout is read-only and cannot run dangerous adapter profiles/);
    await assertMissing(path.join(repo, ".hivemind", "cache", "context-packs", "T-001.json"));

    const dirty = await runScout(repo, "T-001", "dirty-scout");
    assert.equal(dirty.ok, false);
    if (dirty.ok) {
      return;
    }
    assert.match(dirty.reason, /dirty after Scout invocation/);
    await assertMissing(path.join(repo, ".hivemind", "cache", "context-packs", "T-001.json"));
  });
});

test("CLI Scout routes through a live daemon and writes the same context-pack artifact", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const scoutAgent = await writeAgent(repo, "daemon-scout.mjs", ["console.log('DAEMON_SCOUT_FINDING');"]);
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeProfile(repo, "fake-scout", scoutAgent);
    const worktree = await createTaskWorktree(repo, "T-001");
    assert.equal(worktree.ok, true);

    const daemon = await startDaemon(repo);
    try {
      const result = await execFileAsync(process.execPath, [cliPath, "scout", "T-001", "--tool", "fake-scout"], {
        cwd: repo,
        env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
        windowsHide: true
      });
      const parsed = JSON.parse(result.stdout) as { task_id: string; context_pack_path: string };
      assert.equal(parsed.task_id, "T-001");
      assert.equal(parsed.context_pack_path, ".hivemind/cache/context-packs/T-001.json");
      assert.match(await readFile(path.join(repo, parsed.context_pack_path), "utf8"), /DAEMON_SCOUT_FINDING/);
    } finally {
      await stopDaemon(daemon);
    }
  });
});

test("manager fake loop can sequence a Scout task before worker execution", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const scoutAgent = await writeAgent(repo, "manager-scout.mjs", ["console.log('MANAGER_SCOUT_FINDING');"]);
    await writeProfile(repo, "fake-scout", scoutAgent);
    const actionsPath = path.join(repo, "manager-scout-actions.json");
    await writeFile(
      actionsPath,
      `${JSON.stringify(
        [
          { type: "create_task_contract", contract: contractFor("T-SCOUT", baseCommit, ["README.md"]) },
          { type: "create_worktree", task_id: "T-SCOUT" },
          { type: "scout_task", task_id: "T-SCOUT", tool: "fake-scout" }
        ],
        null,
        2
      )}\n`
    );

    const result = await execFileAsync(process.execPath, [cliPath, "manager", "--message", "Scout this task", "--fake-manager", actionsPath], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { status: string; steps: Array<{ action_type: string; result: { ok: boolean } }> };

    assert.equal(parsed.status, "passed");
    assert.deepEqual(parsed.steps.map((step) => step.action_type), ["create_task_contract", "create_worktree", "scout_task"]);
    assert.equal(parsed.steps.every((step) => step.result.ok), true);
    assert.match(await readFile(path.join(repo, ".hivemind", "cache", "context-packs", "T-SCOUT.json"), "utf8"), /MANAGER_SCOUT_FINDING/);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-scout-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "AGENTS.md"), "Project instructions\n");
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "AGENTS.md", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

function contractFor(taskId: string, baseCommit: string, allowedFiles: string[]): Record<string, unknown> {
  return {
    task_id: taskId,
    title: "Scout reusable context",
    agent_role: "builder",
    base_commit: baseCommit,
    allowed_files: allowedFiles,
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: ["project instructions"],
    required_tests: ["node -e \"console.log('acceptance')\""],
    patch_requirements: ["submit diff only"]
  };
}

async function writeAgent(repo: string, fileName: string, lines: string[]): Promise<string> {
  const agentsDir = path.join(repo, "fake-agents");
  await mkdir(agentsDir, { recursive: true });
  const agentPath = path.join(agentsDir, fileName);
  await writeFile(agentPath, `${lines.join("\n")}\n`);
  return agentPath;
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "tasks", `${taskId}.contract.json`),
    `${JSON.stringify(contractFor(taskId, baseCommit, allowedFiles), null, 2)}\n`
  );
}

async function writeProfile(repo: string, tool: string, agentPath: string, dangerous = false): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "adapters"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "adapters", `${tool}.profile.json`),
    `${JSON.stringify(
      {
        tool,
        invoke: dangerous ? [process.execPath, agentPath, "--dangerously-skip-permissions"] : [process.execPath, agentPath],
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

async function grantLease(repo: string, taskId: string, files: string[]): Promise<void> {
  const result = await requestLease(repo, taskId, files);
  assert.equal(result.ok, true);
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
    daemon.child.kill("SIGTERM");
    setTimeout(() => {
      if (daemon.child.exitCode === null) {
        daemon.child.kill("SIGKILL");
      }
      resolve();
    }, 500).unref();
  });
}

function readLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline !== -1) {
        resolve(output.slice(0, newline));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`daemon exited before ready: ${code}`));
    });
  });
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
