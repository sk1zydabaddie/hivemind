import { realpath } from "node:fs/promises";
import path from "node:path";

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
  const baseUrl = normalizeDaemonUrl(process.env.HIVEMIND_DAEMON_URL);
  if (baseUrl === null) {
    return { routed: false };
  }

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

function normalizeDaemonUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

async function requestJson<T>(url: string, init: RequestInit): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error: unknown) {
    return { ok: false, reason: `daemon request failed: ${error instanceof Error ? error.message : "unknown error"}` };
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
