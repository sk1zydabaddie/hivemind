import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { analyzeTask } from "./analyze.js";
import { createTaskContract } from "./contract.js";
import { removeDaemonState, writeDaemonState } from "./daemon-state.js";
import { enqueueIntegrationPatch, integrateShadow } from "./integrate.js";
import { requestLeaseForContract, releaseLease } from "./lease.js";
import { findGitRoot } from "./repo.js";
import { readQuotaLedger } from "./resource-ledger.js";
import { runTask } from "./run.js";
import { getStatus } from "./status.js";
import { submitTask } from "./submit.js";
import { createTaskWorktree, removeTaskWorktree } from "./worktree.js";

interface DaemonOptions {
  host: string;
  port: number;
}

type DaemonPayload = Record<string, unknown>;
type DaemonHandler = (payload: DaemonPayload) => Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>;

export async function daemonCommand(cwd: string, args: string[]): Promise<number> {
  const options = parseDaemonOptions(args);
  if (!options.ok) {
    console.error(`error: ${options.reason}`);
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const server = createDaemonServer(repoRoot);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.value.port, options.value.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const daemonUrl = `http://${options.value.host}:${address.port}`;
  await writeDaemonState(repoRoot, {
    pid: process.pid,
    url: daemonUrl,
    repo_root: repoRoot
  });
  console.log(
    JSON.stringify({
      event: "daemon.ready",
      url: daemonUrl,
      repo_root: repoRoot
    })
  );

  const close = () => {
    server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  await new Promise<void>((resolve) => {
    server.once("close", resolve);
  });
  await removeDaemonState(repoRoot);
  return 0;
}

function createDaemonServer(repoRoot: string) {
  const queue = new SerializedQueue();
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { ok: true, repo_root: repoRoot });
        return;
      }

      const handler = routeHandler(repoRoot, request);
      if (handler === null) {
        writeJson(response, 404, { ok: false, reason: "unknown daemon route" });
        return;
      }

      const payloadResult = await readPayload(request);
      if (!payloadResult.ok) {
        writeJson(response, 400, { ok: false, reason: payloadResult.reason });
        return;
      }

      const result = await queue.run(() => handler(payloadResult.value));
      writeJson(response, result.ok ? 200 : 400, result);
    } catch (error: unknown) {
      writeJson(response, 500, { ok: false, reason: error instanceof Error ? error.message : "unexpected daemon failure" });
    }
  });
}

function routeHandler(repoRoot: string, request: IncomingMessage): DaemonHandler | null {
  if (request.method === "POST" && request.url === "/lease/request-contract") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? requestLeaseForContract(repoRoot, taskId.value) : taskId;
    };
  }
  if (request.method === "POST" && request.url === "/contract/create") {
    return async (payload) => createTaskContract(repoRoot, payload.contract);
  }
  if (request.method === "POST" && request.url === "/status") {
    return async () => getStatus(repoRoot);
  }
  if (request.method === "POST" && request.url === "/resource/quota") {
    return async () => readQuotaLedger(repoRoot);
  }
  if (request.method === "POST" && request.url === "/lease/release") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? releaseLease(repoRoot, taskId.value) : taskId;
    };
  }
  if (request.method === "POST" && request.url === "/worktree/create") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? createTaskWorktree(repoRoot, taskId.value) : taskId;
    };
  }
  if (request.method === "POST" && request.url === "/worktree/remove") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? removeTaskWorktree(repoRoot, taskId.value) : taskId;
    };
  }
  if (request.method === "POST" && request.url === "/run") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      const tool = readOptionalString(payload, "tool");
      if (!tool.ok) {
        return tool;
      }
      return runTask(repoRoot, taskId.value, tool.value, { allowDangerousAdapter: payload.allow_dangerous_adapter === true });
    };
  }
  if (request.method === "POST" && request.url === "/submit") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? submitTask(repoRoot, taskId.value) : taskId;
    };
  }
  if (request.method === "POST" && request.url === "/analyze") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? analyzeTask(repoRoot, taskId.value) : taskId;
    };
  }
  if (request.method === "POST" && request.url === "/analyze/verdict") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? analyzeTask(repoRoot, taskId.value, { emitEvent: false }) : taskId;
    };
  }
  if (request.method === "POST" && request.url === "/integrate/shadow") {
    return async () => integrateShadow(repoRoot);
  }
  if (request.method === "POST" && request.url === "/integration/enqueue") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? enqueueIntegrationPatch(repoRoot, taskId.value) : taskId;
    };
  }
  return null;
}

function parseDaemonOptions(args: string[]): { ok: true; value: DaemonOptions } | { ok: false; reason: string } {
  let host = "127.0.0.1";
  let port = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      const value = args[index + 1];
      if (!value) {
        return { ok: false, reason: "usage: hivemind daemon [--host <host>] [--port <port>]" };
      }
      host = value;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        return { ok: false, reason: "usage: hivemind daemon [--host <host>] [--port <port>]" };
      }
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        return { ok: false, reason: "daemon port must be between 0 and 65535" };
      }
      index += 1;
      continue;
    }
    return { ok: false, reason: "usage: hivemind daemon [--host <host>] [--port <port>]" };
  }
  return { ok: true, value: { host, port } };
}

async function readPayload(request: IncomingMessage): Promise<{ ok: true; value: DaemonPayload } | { ok: false; reason: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      return { ok: false, reason: "daemon request body is too large" };
    }
  }

  if (chunks.length === 0) {
    return { ok: true, value: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { ok: false, reason: "daemon request body must be JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "daemon request body must be a JSON object" };
  }
  return { ok: true, value: parsed };
}

function readTaskId(payload: DaemonPayload): { ok: true; value: string } | { ok: false; reason: string } {
  return typeof payload.task_id === "string" ? { ok: true, value: payload.task_id } : { ok: false, reason: "task_id must be a string" };
}

function readOptionalString(payload: DaemonPayload, field: string): { ok: true; value?: string } | { ok: false; reason: string } {
  if (!(field in payload) || payload[field] === undefined) {
    return { ok: true };
  }
  return typeof payload[field] === "string" ? { ok: true, value: payload[field] } : { ok: false, reason: `${field} must be a string` };
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class SerializedQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}
