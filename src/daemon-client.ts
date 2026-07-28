import { realpath } from "node:fs/promises";
import path from "node:path";
import { daemonProcessIsLive, readDaemonState } from "./daemon-state.js";
import { formatErrorDetail } from "./error-detail.js";

export type DaemonCallResult<T> =
  | { routed: false }
  | { routed: true; ok: true; value: T }
  | { routed: true; ok: false; reason: string };

interface DaemonHealth {
  ok: true;
  repo_root: string;
}

export async function callDaemonIfConfigured<T>(
  repoRoot: string,
  endpoint: string,
  body: Record<string, unknown>
): Promise<DaemonCallResult<T>> {
  const addressResult = await resolveDaemonAddress(repoRoot);
  if (!addressResult.ok) {
    return { routed: true, ok: false, reason: addressResult.reason };
  }
  if (addressResult.value === null) {
    return { routed: false };
  }
  const baseUrl = addressResult.value;

  const healthResult = await requestJson<DaemonHealth>(`${baseUrl}/health`, { method: "GET" });
  if (!healthResult.ok) {
    return { routed: true, ok: false, reason: healthResult.reason };
  }
  if (!(await sameRepoRoot(repoRoot, healthResult.value.repo_root))) {
    return { routed: true, ok: false, reason: "daemon repo_root does not match the current git repository root" };
  }

  const result = await requestJson<{ ok: true; value: T } | { ok: false; reason: string }>(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!result.ok) {
    return { routed: true, ok: false, reason: result.reason };
  }
  if (!isDaemonResult(result.value)) {
    return { routed: true, ok: false, reason: "daemon returned an invalid response" };
  }
  return result.value.ok ? { routed: true, ok: true, value: result.value.value as T } : { routed: true, ok: false, reason: result.value.reason };
}

export async function callDaemonRequired<T>(
  repoRoot: string,
  endpoint: string,
  body: Record<string, unknown>
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const result = await callDaemonIfConfigured<T>(repoRoot, endpoint, body);
  if (!result.routed) {
    return { ok: false, reason: "HIVEMIND_DAEMON_URL is required for MCP tool execution" };
  }
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
}

function normalizeDaemonUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

async function resolveDaemonAddress(repoRoot: string): Promise<{ ok: true; value: string | null } | { ok: false; reason: string }> {
  const configured = normalizeDaemonUrl(process.env.HIVEMIND_DAEMON_URL);
  if (configured !== null) {
    return { ok: true, value: configured };
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
    : { ok: true, value: discovered };
}

async function requestJson<T>(url: string, init: RequestInit): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetch(url, withConnectionClose(init));
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
    return { ok: false, reason: readReason(parsed) };
  }
  return { ok: true, value: parsed as T };
}

function withConnectionClose(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
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

function isDaemonResult(value: unknown): value is { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  return value.ok ? "value" in value : typeof value.reason === "string";
}

function readReason(value: unknown): string {
  return isRecord(value) && typeof value.reason === "string" ? value.reason : "daemon request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
