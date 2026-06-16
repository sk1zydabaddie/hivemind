import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { findGitRoot } from "./repo.js";

const mcpPath = "/mcp";

interface McpOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
}

interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
}

export const mcpToolDefinitions: McpToolDefinition[] = [
  {
    name: "hivemind.validate_contract",
    title: "Validate contract",
    description: "Validate and normalize a Hivemind task contract.",
    readOnly: true
  },
  {
    name: "hivemind.create_worktree",
    title: "Create worktree",
    description: "Create or reuse a task worktree.",
    readOnly: false
  },
  {
    name: "hivemind.remove_worktree",
    title: "Remove worktree",
    description: "Remove a task worktree and branch.",
    readOnly: false
  },
  {
    name: "hivemind.request_lease",
    title: "Request lease",
    description: "Request the active file lease for a task contract.",
    readOnly: false
  },
  {
    name: "hivemind.release_lease",
    title: "Release lease",
    description: "Release active leases held by a task.",
    readOnly: false
  },
  {
    name: "hivemind.check_write_intent",
    title: "Check write intent",
    description: "Check intended writes against the active lease store.",
    readOnly: true
  },
  {
    name: "hivemind.submit_patch",
    title: "Submit patch",
    description: "Assemble a patch bundle from a task worktree.",
    readOnly: false
  },
  {
    name: "hivemind.analyze_patch",
    title: "Analyze patch",
    description: "Run the deterministic diff-scope gate for a task patch.",
    readOnly: true
  },
  {
    name: "hivemind.integrate_shadow",
    title: "Integrate shadow",
    description: "Run shadow integration for accepted queued patches.",
    readOnly: false
  },
  {
    name: "hivemind.get_status",
    title: "Get status",
    description: "Read Hivemind task, lease, patch, and integration status.",
    readOnly: true
  }
];

export async function mcpCommand(cwd: string, args: string[]): Promise<number> {
  const options = parseMcpOptions(args);
  if (!options.ok) {
    console.error(`error: ${options.reason}`);
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  if (options.value.transport === "stdio") {
    return runStdioMcpServer(repoRoot);
  }
  return runHttpMcpServer(repoRoot, options.value);
}

function createHivemindMcpServer(repoRoot: string): McpServer {
  const server = new McpServer(
    {
      name: "hivemind-ai",
      version: "0.0.0"
    },
    {
      capabilities: {
        tools: {}
      },
      instructions: `Hivemind MCP facade for ${repoRoot}. Tool implementations land in M4.4.`
    }
  );

  for (const tool of mcpToolDefinitions) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: !tool.readOnly,
          idempotentHint: tool.readOnly,
          openWorldHint: false
        }
      },
      async () => ({
        content: [
          {
            type: "text",
            text: `${tool.name} is listed by the M4.3 scaffold; tool execution is implemented in M4.4.`
          }
        ],
        isError: true
      })
    );
  }

  return server;
}

async function runStdioMcpServer(repoRoot: string): Promise<number> {
  const server = createHivemindMcpServer(repoRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  return 0;
}

async function runHttpMcpServer(repoRoot: string, options: McpOptions): Promise<number> {
  const httpServer = createServer(async (request, response) => {
    if (request.url !== mcpPath) {
      writeJson(response, 404, { ok: false, reason: "unknown MCP route" });
      return;
    }
    if (!isAllowedOrigin(request.headers.origin)) {
      writeJson(response, 403, { ok: false, reason: "MCP HTTP origin must be local" });
      return;
    }
    try {
      const server = createHivemindMcpServer(repoRoot);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      response.once("close", () => {
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error: unknown) {
      if (!response.headersSent) {
        writeJson(response, 500, { ok: false, reason: error instanceof Error ? error.message : "unexpected MCP failure" });
      } else {
        response.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  console.log(
    JSON.stringify({
      event: "mcp.ready",
      transport: "http",
      url: `http://${formatHostForUrl(options.host)}:${address.port}${mcpPath}`,
      repo_root: repoRoot
    })
  );

  const close = () => {
    httpServer.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  await new Promise<void>((resolve) => {
    httpServer.once("close", resolve);
  });
  return 0;
}

function parseMcpOptions(args: string[]): { ok: true; value: McpOptions } | { ok: false; reason: string } {
  let transport: "stdio" | "http" = "stdio";
  let host = "127.0.0.1";
  let port = 0;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stdio") {
      if (transport === "http") {
        return { ok: false, reason: mcpUsage() };
      }
      transport = "stdio";
      continue;
    }
    if (arg === "--http") {
      transport = "http";
      continue;
    }
    if (arg === "--host") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, reason: mcpUsage() };
      }
      host = value;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        return { ok: false, reason: mcpUsage() };
      }
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        return { ok: false, reason: "MCP HTTP port must be between 0 and 65535" };
      }
      index += 1;
      continue;
    }
    return { ok: false, reason: mcpUsage() };
  }

  if (transport === "stdio" && (host !== "127.0.0.1" || port !== 0)) {
    return { ok: false, reason: mcpUsage() };
  }
  if (transport === "http" && !isLoopbackHost(host)) {
    return { ok: false, reason: "MCP HTTP host must be local loopback" };
  }

  return { ok: true, value: { transport, host, port } };
}

function mcpUsage(): string {
  return "usage: hivemind mcp [--stdio] | [--http [--host <host>] [--port <port>]]";
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}
