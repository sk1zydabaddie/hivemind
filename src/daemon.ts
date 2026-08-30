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
import type { FailureCode } from "./failure-code.js";
import { setTaskOutputPublisher } from "./output-stream.js";
import { EventBus } from "./event-bus.js";
import { readEvents, setEventPublisher } from "./events.js";
import { enqueueIntegrationPatch, integrateShadow } from "./integrate.js";
import { checkWriteIntent } from "./intent.js";
import { requestLeaseForContract, releaseLease } from "./lease.js";
import { ingestCapabilityCorpusEvidence, proposeLearnedRoutingPolicy } from "./learned-routing.js";
import { proposeMemoryLesson } from "./memory-log.js";
import { reconcileProjectTempDirectories } from "./project-temp.js";
import { preflightQualityCancellationReconciliation, reconcileQualityCancellationsOnStartup } from "./quality-control.js";
import { findGitRoot } from "./repo.js";
import { evaluatePlanThrash } from "./plan.js";
import { createCachedProcessLivenessProbe } from "./process-liveness.js";
import { readQuotaLedger, reconcileMeteredCallReservations } from "./resource-ledger.js";
import { markRunFailed, startRunTaskJob } from "./run.js";
import { runScout } from "./scout.js";
import { getStatus } from "./status.js";
import { submitTask } from "./submit.js";
import { requestTaskRedirect } from "./supervision.js";
import { validateRequestedTaskId } from "./task-id.js";
import { reconcileTaskRunsOnStartup } from "./task-control.js";
import { admitValueQuality } from "./value-quality.js";
import { createTaskWorktree, removeTaskWorktree } from "./worktree.js";
import { reconcileLeftoverWorktrees } from "./worktree-standing.js";
import { withPlainReason } from "./plain-reason.js";
import { executeWorkspaceAction } from "./workspace-actions.js";
import { daemonRequestStartsWork, UPDATE_COORDINATOR_PROTOCOL, withUpdateAdmission } from "./update-lease.js";
import {
  createDaemonAuthToken,
  daemonTokenMatches,
  isAllowedDaemonOrigin,
  isLoopbackDaemonHost
} from "./daemon-auth.js";

interface DaemonOptions {
  host: string;
  port: number;
}

type DaemonPayload = Record<string, unknown>;
type DaemonHandler = (
  payload: DaemonPayload,
  eventBus: EventBus
) => Promise<{ ok: true; value: unknown } | { ok: false; reason: string; code?: FailureCode }>;

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
  const startupLiveness = createCachedProcessLivenessProbe();
  const reservationReconcile = await reconcileMeteredCallReservations(repoRoot, { probeLiveness: startupLiveness });
  if (!reservationReconcile.ok) {
    console.error(`error: ${reservationReconcile.reason}`);
    return 1;
  }
  const adoptionReconcile = await reconcileAdoptionsOnStartup(repoRoot);
  if (!adoptionReconcile.ok) {
    console.error(`error: ${adoptionReconcile.reason}`);
    return 1;
  }
  const reconcileResult = await reconcileTaskRunsOnStartup(repoRoot, { probeLiveness: startupLiveness });
  if (!reconcileResult.ok) {
    console.error(`error: ${reconcileResult.reason}`);
    return 1;
  }
  /* The one leftover class the reconcilers above do not cover: a read-only
     plan task that finished clean keeps its worktree forever, and a worktree
     nothing owns closes the idleness proof permanently (A-37). Startup is the
     provably safe moment to remove them -- this process is the project's only
     writer, and the classification is grounded in the ratified plan. */
  const worktreeReconcile = await reconcileLeftoverWorktrees(repoRoot);
  if (!worktreeReconcile.ok) {
    console.error(`error: ${worktreeReconcile.reason}`);
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
  const authToken = createDaemonAuthToken();
  const server = createDaemonServer(repoRoot, buildId, authToken);
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
    auth_token: authToken,
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

export function createDaemonServer(repoRoot: string, buildId: string, authToken: string) {
  const queue = new SerializedQueue();
  const eventBus = new EventBus();
  setEventPublisher((event) => eventBus.publishEvent(event));
  /* Every task-output writer publishes through this, registered once rather
     than threaded per action -- see `setTaskOutputPublisher`. Without it a
     writer reached disk and no subscriber, which is how the drafting stream
     was invisible while its file was correct. */
  setTaskOutputPublisher((record) => eventBus.publishTaskOutput(record));
  return createServer(async (request, response) => {
    try {
      const target = requestTarget(request.url);
      if (!requestIsAuthenticated(request, target, authToken)) {
        writeJson(response, 401, { ok: false, reason: "daemon authentication required" }, {
          "www-authenticate": "Bearer"
        });
        return;
      }
      if (!hostIsAllowed(request.headers.host)) {
        writeJson(response, 403, { ok: false, reason: "daemon Host header is not loopback" });
        return;
      }
      if (!originIsAllowed(request.headers.origin)) {
        writeJson(response, 403, { ok: false, reason: "daemon Origin is not allowed" });
        return;
      }
      if (request.method === "POST" && !hasJsonContentType(request.headers["content-type"])) {
        writeJson(response, 415, { ok: false, reason: "daemon POST requests require application/json" });
        return;
      }

      if (request.method === "GET" && target.path === "/health") {
        writeJson(response, 200, {
          ok: true,
          repo_root: repoRoot,
          build_id: buildId,
          update_coordinator_protocol: UPDATE_COORDINATOR_PROTOCOL
        });
        return;
      }
      if (request.method === "GET" && target.path === "/events/stream") {
        await eventBus.stream(repoRoot, request, response);
        return;
      }
      const outputStreamTaskId = readOutputStreamTaskId(request.method, target.path);
      if (outputStreamTaskId !== null) {
        if (!outputStreamTaskId.ok) {
          writeJson(response, 400, { ok: false, reason: outputStreamTaskId.reason });
          return;
        }
        await eventBus.streamTaskOutput(repoRoot, outputStreamTaskId.value, request, response);
        return;
      }

      const handler = routeHandler(repoRoot, request.method, target.path);
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
      const executeAction = () => withInProcessDaemonTransport(
        repoRoot,
        invokeInProcess,
        () => handler(payloadResult.value, eventBus)
      );
      const execute = () => daemonRequestStartsWork(request.method, target.path, payloadResult.value)
        ? withUpdateAdmission(executeAction)
        : executeAction();
      const result = isConcurrentObservation(request.method, target.path, payloadResult.value) || isQueueInterrupt(request.method, target.path, payloadResult.value)
        ? await execute()
        : await queue.run(execute);
      await eventBus.publishNewDurableEvents(repoRoot, previousEvents.value.length);
      /* A refusal carries the sentence a person is shown, attached by the
         side that knows what the refusal means. Additive: `reason` is
         untouched for anything matching on it. */
      writeJson(response, result.ok ? 200 : 400, withPlainReason(result));
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
  if (method === "POST" && url === "/routing/corpus/ingest") {
    return async (payload) => {
      const corpusRunId = typeof payload.corpus_run_id === "string" ? payload.corpus_run_id : "";
      const includedProviders = Array.isArray(payload.included_providers)
        ? payload.included_providers.filter((provider): provider is string => typeof provider === "string")
        : undefined;
      return ingestCapabilityCorpusEvidence(repoRoot, corpusRunId, includedProviders);
    };
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
    return async (payload, _eventBus) => {
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
        /* Event and output publication live at their durable append points;
           route-local publishers would deliver every record twice. */
        onEvent: undefined,
        onOutput: undefined
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
    return async (payload) => integrateShadow(repoRoot, parseIntegrationQueueExpectation(payload));
  }
  if (method === "POST" && url === "/integration/enqueue") {
    return async (payload) => {
      const taskId = readTaskId(payload);
      return taskId.ok ? enqueueIntegrationPatch(repoRoot, taskId.value) : taskId;
    };
  }
  return null;
}

function isQueueInterrupt(method: string | undefined, path: string, payload: DaemonPayload): boolean {
  return method === "POST" &&
    path === "/workspace/action" &&
    (payload.type === "quality.cancel" || payload.type === "task.stop" || payload.type === "run.stop");
}

const concurrentWorkspaceObservations = new Set([
  "status.inspect",
  "trail.inspect",
  "change.inspect",
  "spec.review",
  "plan.review",
  "config.inspect",
  "files.list",
  "files.read",
  "checks.inspect",
  "accounts.inspect",
  "sharing.inspect",
  "provider.auth.inspect",
  "models.discover"
]);

/** Read-only observation must remain available while a provider process runs. */
function isConcurrentObservation(method: string | undefined, path: string, payload: DaemonPayload): boolean {
  if (method !== "POST") return false;
  if (path === "/status" || path === "/resource/quota") return true;
  return path === "/workspace/action" &&
    typeof payload.type === "string" &&
    concurrentWorkspaceObservations.has(payload.type);
}

function parseIntegrationQueueExpectation(payload: DaemonPayload) {
  if (payload.expected_task_ids === undefined && payload.expected_queue_sha256 === undefined) return undefined;
  return {
    expected_task_ids: Array.isArray(payload.expected_task_ids)
      ? payload.expected_task_ids.filter((entry): entry is string => typeof entry === "string")
      : [],
    expected_queue_sha256: typeof payload.expected_queue_sha256 === "string" ? payload.expected_queue_sha256 : ""
  };
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
      if (!isLoopbackDaemonHost(host)) {
        return { ok: false, reason: "daemon host must be 127.0.0.1 or localhost" };
      }
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

function readOutputStreamTaskId(method: string | undefined, path: string): { ok: true; value: string } | { ok: false; reason: string } | null {
  if (method !== "GET") {
    return null;
  }
  const match = /^\/tasks\/([^/]+)\/output\/stream$/u.exec(path);
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

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers
  });
  response.end(payload);
}

interface DaemonRequestTarget {
  path: string;
  query: URLSearchParams;
}

function requestTarget(raw: string | undefined): DaemonRequestTarget {
  const target = raw ?? "";
  const separator = target.indexOf("?");
  return separator === -1
    ? { path: target, query: new URLSearchParams() }
    : {
        path: target.slice(0, separator),
        query: new URLSearchParams(target.slice(separator + 1))
      };
}

function requestIsAuthenticated(
  request: IncomingMessage,
  target: DaemonRequestTarget,
  expected: string
): boolean {
  const authorization = readSingleHeader(request.headers.authorization);
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (daemonTokenMatches(bearer, expected)) {
    return true;
  }
  if (!isStreamRequest(request.method, target.path)) {
    return false;
  }
  const streamTokens = target.query.getAll("access_token");
  return streamTokens.length === 1 && daemonTokenMatches(streamTokens[0], expected);
}

function isStreamRequest(method: string | undefined, path: string): boolean {
  return method === "GET" &&
    (path === "/events/stream" || /^\/tasks\/[^/]+\/output\/stream$/u.test(path));
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function originIsAllowed(value: string | string[] | undefined): boolean {
  return !Array.isArray(value) && isAllowedDaemonOrigin(value);
}

function hostIsAllowed(host: string | undefined): boolean {
  if (host === undefined) return false;
  const normalized = host.toLowerCase();
  return /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/u.test(normalized);
}

function hasJsonContentType(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
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
