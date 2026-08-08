import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { getProcessLiveness, type ProcessLiveness } from "./process-liveness.js";

const defaultRetryMs = 25;
const defaultTimeoutMs = 2000;

interface LeaseLockRecord {
  version: 1;
  lock_id: string;
  pid: number;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtime_ns: bigint;
  ctime_ns: bigint;
}

export interface LeaseLockObservation {
  identity: FileIdentity;
  raw: string;
  record: LeaseLockRecord;
}

export type LeaseLockInspection =
  | { status: "valid"; observation: LeaseLockObservation }
  | { status: "missing" }
  | { status: "uncertain"; reason: string };

export interface LeaseLockOptions {
  retryMs?: number;
  timeoutMs?: number;
  probeLiveness?: (pid: number) => ProcessLiveness;
}

type LeaseLockResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function withLeaseLock<T>(
  repoRoot: string,
  action: () => Promise<LeaseLockResult<T>>,
  options: LeaseLockOptions = {}
): Promise<LeaseLockResult<T>> {
  return withPathLock(activeLeaseLockPath(repoRoot), action, options);
}

/**
 * The same link()-based exclusion the lease store uses, against any path.
 *
 * Exclusion comes from link() failing when the target exists, which is atomic
 * on every filesystem this runs on and works across processes -- the in-process
 * promise queues elsewhere in the codebase do not, because the daemon, the CLI
 * and the MCP server are separate processes appending to the same files.
 *
 * A holder that dies is reaped by PID liveness rather than by a timeout, so a
 * crashed writer does not wedge every later one.
 */
export async function withPathLock<T>(
  lockPath: string,
  action: () => Promise<LeaseLockResult<T>>,
  options: LeaseLockOptions = {}
): Promise<LeaseLockResult<T>> {
  const reaperPath = `${lockPath}.reaper`;
  const retryMs = options.retryMs ?? defaultRetryMs;
  const deadline = Date.now() + (options.timeoutMs ?? defaultTimeoutMs);
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    if (await pathExistsOrIsUncertain(reaperPath)) {
      const waitResult = await waitForLeaseLock(deadline, retryMs);
      if (!waitResult.ok) {
        return waitResult;
      }
      continue;
    }

    const acquired = await publishExclusiveLock(lockPath, createLeaseLockRecord());
    if (acquired !== null) {
      if (await pathExistsOrIsUncertain(reaperPath)) {
        const released = await removeLockIfUnchanged(lockPath, acquired);
        if (!released) {
          return { ok: false, reason: `lock ownership changed while yielding to stale-lock cleanup: ${lockPath}` };
        }
        const waitResult = await waitForLeaseLock(deadline, retryMs);
        if (!waitResult.ok) {
          return waitResult;
        }
        continue;
      }

      try {
        return await action();
      } finally {
        const released = await removeLockIfUnchanged(lockPath, acquired);
        if (!released) {
          throw new Error(`lock ownership changed before release: ${lockPath}`);
        }
      }
    }

    const staleRemoved = await tryRemoveStaleLeaseLock(lockPath, options);
    if (staleRemoved) {
      continue;
    }
    const waitResult = await waitForLeaseLock(deadline, retryMs);
    if (!waitResult.ok) {
      return waitResult;
    }
  }
}

export async function tryRemoveStaleLeaseLock(lockPath: string, options: LeaseLockOptions = {}): Promise<boolean> {
  const inspection = await inspectLeaseLock(lockPath);
  if (inspection.status !== "valid") {
    return false;
  }
  const probeLiveness = options.probeLiveness ?? getProcessLiveness;
  if (probeLiveness(inspection.observation.record.pid) !== "dead") {
    return false;
  }
  return removeStaleLeaseLockIfUnchanged(lockPath, inspection.observation, options);
}

export async function removeStaleLeaseLockIfUnchanged(
  lockPath: string,
  observed: LeaseLockObservation,
  options: LeaseLockOptions = {}
): Promise<boolean> {
  const reaperPath = `${lockPath}.reaper`;
  const reaper = await publishExclusiveLock(reaperPath, createLeaseLockRecord());
  if (reaper === null) {
    return false;
  }

  try {
    const current = await inspectLeaseLock(lockPath);
    if (current.status !== "valid" || !sameObservation(current.observation, observed)) {
      return false;
    }
    const probeLiveness = options.probeLiveness ?? getProcessLiveness;
    if (probeLiveness(current.observation.record.pid) !== "dead") {
      return false;
    }
    return removeLockIfUnchanged(lockPath, current.observation);
  } finally {
    const released = await removeLockIfUnchanged(reaperPath, reaper);
    if (!released) {
      throw new Error("lease stale-lock cleanup guard ownership changed before release");
    }
  }
}

export async function inspectLeaseLock(lockPath: string): Promise<LeaseLockInspection> {
  let handle;
  try {
    handle = await open(lockPath, "r");
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT")
      ? { status: "missing" }
      : { status: "uncertain", reason: `could not open lease lock: ${errorMessage(error)}` };
  }

  let raw: string;
  let before: BigIntStats;
  let after: BigIntStats;
  try {
    before = await handle.stat({ bigint: true });
    raw = await handle.readFile("utf8");
    after = await handle.stat({ bigint: true });
  } catch (error: unknown) {
    return { status: "uncertain", reason: `could not inspect lease lock: ${errorMessage(error)}` };
  } finally {
    await handle.close();
  }

  if (!sameFileIdentity(toFileIdentity(before), toFileIdentity(after))) {
    return { status: "uncertain", reason: "lease lock changed while being inspected" };
  }

  let pathStats: BigIntStats;
  try {
    pathStats = await stat(lockPath, { bigint: true });
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT")
      ? { status: "missing" }
      : { status: "uncertain", reason: `could not verify lease lock identity: ${errorMessage(error)}` };
  }
  const identity = toFileIdentity(after);
  if (!sameFileIdentity(identity, toFileIdentity(pathStats))) {
    return { status: "uncertain", reason: "lease lock path changed while being inspected" };
  }

  const record = parseLeaseLockRecord(raw);
  if (record === null) {
    return { status: "uncertain", reason: "lease lock owner record is empty, partial, or invalid" };
  }
  return { status: "valid", observation: { identity, raw, record } };
}

function createLeaseLockRecord(): LeaseLockRecord {
  return {
    version: 1,
    lock_id: randomUUID(),
    pid: process.pid
  };
}

async function publishExclusiveLock(lockPath: string, record: LeaseLockRecord): Promise<LeaseLockObservation | null> {
  const directory = path.dirname(lockPath);
  await mkdir(directory, { recursive: true });
  const candidatePath = path.join(directory, `.${path.basename(lockPath)}.${record.lock_id}.candidate`);
  const raw = `${JSON.stringify(record)}\n`;
  const handle = await open(candidatePath, "wx", 0o600);
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    try {
      await link(candidatePath, lockPath);
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        return null;
      }
      throw error;
    }
  } finally {
    await rm(candidatePath, { force: true });
  }

  const inspection = await inspectLeaseLock(lockPath);
  if (
    inspection.status !== "valid" ||
    inspection.observation.raw !== raw ||
    inspection.observation.record.lock_id !== record.lock_id
  ) {
    throw new Error("atomically published lease lock could not be verified");
  }
  return inspection.observation;
}

async function removeLockIfUnchanged(lockPath: string, expected: LeaseLockObservation): Promise<boolean> {
  const current = await inspectLeaseLock(lockPath);
  if (current.status !== "valid" || !sameObservation(current.observation, expected)) {
    return false;
  }
  try {
    await rm(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function pathExistsOrIsUncertain(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    return !isNodeError(error, "ENOENT");
  }
}

async function waitForLeaseLock(
  deadline: number,
  retryMs: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (Date.now() >= deadline) {
    return { ok: false, reason: "could not acquire lease lock" };
  }
  await sleep(retryMs);
  return { ok: true };
}

function parseLeaseLockRecord(raw: string): LeaseLockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "lock_id" ||
    keys[1] !== "pid" ||
    keys[2] !== "version" ||
    value.version !== 1 ||
    typeof value.lock_id !== "string" ||
    value.lock_id.length === 0 ||
    !Number.isInteger(value.pid) ||
    Number(value.pid) <= 0
  ) {
    return null;
  }
  return {
    version: 1,
    lock_id: value.lock_id,
    pid: Number(value.pid)
  };
}

function sameObservation(left: LeaseLockObservation, right: LeaseLockObservation): boolean {
  return (
    left.raw === right.raw &&
    left.record.lock_id === right.record.lock_id &&
    left.record.pid === right.record.pid &&
    sameFileIdentity(left.identity, right.identity)
  );
}

function toFileIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtime_ns: stats.mtimeNs,
    ctime_ns: stats.ctimeNs
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtime_ns === right.mtime_ns &&
    left.ctime_ns === right.ctime_ns
  );
}

function activeLeaseLockPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "leases", "active.lock");
}

function leaseLockReaperPath(repoRoot: string): string {
  return `${activeLeaseLockPath(repoRoot)}.reaper`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
