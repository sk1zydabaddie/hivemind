import { rm } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { readJsonFile } from "./json.js";
import { processIsLiveOrUnknown } from "./process-liveness.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";
import { isDaemonAuthToken, isLoopbackDaemonUrl } from "./daemon-auth.js";

export interface DaemonState {
  version: 2;
  pid: number;
  url: string;
  repo_root: string;
  auth_token: string;
  build_id?: string;
  started_at: string;
}

export async function readDaemonState(repoRoot: string): Promise<{ ok: true; value: DaemonState | null } | { ok: false; reason: string }> {
  let raw: unknown;
  try {
    raw = await readJsonFile(daemonStatePath(repoRoot));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: null };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/daemon.json" };
    }
    throw error;
  }

  const validation = validateDaemonState(raw);
  return validation.ok ? { ok: true, value: raw as DaemonState } : validation;
}

export async function writeDaemonState(
  repoRoot: string,
  value: Omit<DaemonState, "version" | "started_at" | "build_id"> & { build_id: string }
): Promise<void> {
  await writeJsonAtomic(daemonStatePath(repoRoot), {
    version: 2,
    pid: value.pid,
    url: value.url,
    repo_root: value.repo_root,
    auth_token: value.auth_token,
    build_id: value.build_id,
    started_at: new Date().toISOString()
  });
}

export async function removeDaemonState(repoRoot: string): Promise<void> {
  await rm(daemonStatePath(repoRoot), { force: true });
}

export function daemonProcessIsLive(pid: number): boolean {
  return processIsLiveOrUnknown(pid);
}

function validateDaemonState(value: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "daemon state must be a JSON object" };
  }
  const gated = checkFormatVersion(value, formatVersions.daemonState, ".hivemind/daemon.json");
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  if (!Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid <= 0) {
    return { ok: false, reason: "daemon state pid must be a positive safe integer" };
  }
  if (!isLoopbackDaemonUrl(value.url)) {
    return { ok: false, reason: "daemon state url must be an HTTP loopback address with an explicit port" };
  }
  if (typeof value.repo_root !== "string" || value.repo_root.trim() === "") {
    return { ok: false, reason: "daemon state repo_root must be a non-empty string" };
  }
  if (!isDaemonAuthToken(value.auth_token)) {
    return { ok: false, reason: "daemon state auth_token must be a 256-bit base64url credential" };
  }
  if (value.build_id !== undefined && (typeof value.build_id !== "string" || !/^[a-f0-9]{64}$/u.test(value.build_id))) {
    return { ok: false, reason: "daemon state build_id must be a lowercase SHA-256 digest when present" };
  }
  if (typeof value.started_at !== "string" || Number.isNaN(Date.parse(value.started_at))) {
    return { ok: false, reason: "daemon state started_at must be an ISO timestamp string" };
  }
  return { ok: true };
}

function daemonStatePath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "daemon.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
