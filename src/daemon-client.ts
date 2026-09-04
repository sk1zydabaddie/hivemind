import { isRecord } from "./json.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { currentBuildIdentity } from "./build-identity.js";
import { daemonProcessIsLive, readDaemonState } from "./daemon-state.js";
import { formatErrorDetail } from "./error-detail.js";
import { isFailureCode, type FailureCode } from "./failure-code.js";
import {
  daemonAuthorization,
  isDaemonAuthToken,
  isLoopbackDaemonUrl
} from "./daemon-auth.js";

export type DaemonCallResult<T> =
  | { routed: false }
  | { routed: true; ok: true; value: T }
  | { routed: true; ok: false; reason: string; code?: FailureCode };

interface DaemonHealth {
  ok: true;
  repo_root: string;
  build_id: string;
}

interface DaemonConnection {
  url: string;
  authToken: string;
}

type InProcessDaemonResult = { ok: true; value: unknown } | { ok: false; reason: string; code?: FailureCode };

interface InProcessDaemonContext {
  repo_root: string;
  invoke: (endpoint: string, body: Record<string, unknown>) => Promise<InProcessDaemonResult>;
}

const inProcessDaemonContext = new AsyncLocalStorage<InProcessDaemonContext>();

export async function withInProcessDaemonTransport<T>(
  repoRoot: string,
  invoke: InProcessDaemonContext["invoke"],
  action: () => Promise<T>
): Promise<T> {
  return inProcessDaemonContext.run({ repo_root: repoRoot, invoke }, action);
}

export async function callDaemonIfConfigured<T>(
  repoRoot: string,
  endpoint: string,
  body: Record<string, unknown>
): Promise<DaemonCallResult<T>> {
  const local = inProcessDaemonContext.getStore();
  if (local !== undefined) {
    if (!(await sameRepoRoot(repoRoot, local.repo_root))) {
      return { routed: true, ok: false, reason: "in-process daemon context belongs to a different git repository root" };
    }
    const result = await local.invoke(endpoint, body);
    return result.ok
      ? { routed: true, ok: true, value: result.value as T }
      : { routed: true, ok: false, reason: result.reason, ...(result.code === undefined ? {} : { code: result.code }) };
  }

  const connectionResult = await resolveDaemonConnection(repoRoot);
  if (!connectionResult.ok) {
    return { routed: true, ok: false, reason: connectionResult.reason };
  }
  if (connectionResult.value === null) {
    return { routed: false };
  }
  const connection = connectionResult.value;

  const healthResult = await requestJson<DaemonHealth>(
    `${connection.url}/health`,
    { method: "GET" },
    connection.authToken
  );
  if (!healthResult.ok) {
    return { routed: true, ok: false, reason: healthResult.reason };
  }
  if (!(await sameRepoRoot(repoRoot, healthResult.value.repo_root))) {
    return { routed: true, ok: false, reason: "daemon repo_root does not match the current git repository root" };
  }
  const expectedBuildId = await currentBuildIdentity();
  if (healthResult.value.build_id !== expectedBuildId) {
    return {
      routed: true,
      ok: false,
      reason: `daemon build mismatch: running ${healthResult.value.build_id || "unknown"}, expected ${expectedBuildId}; restart the daemon before continuing`
    };
  }

  const result = await requestJson<{ ok: true; value: T } | { ok: false; reason: string; code?: FailureCode }>(
    `${connection.url}${endpoint}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    connection.authToken
  );
  if (!result.ok) {
    return {
      routed: true,
      ok: false,
      reason: result.reason,
      ...(result.code === undefined ? {} : { code: result.code })
    };
  }
  if (!isDaemonResult(result.value)) {
    return { routed: true, ok: false, reason: "daemon returned an invalid response" };
  }
  return result.value.ok
    ? { routed: true, ok: true, value: result.value.value as T }
    : {
        routed: true,
        ok: false,
        reason: result.value.reason,
        ...(result.value.code === undefined ? {} : { code: result.value.code })
      };
}

export async function callDaemonRequired<T>(
  repoRoot: string,
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ ok: true; value: T } | { ok: false; reason: string; code?: FailureCode }> {
  const result = await callDaemonIfConfigured<T>(repoRoot, endpoint, body);
  if (!result.routed) {
    return { ok: false, reason: "HIVEMIND_DAEMON_URL is required for MCP tool execution" };
  }
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, reason: result.reason, ...(result.code === undefined ? {} : { code: result.code }) };
}

function normalizeDaemonUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

async function resolveDaemonConnection(
  repoRoot: string
): Promise<{ ok: true; value: DaemonConnection | null } | { ok: false; reason: string }> {
  const configured = normalizeDaemonUrl(process.env.HIVEMIND_DAEMON_URL);
  if (configured !== null) {
    if (!isLoopbackDaemonUrl(configured)) {
      return {
        ok: false,
        reason: "HIVEMIND_DAEMON_URL must be an HTTP loopback address with an explicit port"
      };
    }
    const configuredToken = process.env.HIVEMIND_DAEMON_TOKEN?.trim();
    if (isDaemonAuthToken(configuredToken)) {
      return { ok: true, value: { url: configured, authToken: configuredToken } };
    }
    const stateResult = await readDaemonState(repoRoot);
    if (!stateResult.ok) {
      return stateResult;
    }
    const stateUrl = normalizeDaemonUrl(stateResult.value?.url);
    if (
      stateResult.value !== null &&
      stateUrl === configured &&
      daemonProcessIsLive(stateResult.value.pid)
    ) {
      return {
        ok: true,
        value: { url: configured, authToken: stateResult.value.auth_token }
      };
    }
    return {
      ok: false,
      reason: "HIVEMIND_DAEMON_TOKEN is required when HIVEMIND_DAEMON_URL does not match this project's live daemon record"
    };
  }
  const stateResult = await readDaemonState(repoRoot);
  if (!stateResult.ok) {
    return stateResult;
  }
  if (stateResult.value === null) {
    return { ok: true, value: null };
  }
  if (!daemonProcessIsLive(stateResult.value.pid)) {
    return { ok: true, value: null };
  }
  const discovered = normalizeDaemonUrl(stateResult.value.url);
  return discovered === null
    ? { ok: false, reason: "live daemon state has an invalid URL" }
    : {
        ok: true,
        value: { url: discovered, authToken: stateResult.value.auth_token }
      };
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  authToken: string
): Promise<{ ok: true; value: T } | { ok: false; reason: string; code?: FailureCode }> {
  let response: Response;
  try {
    response = await fetch(url, withDaemonHeaders(init, authToken));
  } catch (error: unknown) {
    return { ok: false, reason: `daemon request failed: ${formatErrorDetail(error, "unknown error")}` };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "daemon returned invalid JSON" };
  }

  if (!response.ok) {
    const code = readCode(parsed);
    return { ok: false, reason: readReason(parsed), ...(code === undefined ? {} : { code }) };
  }
  return { ok: true, value: parsed as T };
}

function withDaemonHeaders(init: RequestInit, authToken: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  headers.set("authorization", daemonAuthorization(authToken));
  return { ...init, headers };
}

async function sameRepoRoot(left: string, right: string): Promise<boolean> {
  try {
    const [leftReal, rightReal] = await Promise.all([realpath(left), realpath(right)]);
    const leftResolved = path.resolve(leftReal);
    const rightResolved = path.resolve(rightReal);
    return process.platform === "win32" ? leftResolved.toLowerCase() === rightResolved.toLowerCase() : leftResolved === rightResolved;
  } catch {
    return false;
  }
}

function isDaemonResult(value: unknown): value is { ok: true; value: unknown } | { ok: false; reason: string; code?: FailureCode } {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  return value.ok
    ? "value" in value
    : typeof value.reason === "string" && (value.code === undefined || isFailureCode(value.code));
}

function readReason(value: unknown): string {
  return isRecord(value) && typeof value.reason === "string" ? value.reason : "daemon request failed";
}

function readCode(value: unknown): FailureCode | undefined {
  return isRecord(value) && isFailureCode(value.code) ? value.code : undefined;
}
