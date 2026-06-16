import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { initProject } from "../src/init.js";
import { mcpToolDefinitions } from "../src/mcp.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");
const expectedToolNames = mcpToolDefinitions.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));

test("MCP stdio transport lists the scaffold tool surface", async () => {
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

test("MCP streamable HTTP transport lists the scaffold tool surface", async () => {
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

test("MCP scaffold tool calls fail closed without mutating Hivemind state", async () => {
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
      assert.match(String(firstContent?.type === "text" ? firstContent.text : ""), /M4\.3 scaffold/);
      assert.equal(await exists(path.join(repo, ".hivemind", "worktrees", "T-001")), false);
    } finally {
      await client.close();
      await stopHttpMcp(server);
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

async function withTempRepo(run: (context: { repo: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-mcp-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function startHttpMcp(repo: string): Promise<HttpMcpProcess> {
  const child = spawn(process.execPath, [cliPath, "mcp", "--http", "--port", "0"], {
    cwd: repo,
    windowsHide: true
  });
  const line = await readLine(child);
  const parsed = JSON.parse(line) as { event: string; transport: string; url: string; repo_root: string };
  assert.equal(parsed.event, "mcp.ready");
  assert.equal(parsed.transport, "http");
  return { child, url: parsed.url, repoRoot: parsed.repo_root };
}

async function stopHttpMcp(server: HttpMcpProcess): Promise<void> {
  if (server.child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.child.once("exit", () => resolve());
    server.child.kill();
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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
