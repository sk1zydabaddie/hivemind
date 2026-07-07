import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { captureWorktreeDiff } from "../src/diff-capture.js";
import { initProject } from "../src/init.js";
import { appendEvent, readEvents } from "../src/events.js";
import { mcpToolDefinitions } from "../src/mcp.js";
import { createSpec } from "../src/spec.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");
const expectedToolNames = mcpToolDefinitions.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));

test("MCP stdio transport lists the M4.4 tool surface", async () => {
  await withTempRepo(async ({ repo }) => {
    const client = new Client({ name: "hivemind-stdio-test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp", "--stdio"],
      cwd: repo,
      stderr: "pipe"
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right)),
        expectedToolNames
      );
      assert.equal(stderr, "");
    } finally {
      await client.close();
    }
  });
});

test("MCP streamable HTTP transport lists the M4.4 tool surface", async () => {
  await withTempRepo(async ({ repo }) => {
    const server = await startHttpMcp(repo);
    const client = new Client({ name: "hivemind-http-test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right)),
        expectedToolNames
      );
    } finally {
      await client.close();
      await stopHttpMcp(server);
    }
  });
});

test("MCP tool calls fail closed without a configured daemon", async () => {
  await withTempRepo(async ({ repo }) => {
    const server = await startHttpMcp(repo);
    const client = new Client({ name: "hivemind-call-test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "hivemind.create_worktree",
        arguments: { task_id: "T-001" }
      });

      assert.equal(result.isError, true);
      assert.equal(Array.isArray(result.content), true);
      const firstContent = (result.content as Array<{ type?: unknown; text?: unknown }>)[0];
      assert.match(String(firstContent?.type === "text" ? firstContent.text : ""), /HIVEMIND_DAEMON_URL is required/);
      assert.equal(await exists(path.join(repo, ".hivemind", "worktrees", "T-001")), false);
    } finally {
      await client.close();
      await stopHttpMcp(server);
    }
  });
});

test("MCP tools route through daemon and match the core task/worktree/patch/status flow", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await setConfigTestCommand(repo, "node -e \"process.exit(0)\"");
    const contract = buildContract("T-OK", baseCommit, ["README.md"]);
    await prepareLintedPlan(repo, contract);
    const daemon = await startDaemon(repo);
    try {
      const created = await withStdioMcpClient(repo, daemon.url, "hivemind-core-tools-test", (client) =>
        callStructured(client, "hivemind.create_task_contract", { contract })
      );
      assert.equal(created.task_id, "T-OK");
      assert.equal(created.contract_path, ".hivemind/tasks/T-OK.contract.json");
      await execFileAsync(process.execPath, [cliPath, "contract", "T-OK", "--validate"], { cwd: repo, windowsHide: true });

      const lease = await withStdioMcpClient(repo, daemon.url, "hivemind-core-lease-test", (client) =>
        callStructured(client, "hivemind.request_lease", { task_id: "T-OK" })
      );
      assert.deepEqual(lease.granted, ["README.md"]);

      const worktree = await withStdioMcpClient(repo, daemon.url, "hivemind-core-worktree-test", (client) =>
        callStructured(client, "hivemind.create_worktree", { task_id: "T-OK" })
      );
      assert.equal(worktree.branch, "hivemind/T-OK");
      assert.equal(typeof worktree.worktree, "string");
      await writeFile(path.join(String(worktree.worktree), "README.md"), "# Fixture\nMCP accepted edit\n");
      await markRunCompleted(repo, "T-OK", String(worktree.worktree), baseCommit);

      const submitted = await withStdioMcpClient(repo, daemon.url, "hivemind-core-submit-test", (client) =>
        callStructured(client, "hivemind.submit_patch", { task_id: "T-OK" })
      );
      assert.equal(submitted.task_id, "T-OK");
      assert.deepEqual(submitted.files, [
        "diff.patch",
        "summary.md",
        "files_changed.json",
        "symbols_changed.json",
        "tests_run.json",
        "risks.md",
        "memory_proposals.json"
      ]);

      const eventsBeforeAnalyze = await readEvents(repo);
      assert.equal(eventsBeforeAnalyze.ok, true);
      const accepted = await withStdioMcpClient(repo, daemon.url, "hivemind-core-analyze-test", (client) =>
        callStructured(client, "hivemind.analyze_patch", { task_id: "T-OK" })
      );
      const eventsAfterAnalyze = await readEvents(repo);
      assert.equal(eventsAfterAnalyze.ok, true);
      assert.equal(accepted.verdict, "accept");
      if (!eventsBeforeAnalyze.ok || !eventsAfterAnalyze.ok) {
        return;
      }
      assert.equal(eventsAfterAnalyze.value.length, eventsBeforeAnalyze.value.length);

      await writeQueue(repo, ["T-OK"]);
      const integration = await withStdioMcpClient(repo, daemon.url, "hivemind-core-integrate-test", (client) =>
        callStructured(client, "hivemind.integrate_shadow", {})
      );
      assert.equal(integration.tests, "pass");
      assert.deepEqual(integration.applied, ["T-OK"]);

      const status = await withStdioMcpClient(repo, daemon.url, "hivemind-core-status-test", (client) =>
        callStructured(client, "hivemind.get_status", {})
      );
      assert.equal(Array.isArray(status.tasks), true);
      const tasks = status.tasks as Array<{
        task_id?: unknown;
        patch?: { submitted?: unknown; analyzed?: unknown; accepted?: unknown; verdict?: unknown };
        integrated?: unknown;
      }>;
      const task = tasks.find((entry) => entry.task_id === "T-OK");
      assert.equal(task?.patch?.submitted, true);
      assert.equal(task?.patch?.analyzed, true);
      assert.equal(task?.patch?.accepted, true);
      assert.equal(task?.patch?.verdict, "accept");
      assert.equal(task?.integrated, true);
    } finally {
      await stopProcess(daemon);
    }
  });
});

test("draft active spec blocks daemon-routed lease and MCP task creation", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContractFile(repo, buildContract("T-DRAFT", baseCommit, ["README.md"]));
    const draft = await createSpec(repo, "S-DRAFT", "Draft gate");
    assert.equal(draft.ok, true);
    const daemon = await startDaemon(repo);
    const server = await startHttpMcp(repo, { HIVEMIND_DAEMON_URL: daemon.url });
    const client = new Client({ name: "hivemind-draft-gate-test", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    try {
      await assert.rejects(
        execFileAsync(process.execPath, [cliPath, "lease", "T-DRAFT"], {
          cwd: repo,
          env: { ...process.env, HIVEMIND_DAEMON_URL: daemon.url },
          windowsHide: true
        }),
        (error: unknown) => {
          assert.equal((error as { code?: number }).code, 1);
          assert.match(String((error as { stderr?: string }).stderr), /active spec S-DRAFT is draft/);
          return true;
        }
      );
      assert.equal(await exists(path.join(repo, ".hivemind", "leases", "active.json")), false);

      await client.connect(transport);
      const result = await client.callTool({
        name: "hivemind.create_task_contract",
        arguments: { contract: buildContract("T-BLOCKED", baseCommit, ["README.md"]) }
      });

      assert.equal(result.isError, true);
      const content = (result.content as Array<{ type?: unknown; text?: unknown }>)[0];
      assert.match(String(content?.type === "text" ? content.text : ""), /active spec S-DRAFT is draft/);
      assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "T-BLOCKED.contract.json")), false);
    } finally {
      await client.close();
      await stopHttpMcp(server);
      await stopProcess(daemon);
    }
  });
});

test("MCP analyze_patch rejects out-of-scope patch bundles", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await prepareLintedPlan(repo, buildContract("T-OUT", baseCommit, ["README.md"]));
    const daemon = await startDaemon(repo);
    try {
      await withStdioMcpClient(repo, daemon.url, "hivemind-reject-create-test", (client) =>
        callStructured(client, "hivemind.create_task_contract", {
          contract: buildContract("T-OUT", baseCommit, ["README.md"])
        })
      );
      await writePatchFromRootEdit(repo, "T-OUT", baseCommit, async () => {
        await writeFile(path.join(repo, "outside.txt"), "outside change\n");
      });

      const rejected = await withStdioMcpClient(repo, daemon.url, "hivemind-reject-analyze-test", (client) =>
        callStructured(client, "hivemind.analyze_patch", { task_id: "T-OUT" })
      );

      assert.equal(rejected.verdict, "reject");
      assert.match(String(rejected.reason), /outside allowed_files|not allowed|outside/i);
    } finally {
      await stopProcess(daemon);
    }
  });
});

test("MCP create_task_contract rejects invalid input and duplicate task ids", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await prepareLintedPlan(repo, buildContract("T-DUP", baseCommit, ["README.md"]));
    const daemon = await startDaemon(repo);
    try {
      await withStdioMcpClient(repo, daemon.url, "hivemind-contract-invalid-test", async (client) => {
        const invalid = await client.callTool({
          name: "hivemind.create_task_contract",
          arguments: { contract: { task_id: "bad/id", base_commit: baseCommit, allowed_files: ["README.md"] } }
        });
        assert.equal(invalid.isError, true);
      });
      assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "bad", "id.contract.json")), false);

      await withStdioMcpClient(repo, daemon.url, "hivemind-contract-test", async (client) => {
        await callStructured(client, "hivemind.create_task_contract", {
          contract: buildContract("T-DUP", baseCommit, ["README.md"])
        });
        const duplicate = await client.callTool({
          name: "hivemind.create_task_contract",
          arguments: { contract: buildContract("T-DUP", baseCommit, ["README.md"]) }
        });

        assert.equal(duplicate.isError, true);
        const content = (duplicate.content as Array<{ type?: unknown; text?: unknown }>)[0];
        assert.match(String(content?.type === "text" ? content.text : ""), /contract already exists/);
      });
    } finally {
      await stopProcess(daemon);
    }
  });
});

test("MCP create_task_contract inherits the lint-passed plan precondition", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const bypass = buildContract("T-BYPASS", baseCommit, ["README.md"]);
    const other = buildContract("T-OTHER", baseCommit, ["README.md"]);
    const badPlanPath = path.join(repo, "mcp-overlap-plan.json");
    await writeFile(
      badPlanPath,
      `${JSON.stringify(
        {
          tasks: [planTaskFromContract(bypass), planTaskFromContract(other)],
          execution_groups: [{ group_id: "G-1", mode: "parallel", task_ids: ["T-BYPASS", "T-OTHER"] }]
        },
        null,
        2
      )}\n`
    );
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", badPlanPath], { cwd: repo, windowsHide: true });
    await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /PARALLEL_SCOPE_OVERLAP/);
        return true;
      }
    );

    const daemon = await startDaemon(repo);
    try {
      await withStdioMcpClient(repo, daemon.url, "hivemind-mcp-lint-floor-test", async (client) => {
        const result = await client.callTool({
          name: "hivemind.create_task_contract",
          arguments: { contract: bypass }
        });

        assert.equal(result.isError, true);
        const content = (result.content as Array<{ type?: unknown; text?: unknown }>)[0];
        assert.match(String(content?.type === "text" ? content.text : ""), /current lint-passed tentative plan/);
      });
      assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "T-BYPASS.contract.json")), false);
    } finally {
      await stopProcess(daemon);
    }
  });
});

test("MCP create_task_contract refuses a dependent task until dependencies are event-integrated", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const dependency = buildContract("T-BASE", baseCommit, ["README.md"]);
    const dependent = buildContract("T-DEP", baseCommit, ["outside.txt"]);
    await prepareLintedPlanWithTasks(repo, [
      planTaskFromContract(dependency),
      planTaskFromContract(dependent, ["T-BASE"])
    ]);

    const daemon = await startDaemon(repo);
    try {
      await withStdioMcpClient(repo, daemon.url, "hivemind-mcp-dependency-block-test", async (client) => {
        const blocked = await client.callTool({
          name: "hivemind.create_task_contract",
          arguments: { contract: dependent }
        });

        assert.equal(blocked.isError, true);
        const blockedContent = (blocked.content as Array<{ type?: unknown; text?: unknown }>)[0];
        assert.match(String(blockedContent?.type === "text" ? blockedContent.text : ""), /task T-DEP depends_on not integrated: T-BASE/);
      });
      assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "T-DEP.contract.json")), false);

      await appendIntegratedDependencyEvents(repo, "T-BASE");
      await withStdioMcpClient(repo, daemon.url, "hivemind-mcp-dependency-allowed-test", async (client) => {
        const allowed = await callStructured(client, "hivemind.create_task_contract", { contract: dependent });
        assert.equal(allowed.task_id, "T-DEP");
      });
      assert.equal(await exists(path.join(repo, ".hivemind", "tasks", "T-DEP.contract.json")), true);
    } finally {
      await stopProcess(daemon);
    }
  });
});

test("MCP HTTP transport rejects non-local origins and CLI invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    const server = await startHttpMcp(repo);
    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test"
        },
        body: "{}"
      });
      assert.equal(response.status, 403);
      assert.match(await response.text(), /origin must be local/);
    } finally {
      await stopHttpMcp(server);
    }

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "mcp", "--stdio", "--port", "1"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /usage: hivemind mcp/);
        return true;
      }
    );
  });
});

interface HttpMcpProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
  repoRoot: string;
}

interface DaemonProcess {
  child: ChildProcessWithoutNullStreams;
  url: string;
  repoRoot: string;
}

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-mcp-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await git(repo, ["checkout", "-b", "main"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "outside.txt"), "outside\n");
    await git(repo, ["add", "README.md", "outside.txt"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

async function startHttpMcp(repo: string, env: Record<string, string> = { HIVEMIND_DAEMON_URL: "" }): Promise<HttpMcpProcess> {
  const child = spawn(process.execPath, [cliPath, "mcp", "--http", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, ...env },
    windowsHide: true
  });
  const line = await readLine(child);
  const parsed = JSON.parse(line) as { event: string; transport: string; url: string; repo_root: string };
  assert.equal(parsed.event, "mcp.ready");
  assert.equal(parsed.transport, "http");
  return { child, url: parsed.url, repoRoot: parsed.repo_root };
}

async function stopHttpMcp(server: HttpMcpProcess): Promise<void> {
  await stopProcess(server);
}

async function startDaemon(repo: string): Promise<DaemonProcess> {
  const child = spawn(process.execPath, [cliPath, "daemon", "--port", "0"], {
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: "" },
    windowsHide: true
  });
  const line = await readLine(child);
  const parsed = JSON.parse(line) as { event: string; url: string; repo_root: string };
  assert.equal(parsed.event, "daemon.ready");
  return { child, url: parsed.url, repoRoot: parsed.repo_root };
}

async function stopProcess(processInfo: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (processInfo.child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    processInfo.child.once("exit", () => resolve());
    processInfo.child.kill();
  });
}

function readLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP server did not become ready; stderr: ${stderr}`));
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
      reject(new Error(`MCP server exited before ready with code ${code}; stderr: ${stderr}`));
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

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
  return result.stdout.trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
  return result.stdout;
}

function buildContract(taskId: string, baseCommit: string, allowedFiles: string[]): Record<string, unknown> {
  return {
    task_id: taskId,
    title: "MCP task",
    agent_role: "builder",
    base_commit: baseCommit,
    acceptance_criterion: "MCP task completes one deterministic check.",
    allowed_files: allowedFiles,
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: []
  };
}

async function markRunCompleted(repo: string, taskId: string, worktree: string, baseCommit: string): Promise<void> {
  const diff = await captureWorktreeDiff(worktree, baseCommit);
  assert.equal(diff.ok, true);
  if (!diff.ok) {
    return;
  }
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  const diffPath = path.join(patchDir, "diff.patch");
  await writeFile(diffPath, diff.value.diff);
  const started = await appendEvent(repo, {
    type: "task.started",
    task_id: taskId,
    data: { tool: "fake", worktree }
  });
  assert.equal(started.ok, true);
  const completed = await appendEvent(repo, {
    type: "task.completed",
    task_id: taskId,
    data: {
      task_id: taskId,
      status: "completed",
      tool: "fake",
      diff_path: diffPath,
      tool_exit: 0,
      changed_files: diff.value.changedFiles
    }
  });
  assert.equal(completed.ok, true);
}

async function prepareLintedPlan(repo: string, contract: Record<string, unknown>, name = `${String(contract.task_id)}-plan.json`): Promise<void> {
  await prepareLintedPlanWithTasks(repo, [planTaskFromContract(contract)], name);
}

async function prepareLintedPlanWithTasks(repo: string, tasks: Record<string, unknown>[], name = "plan.json"): Promise<void> {
  const planPath = path.join(repo, name);
  await writeFile(
    planPath,
    `${JSON.stringify(
      {
        tasks,
        execution_groups: [{ group_id: "G-1", mode: "sequence", task_ids: tasks.map((task) => task.task_id) }]
      },
      null,
      2
    )}\n`
  );
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--propose", planPath], { cwd: repo, windowsHide: true });
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--ground"], { cwd: repo, windowsHide: true });
  await execFileAsync(process.execPath, [cliPath, "plan", "S-001", "--lint"], { cwd: repo, windowsHide: true });
}

function planTaskFromContract(contract: Record<string, unknown>, dependsOn: string[] = []): Record<string, unknown> {
  return {
    task_id: contract.task_id,
    title: contract.title,
    mode: "write",
    agent_role: contract.agent_role,
    draft_scope: {
      allowed_files: contract.allowed_files,
      read_only_files: contract.read_only_files,
      forbidden_files: contract.forbidden_files,
      must_not_change: contract.must_not_change
    },
    depends_on: dependsOn,
    parallel_safe: true,
    acceptance_criterion: contract.acceptance_criterion,
    required_tests: contract.required_tests,
    patch_requirements: contract.patch_requirements
  };
}

async function appendIntegratedDependencyEvents(repo: string, taskId: string): Promise<void> {
  await appendEvent(repo, {
    type: "patch.submitted",
    task_id: taskId,
    data: { bundle_path: `.hivemind/patches/${taskId}`, changed_files: 1 }
  });
  await appendEvent(repo, {
    type: "patch.accepted",
    task_id: taskId,
    data: { verdict: "accept", reason: "accepted dependency fixture" }
  });
  await appendEvent(repo, {
    type: "integration.passed",
    task_id: null,
    data: { applied: [taskId], tests: "pass" }
  });
}

async function withStdioMcpClient<T>(repo: string, daemonUrl: string, name: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name, version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp", "--stdio"],
    cwd: repo,
    env: { ...process.env, HIVEMIND_DAEMON_URL: daemonUrl },
    stderr: "pipe"
  });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close();
  }
}

async function callStructured(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(typeof result.structuredContent, "object");
  assert.notEqual(result.structuredContent, null);
  return result.structuredContent as Record<string, unknown>;
}

async function setConfigTestCommand(repo: string, testCommand: string): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.test_command = testCommand;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeQueue(repo: string, taskIds: string[]): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "integration", "queue.json"),
    `${JSON.stringify(taskIds.map((taskId) => ({ task_id: taskId })), null, 2)}\n`
  );
}

async function writePatchFromRootEdit(repo: string, taskId: string, baseCommit: string, edit: () => Promise<void>): Promise<void> {
  await git(repo, ["reset", "--hard", baseCommit]);
  await edit();
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  await writeFile(path.join(patchDir, "diff.patch"), await gitRawStdout(repo, ["diff", "--no-renames", baseCommit]));
  await git(repo, ["reset", "--hard", baseCommit]);
}

async function writeContractFile(repo: string, contract: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "tasks", `${String(contract.task_id)}.contract.json`), `${JSON.stringify(contract, null, 2)}\n`);
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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
