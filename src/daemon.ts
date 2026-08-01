import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { analyzeTask } from "./analyze.js";
import { reconcileAdoptionsOnStartup } from "./adoption.js";
import { currentBuildIdentity } from "./build-identity.js";
import { checkpointTask } from "./checkpoint.js";
import { createTaskContract } from "./contract.js";
import { withInProcessDaemonTransport } from "./daemon-client.js";
import { removeDaemonState, writeDaemonState } from "./daemon-state.js";
import { formatErrorDetail } from "./error-detail.js";
import { EventBus } from "./event-bus.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { enqueueIntegrationPatch, integrateShadow } from "./integrate.js";
import { checkWriteIntent } from "./intent.js";
import { requestLeaseForContract, releaseLease } from "./lease.js";
import { proposeLearnedRoutingPolicy } from "./learned-routing.js";
import { proposeMemoryLesson } from "./memory-log.js";
import { reconcileProjectTempDirectories } from "./project-temp.js";
import { preflightQualityCancellationReconciliation, reconcileQualityCancellationsOnStartup } from "./quality-control.js";
import { findGitRoot } from "./repo.js";
import { evaluatePlanThrash } from "./plan.js";
import { readQuotaLedger } from "./resource-ledger.js";
import { markRunFailed, startRunTaskJob } from "./run.js";
import { runScout } from "./scout.js";
import { getStatus } from "./status.js";
import { submitTask } from "./submit.js";
import { requestTaskRedirect } from "./supervision.js";
import { validateRequestedTaskId } from "./task-id.js";
import { reconcileTaskCancellationOnStartup } from "./task-control.js";
import { admitValueQuality } from "./value-quality.js";
import { createTaskWorktree, removeTaskWorktree } from "./worktree.js";
import { executeWorkspaceAction } from "./workspace-actions.js";

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

  const qualityPreflight = await preflightQualityCancellationReconciliation(repoRoot);
  if (!qualityPreflight.ok) {
    console.error(`error: ${qualityPreflight.reason}`);
    return 1;
  }
  if (!qualityPreflight.value.blocked) {
    await reconcileProjectTempDirectories(repoRoot);
  }
  const adoptionReconcile = await reconcileAdoptionsOnStartup(repoRoot);
  if (!adoptionReconcile.ok) {
    console.error(`error: ${adoptionReconcile.reason}`);
    return 1;
  }
  const reconcileResult = await reconcileIncompleteRuns(repoRoot);
  if (!reconcileResult.ok) {
    console.error(`error: ${reconcileResult.reason}`);
    return 1;
  }
  if (!qualityPreflight.value.blocked) {
    const qualityReconcile = await reconcileQualityCancellationsOnStartup(repoRoot);
    if (!qualityReconcile.ok) {
      console.error(`error: ${qualityReconcile.reason}`);
      return 1;
    }
  }

  const buildId = await currentBuildIdentity();
  const server = createDaemonServer(repoRoot, buildId);
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
    repo_root: repoRoot,
    build_id: buildId
  });
  console.log(
    JSON.stringify({
      event: "daemon.ready",
      url: daemonUrl,
      repo_root: repoRoot,
      build_id: buildId
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

export function createDaemonServer(repoRoot: string, buildId: string) {
  const queue = new SerializedQueue();
  const eventBus = new EventBus();
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { ok: true, repo_root: repoRoot, build_id: buildId });
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

      const handler = routeHandler(repoRoot, request.method, request.url);
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

      const invokeInProcess = (endpoint: string, body: DaemonPayload) => {
        const localHandler = routeHandler(repoRoot, "POST", endpoint);
        return localHandler === null
          ? Promise.resolve({ ok: false as const, reason: `unknown in-process daemon route ${endpoint}` })
          : localHandler(body, eventBus);
      };
      const execute = () => withInProcessDaemonTransport(
        repoRoot,
        invokeInProcess,
        () => handler(payloadResult.value, eventBus)
      );
      const result = isQueueInterrupt(request, payloadResult.value)
        ? await execute()
        : await queue.run(execute);
      await eventBus.publishNewDurableEvents(repoRoot, previousEvents.value.length);
      writeJson(response, result.ok ? 200 : 400, result);
    } catch (error: unknown) {
      writeJson(response, 500, { ok: false, reason: formatErrorDetail(error, "unexpected daemon failure") });
    }
  });
}

function routeHandler(repoRoot: string, method: string | undefined, url: string | undefined): DaemonHandler | null {
  if (method === "POST" && url === "/lease/request-contract") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? requestLeaseForContract(repoRoot, taskId.value) : taskId;
    };
  }
  if (method === "POST" && url === "/contract/create") {
    return async (payload) => createTaskContract(repoRoot, payload.contract);
  }
  if (method === "POST" && url === "/status") {
    return async () => getStatus(repoRoot);
  }
  if (method === "POST" && url === "/resource/quota") {
    return async () => readQuotaLedger(repoRoot);
  }
  if (method === "POST" && url === "/memory/propose") {
    return async (payload) => proposeMemoryLesson(repoRoot, payload.proposal);
  }
  if (method === "POST" && url === "/routing/derive") {
    return async () => proposeLearnedRoutingPolicy(repoRoot);
  }
  if (method === "POST" && url === "/quality/admit") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      if (Object.keys(payload).some((key) => key !== "task_id" && key !== "strategy" && key !== "n")) {
        return { ok: false, reason: "value-quality admission payload contains an unsupported field" };
      }
      return admitValueQuality(repoRoot, taskId.value, {
        strategy: payload.strategy,
        ...(payload.n === undefined ? {} : { n: payload.n })
      });
    };
  }
  if (method === "POST" && url === "/workspace/action") {
    return async (payload) => executeWorkspaceAction(repoRoot, payload);
  }
  if (method === "POST" && url === "/checkpoint/task") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? checkpointTask(repoRoot, taskId.value) : taskId;
    };
  }
  if (method === "POST" && url === "/plan/thrash") {
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
  if (method === "POST" && url === "/lease/release") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? releaseLease(repoRoot, taskId.value) : taskId;
    };
  }
  if (method === "POST" && url === "/intent/check") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      return isRecord(payload.intent) ? checkWriteIntent(repoRoot, taskId.value, payload.intent) : { ok: false, reason: "intent must be a JSON object" };
    };
  }
  if (method === "POST" && url === "/supervision/redirect") {
    return async (payload) => requestTaskRedirect(repoRoot, payload);
  }
  if (method === "POST" && url === "/worktree/create") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? createTaskWorktree(repoRoot, taskId.value) : taskId;
    };
  }
  if (method === "POST" && url === "/worktree/remove") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? removeTaskWorktree(repoRoot, taskId.value) : taskId;
    };
  }
  if (method === "POST" && url === "/run") {
    return async (payload, eventBus) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      const tool = readOptionalString(payload, "tool");
      if (!tool.ok) {
        return tool;
      }
      const usageSessionId = readOptionalString(payload, "usage_session_id");
      if (!usageSessionId.ok) {
        return usageSessionId;
      }
      return startRunTaskJob(repoRoot, taskId.value, tool.value, {
        allowDangerousAdapter: payload.allow_dangerous_adapter === true,
        ...(usageSessionId.value === undefined ? {} : { usageSessionId: usageSessionId.value }),
        onEvent: (event) => eventBus.publishEvent(event),
        onOutput: (record) => eventBus.publishTaskOutput(record)
      });
    };
  }
  if (method === "POST" && url === "/run/mark-failed") {
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
  if (method === "POST" && url === "/scout/run") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      if (!taskId.ok) {
        return taskId;
      }
      const tool = readRequiredString(payload, "tool");
      if (!tool.ok) {
        return tool;
      }
      const usageSessionId = readOptionalString(payload, "usage_session_id");
      if (!usageSessionId.ok) {
        return usageSessionId;
      }
      return runScout(repoRoot, taskId.value, tool.value, {
        ...(usageSessionId.value === undefined ? {} : { usageSessionId: usageSessionId.value })
      });
    };
  }
  if (method === "POST" && url === "/submit") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? submitTask(repoRoot, taskId.value) : taskId;
    };
  }
  if (method === "POST" && url === "/analyze") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? analyzeTask(repoRoot, taskId.value) : taskId;
    };
  }
  if (method === "POST" && url === "/analyze/verdict") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? analyzeTask(repoRoot, taskId.value, { emitEvent: false }) : taskId;
    };
  }
  if (method === "POST" && url === "/integrate/shadow") {
    return async () => integrateShadow(repoRoot);
  }
  if (method === "POST" && url === "/integration/enqueue") {
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

  for (const taskId of tasksNeedingStartupReconciliation(events.value)) {
    const cancelRequested = events.value.some((event) => event.type === "task.cancel_requested" && event.task_id === taskId);
    if (cancelRequested) {
      const cancelled = await reconcileTaskCancellationOnStartup(repoRoot, taskId);
      if (!cancelled.ok) return cancelled;
      continue;
    }
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

function tasksNeedingStartupReconciliation(events: HivemindEvent[]): string[] {
  const tasks = new Set(startedWithoutTerminal(events));
  const openCancellation = new Set<string>();
  for (const event of events) {
    if (event.task_id === null) continue;
    if (event.type === "task.started") openCancellation.delete(event.task_id);
    if (event.type === "task.cancel_requested") openCancellation.add(event.task_id);
    if (event.type === "task.cancelled") openCancellation.delete(event.task_id);
  }
  for (const taskId of openCancellation) tasks.add(taskId);
  return [...tasks].sort((left, right) => left.localeCompare(right));
}

function isQueueInterrupt(request: IncomingMessage, payload: DaemonPayload): boolean {
  return request.method === "POST" &&
    request.url === "/workspace/action" &&
    (payload.type === "quality.cancel" || payload.type === "task.stop");
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
    if (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.cancelled") {
      running.delete(event.task_id);
      continue;
    }
    if (event.type === "task.paused" && event.data.reason === "quota_exhausted") {
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
