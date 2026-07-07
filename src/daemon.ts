import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { analyzeTask } from "./analyze.js";
import { createTaskContract } from "./contract.js";
import { removeDaemonState, writeDaemonState } from "./daemon-state.js";
import { EventBus } from "./event-bus.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { enqueueIntegrationPatch, integrateShadow } from "./integrate.js";
import { checkWriteIntent } from "./intent.js";
import { requestLeaseForContract, releaseLease } from "./lease.js";
import { findGitRoot } from "./repo.js";
import { evaluatePlanThrash } from "./plan.js";
import { readQuotaLedger } from "./resource-ledger.js";
import { markRunFailed, startRunTaskJob } from "./run.js";
import { runScout } from "./scout.js";
import { getStatus } from "./status.js";
import { submitTask } from "./submit.js";
import { recordRedirectFirstCorrection } from "./supervision.js";
import { validateRequestedTaskId } from "./task-id.js";
import { createTaskWorktree, removeTaskWorktree } from "./worktree.js";

interface DaemonOptions {
  host: string;
  port: number;
}

type DaemonPayload = Record<string, unknown>;
type DaemonHandler = (
  payload: DaemonPayload,
  eventBus: EventBus
) => Promise<{ ok: true; value: unknown } | { ok: false; reason: string }>;

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

  const reconcileResult = await reconcileIncompleteRuns(repoRoot);
  if (!reconcileResult.ok) {
    console.error(`error: ${reconcileResult.reason}`);
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
  const eventBus = new EventBus();
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { ok: true, repo_root: repoRoot });
        return;
      }
      if (request.method === "GET" && request.url === "/events/stream") {
        await eventBus.stream(repoRoot, request, response);
        return;
      }
      const outputStreamTaskId = readOutputStreamTaskId(request);
      if (outputStreamTaskId !== null) {
        if (!outputStreamTaskId.ok) {
          writeJson(response, 400, { ok: false, reason: outputStreamTaskId.reason });
          return;
        }
        await eventBus.streamTaskOutput(repoRoot, outputStreamTaskId.value, request, response);
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

      const previousEvents = await readEvents(repoRoot);
      if (!previousEvents.ok) {
        writeJson(response, 500, { ok: false, reason: previousEvents.reason });
        return;
      }

      const result = await queue.run(() => handler(payloadResult.value, eventBus));
      await eventBus.publishNewDurableEvents(repoRoot, previousEvents.value.length);
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
  if (request.method === "POST" && request.url === "/plan/thrash") {
    return async (payload) => {
      const specId = readRequiredString(payload, "spec_id");
      if (!specId.ok) {
        return specId;
      }
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      const budget = readOptionalPositiveInteger(payload, "budget");
      return budget.ok ? evaluatePlanThrash(repoRoot, specId.value, taskId.value, budget.value) : budget;
    };
  }
  if (request.method === "POST" && request.url === "/lease/release") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? releaseLease(repoRoot, taskId.value) : taskId;
    };
  }
  if (request.method === "POST" && request.url === "/intent/check") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      return isRecord(payload.intent) ? checkWriteIntent(repoRoot, taskId.value, payload.intent) : { ok: false, reason: "intent must be a JSON object" };
    };
  }
  if (request.method === "POST" && request.url === "/supervision/redirect") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      const correction = readRequiredString(payload, "correction");
      if (!correction.ok) {
        return correction;
      }
      const reason = readRequiredString(payload, "reason");
      if (!reason.ok) {
        return reason;
      }
      const rejectionReason = readRequiredString(payload, "rejection_reason");
      if (!rejectionReason.ok) {
        return rejectionReason;
      }
      const attempt = readOptionalPositiveInteger(payload, "attempt");
      if (!attempt.ok || attempt.value === undefined) {
        return attempt.ok ? { ok: false, reason: "attempt must be a positive integer" } : attempt;
      }
      const maxAttempts = readOptionalPositiveInteger(payload, "max_attempts");
      if (!maxAttempts.ok || maxAttempts.value === undefined) {
        return maxAttempts.ok ? { ok: false, reason: "max_attempts must be a positive integer" } : maxAttempts;
      }
      return isRecord(payload.rejected_intent)
        ? recordRedirectFirstCorrection(repoRoot, {
            task_id: taskId.value,
            correction: correction.value,
            reason: reason.value,
            rejection_reason: rejectionReason.value,
            rejected_intent: payload.rejected_intent,
            attempt: attempt.value,
            max_attempts: maxAttempts.value
          })
        : { ok: false, reason: "rejected_intent must be a JSON object" };
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
    return async (payload, eventBus) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      const tool = readOptionalString(payload, "tool");
      if (!tool.ok) {
        return tool;
      }
      return startRunTaskJob(repoRoot, taskId.value, tool.value, {
        allowDangerousAdapter: payload.allow_dangerous_adapter === true,
        onEvent: (event) => eventBus.publishEvent(event),
        onOutput: (record) => eventBus.publishTaskOutput(record)
      });
    };
  }
  if (request.method === "POST" && request.url === "/run/mark-failed") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      const reason = readRequiredString(payload, "reason");
      if (!reason.ok) {
        return reason;
      }
      return markRunFailed(repoRoot, taskId.value, reason.value, payload.source === undefined ? {} : { source: payload.source });
    };
  }
  if (request.method === "POST" && request.url === "/scout/run") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      const tool = readRequiredString(payload, "tool");
      if (!tool.ok) {
        return tool;
      }
      return runScout(repoRoot, taskId.value, tool.value);
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

async function reconcileIncompleteRuns(repoRoot: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }

  for (const taskId of startedWithoutTerminal(events.value)) {
    const append = await appendEvent(repoRoot, {
      type: "task.failed",
      task_id: taskId,
      data: {
        reason: "daemon restarted before worker completion; in-flight run marked failed",
        recovered: false
      }
    });
    if (!append.ok) {
      return append;
    }
  }

  return { ok: true };
}

function startedWithoutTerminal(events: HivemindEvent[]): string[] {
  const running = new Set<string>();
  for (const event of events) {
    if (event.task_id === null) {
      continue;
    }
    if (event.type === "task.started") {
      running.add(event.task_id);
      continue;
    }
    if (event.type === "task.completed" || event.type === "task.failed") {
      running.delete(event.task_id);
    }
  }
  return [...running].sort((left, right) => left.localeCompare(right));
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

function readOutputStreamTaskId(request: IncomingMessage): { ok: true; value: string } | { ok: false; reason: string } | null {
  if (request.method !== "GET" || request.url === undefined) {
    return null;
  }
  const match = /^\/tasks\/([^/]+)\/output\/stream$/u.exec(request.url);
  if (match === null) {
    return null;
  }
  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1]);
  } catch {
    return { ok: false, reason: "task output stream task_id must be URI-decodable" };
  }
  const validation = validateRequestedTaskId(taskId);
  return validation.ok ? { ok: true, value: taskId } : validation;
}

function readOptionalString(payload: DaemonPayload, field: string): { ok: true; value?: string } | { ok: false; reason: string } {
  if (!(field in payload) || payload[field] === undefined) {
    return { ok: true };
  }
  return typeof payload[field] === "string" ? { ok: true, value: payload[field] } : { ok: false, reason: `${field} must be a string` };
}

function readRequiredString(payload: DaemonPayload, field: string): { ok: true; value: string } | { ok: false; reason: string } {
  return typeof payload[field] === "string" && payload[field].trim() !== ""
    ? { ok: true, value: payload[field] }
    : { ok: false, reason: `${field} must be a non-empty string` };
}

function readOptionalPositiveInteger(payload: DaemonPayload, field: string): { ok: true; value?: number } | { ok: false; reason: string } {
  if (!(field in payload) || payload[field] === undefined) {
    return { ok: true };
  }
  const value = payload[field];
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1
    ? { ok: true, value }
    : { ok: false, reason: `${field} must be a positive integer` };
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
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
