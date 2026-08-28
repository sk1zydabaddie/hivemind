import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, stat, truncate } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { withPathLock } from "./lease-lock.js";

/**
 * Append-only JSONL trails, and what has to be true of them.
 *
 * INVARIANT: a trail is the durable record something else derives a guarantee
 * from, so a partial write must never be observable -- a reader sees all of a
 * record or none of it -- and a damaged trail must be recoverable rather than
 * terminal.
 *
 * Two things were relied on that are not true:
 *
 * 1. "One complete JSON line in one O_APPEND write" holds only while a line is
 *    small enough to be written in one go. A `human.guidance_recorded` event
 *    with a full 20,000-character message serialises to about 40,000 bytes,
 *    and worker output lines of 23,408 bytes are in this repository's own
 *    captured trail. Node's appendFile loops over partial writes, and another
 *    process can append between iterations.
 *
 * 2. In-process promise queues serialise appends within one process only. The
 *    daemon, the CLI and the MCP server are separate processes writing the
 *    same files.
 *
 * So appends take a cross-process lock. That closes interleaving, but it
 * cannot close everything: a process that dies mid-write still leaves a
 * partial line behind. That residue is always the LAST line, which is what
 * makes recovery tractable and is why repairing is the other half rather than
 * a nicety.
 */

/** Long enough for a large append to complete, short enough to surface a wedge. */
const appendLockTimeoutMs = 10_000;

/**
 * A reader that races a live append sees a trailing partial line, and so does
 * a reader looking at crash residue. They are indistinguishable in one glance
 * and completely different problems, so a trailing partial is re-read a few
 * times before it is called damage: a live append resolves in milliseconds,
 * crash residue does not.
 */
const trailingPartialRetries = 5;
const trailingPartialRetryMs = 20;

export type TrailDamageKind = "incomplete_trailing_line" | "invalid_json" | "invalid_record";

export interface TrailDamage {
  /** Repository-relative, so the diagnosis names a file a person can open. */
  file: string;
  /** 1-indexed, matching what an editor shows. */
  line: number;
  byte_offset: number;
  kind: TrailDamageKind;
  /**
   * True only for an interrupted append. A record in the MIDDLE of a trail may
   * be two writes interleaved, so its bytes can belong to two real records and
   * discarding it would discard something that did happen.
   */
  repairable: boolean;
  /** How many records precede the damage and are known good. */
  intact_records: number;
  detail: string;
  repair_command: string | null;
}

export interface TrailReadFailure {
  ok: false;
  reason: string;
  damage?: TrailDamage;
}

export interface TrailRepair {
  file: string;
  quarantine_path: string;
  removed_bytes: number;
  intact_records: number;
}

export type TrailResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Appends one complete line under a cross-process lock, then fsyncs.
 *
 * The line is written with a single write() on an O_APPEND handle and the
 * byte count is checked, so a short write is reported rather than silently
 * retried into a torn line.
 */
export async function appendTrailLine(
  trailPath: string,
  line: string,
  lockTimeoutMs = appendLockTimeoutMs
): Promise<TrailResult<void>> {
  await mkdir(path.dirname(trailPath), { recursive: true });
  return withPathLock<void>(
    `${trailPath}.lock`,
    async () => {
      const payload = Buffer.from(line, "utf8");
      const handle = await open(trailPath, "a");
      try {
        const { bytesWritten } = await handle.write(payload, 0, payload.length);
        if (bytesWritten !== payload.length) {
          return {
            ok: false,
            reason: `partial write appending to ${path.basename(trailPath)}: wrote ${bytesWritten} of ${payload.length} bytes`
          };
        }
        // Durable before the lock is released, so a reader that acquires the
        // lock next cannot see a record the filesystem has not committed.
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { ok: true, value: undefined };
    },
    { timeoutMs: lockTimeoutMs }
  );
}

/**
 * Reads a trail, returning either every record or a precise diagnosis.
 *
 * Never skips a record. A skipped record is a lost guarantee, so anything that
 * cannot be parsed stops the read and is described instead.
 */
/**
 * What has already been parsed from a trail, so the next read does not do it
 * again.
 *
 * WHY THIS EXISTS. The event trail is read whole on every projection and every
 * inspection -- 79 call sites -- and it is the one file in a project that grows
 * without bound: 9.4MB after 33 tasks, re-read and re-validated from byte zero
 * every time. Daily use on one project makes that the dominant cost of merely
 * looking at the screen.
 *
 * WHY NOT A CAP. Capping or rotating means deciding which records a
 * reconstruction no longer needs, and this trail is the thing state is rebuilt
 * FROM: spend totals, consumed guidance, integrated task ids, run history and
 * memory evidence are all derived by reading across the whole file. There is no
 * safe general answer to "which of these is disposable", and guessing would
 * trade a performance problem for a correctness one. The expensive part was
 * never storage; it was re-parsing.
 *
 * SO: parse each record once. A trail is append-only under a lock, so bytes
 * already consumed cannot change -- only new bytes arrive. The cache holds the
 * records, how many bytes produced them, and a hash of the last 4KB of those
 * bytes. A read then stats the file and does one of three things:
 *
 *   - same size, boundary matches  -> return the cached records, reading nothing
 *   - grown, boundary matches      -> parse ONLY the new bytes and append
 *   - anything else                -> full read, and reseed
 *
 * The third case is the whole safety argument. A shrink or a changed boundary
 * means an assumption failed -- a repair truncated a partial line, the file was
 * replaced, a clone arrived -- and the answer is to re-read rather than to
 * reason about it. Damage always goes through the full path too, so the line
 * number and byte offset in a diagnosis stay exactly what they were.
 *
 * The returned array is a copy. Callers own their result and several sort it in
 * place; handing out the cached array would let one caller reorder every later
 * reader's history.
 */
interface TrailCacheEntry<T> {
  consumedBytes: number;
  boundaryHash: string;
  records: T[];
}

const trailCache = new Map<string, TrailCacheEntry<unknown>>();
/* Bounded because the test suite creates thousands of temporary repositories in
   one process. Small because a daemon serves one project at a time. */
const trailCacheLimit = 8;
const boundaryWindowBytes = 4096;

function rememberTrail<T>(trailPath: string, entry: TrailCacheEntry<T>): void {
  if (!trailCache.has(trailPath) && trailCache.size >= trailCacheLimit) {
    const oldest = trailCache.keys().next();
    if (!oldest.done) trailCache.delete(oldest.value);
  }
  trailCache.set(trailPath, entry as TrailCacheEntry<unknown>);
}

async function boundaryHashAt(trailPath: string, consumedBytes: number): Promise<string | null> {
  if (consumedBytes === 0) return "empty";
  const length = Math.min(boundaryWindowBytes, consumedBytes);
  const buffer = Buffer.alloc(length);
  const handle = await open(trailPath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, consumedBytes - length);
    if (bytesRead !== length) return null;
  } finally {
    await handle.close();
  }
  return createHash("sha256").update(buffer).digest("hex");
}

/** The appended bytes only, or null when the fast path cannot be taken. */
async function readAppendedBytes(
  trailPath: string,
  from: number,
  to: number
): Promise<string | null> {
  const length = to - from;
  if (length <= 0) return null;
  const buffer = Buffer.alloc(length);
  const handle = await open(trailPath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    if (bytesRead !== length) return null;
  } finally {
    await handle.close();
  }
  return buffer.toString("utf8");
}

export async function readTrail<T>(
  _repoRoot: string,
  trailPath: string,
  relativePath: string,
  validate: (value: unknown) => { ok: true } | { ok: false; reason: string },
  repairCommand: string
): Promise<{ ok: true; value: T[] } | TrailReadFailure> {
  const cached = trailCache.get(trailPath) as TrailCacheEntry<T> | undefined;
  if (cached !== undefined) {
    const served = await serveFromCache<T>(trailPath, cached, validate);
    if (served !== null) return { ok: true, value: served };
  }

  for (let attempt = 0; ; attempt += 1) {
    let content: string;
    try {
      content = await readFile(trailPath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        trailCache.delete(trailPath);
        return { ok: true, value: [] };
      }
      throw error;
    }

    const parsed = parseTrail<T>(content, relativePath, validate, repairCommand);
    if (parsed.ok) {
      const consumedBytes = Buffer.byteLength(content, "utf8");
      const boundaryHash = await boundaryHashAt(trailPath, consumedBytes).catch(() => null);
      if (boundaryHash !== null) {
        rememberTrail<T>(trailPath, { consumedBytes, boundaryHash, records: [...parsed.value] });
      }
      return parsed;
    }
    /* Never cache a damaged read: the next call has to see the damage too. */
    trailCache.delete(trailPath);
    if (parsed.damage?.kind !== "incomplete_trailing_line") {
      return parsed;
    }
    if (attempt >= trailingPartialRetries) {
      return parsed;
    }
    await sleep(trailingPartialRetryMs);
  }
}

/** The cached records plus whatever was appended, or null to read it all. */
async function serveFromCache<T>(
  trailPath: string,
  cached: TrailCacheEntry<T>,
  validate: (value: unknown) => { ok: true } | { ok: false; reason: string }
): Promise<T[] | null> {
  let size: number;
  try {
    size = (await stat(trailPath)).size;
  } catch {
    trailCache.delete(trailPath);
    return null;
  }
  if (size < cached.consumedBytes) {
    trailCache.delete(trailPath);
    return null;
  }
  const boundary = await boundaryHashAt(trailPath, cached.consumedBytes).catch(() => null);
  if (boundary === null || boundary !== cached.boundaryHash) {
    trailCache.delete(trailPath);
    return null;
  }
  if (size === cached.consumedBytes) return [...cached.records];

  const appended = await readAppendedBytes(trailPath, cached.consumedBytes, size).catch(() => null);
  /* A tail with no closing newline is an append in flight. The full path owns
     that case: it has the retry and the damage report. */
  if (appended === null || !appended.endsWith("\n")) return null;

  const added: T[] = [];
  for (const line of appended.split("\n")) {
    const raw = line.replace(/\r$/u, "");
    if (raw.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      /* Damaged. Hand it to the full path so the diagnosis carries the real
         line number and byte offset rather than tail-relative ones. */
      trailCache.delete(trailPath);
      return null;
    }
    if (!validate(value).ok) {
      trailCache.delete(trailPath);
      return null;
    }
    added.push(value as T);
  }

  const records = [...cached.records, ...added];
  const boundaryHash = await boundaryHashAt(trailPath, size).catch(() => null);
  if (boundaryHash === null) {
    trailCache.delete(trailPath);
    return null;
  }
  rememberTrail<T>(trailPath, { consumedBytes: size, boundaryHash, records });
  return [...records];
}

function parseTrail<T>(
  content: string,
  relativePath: string,
  validate: (value: unknown) => { ok: true } | { ok: false; reason: string },
  repairCommand: string
): { ok: true; value: T[] } | TrailReadFailure {
  const records: T[] = [];
  let offset = 0;
  let lineNumber = 0;

  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    if (newline === -1) {
      const damage: TrailDamage = {
        file: relativePath,
        line: lineNumber + 1,
        byte_offset: Buffer.byteLength(content.slice(0, offset), "utf8"),
        kind: "incomplete_trailing_line",
        repairable: true,
        intact_records: records.length,
        detail:
          "the last line has no newline terminator, which is what an append interrupted part-way through leaves behind",
        repair_command: repairCommand
      };
      return { ok: false, reason: describeDamage(damage), damage };
    }

    const raw = content.slice(offset, newline).replace(/\r$/u, "");
    lineNumber += 1;
    const lineStart = offset;
    offset = newline + 1;
    if (raw.length === 0) {
      continue;
    }

    const damageAt = (kind: TrailDamageKind, detail: string): TrailReadFailure => {
      const damage: TrailDamage = {
        file: relativePath,
        line: lineNumber,
        byte_offset: Buffer.byteLength(content.slice(0, lineStart), "utf8"),
        kind,
        // Not the last line, so this is not an interrupted append. Its bytes
        // may belong to two interleaved writes and are not ours to discard.
        repairable: false,
        intact_records: records.length,
        detail,
        repair_command: null
      };
      return { ok: false, reason: describeDamage(damage), damage };
    };

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return damageAt("invalid_json", "the line is not parseable JSON");
    }
    const validation = validate(value);
    if (!validation.ok) {
      return damageAt("invalid_record", validation.reason);
    }
    records.push(value as T);
  }

  return { ok: true, value: records };
}

function describeDamage(damage: TrailDamage): string {
  const where = `${damage.file} line ${damage.line} (byte ${damage.byte_offset})`;
  const intact = `${damage.intact_records} record${damage.intact_records === 1 ? "" : "s"} before it are intact`;
  if (damage.repairable && damage.repair_command !== null) {
    return `${where} is an incomplete trailing record: ${damage.detail}. ${intact}. Nothing durably committed is lost, because no reader can observe a record that has no newline. Run \`${damage.repair_command}\` to quarantine a copy and remove it.`;
  }
  return `${where} is damaged and cannot be repaired automatically: ${damage.detail}. ${intact}. This is not a trailing partial write, so its bytes may belong to two interleaved records and discarding it could discard a record that really happened. Inspect the file and decide by hand.`;
}

/**
 * Removes an interrupted trailing append, and nothing else.
 *
 * Takes the same lock the appenders take, so it cannot truncate underneath a
 * write in flight. Copies the whole trail to a timestamped quarantine file
 * before touching it: the point is to make the trail readable again, never to
 * destroy the evidence of what went wrong.
 */
export async function repairTrail(
  trailPath: string,
  relativePath: string,
  damage: TrailDamage,
  timestamp: string
): Promise<TrailResult<TrailRepair>> {
  if (!damage.repairable) {
    return { ok: false, reason: `refusing to repair ${relativePath}: ${describeDamage(damage)}` };
  }
  return withPathLock<TrailRepair>(
    `${trailPath}.lock`,
    async () => {
      const content = await readFile(trailPath, "utf8");
      const lastNewline = content.lastIndexOf("\n");
      const keepBytes = lastNewline === -1 ? 0 : Buffer.byteLength(content.slice(0, lastNewline + 1), "utf8");
      const totalBytes = Buffer.byteLength(content, "utf8");
      if (keepBytes === totalBytes) {
        // Re-checked under the lock: whatever looked partial has since been
        // completed by the writer that was mid-append. Nothing to repair, and
        // truncating now would destroy a real record.
        return { ok: false, reason: `${relativePath} is complete; nothing to repair` };
      }

      const quarantinePath = `${trailPath}.damaged-${timestamp}`;
      await copyFile(trailPath, quarantinePath);
      await truncate(trailPath, keepBytes);
      return {
        ok: true,
        value: {
          file: relativePath,
          quarantine_path: quarantinePath,
          removed_bytes: totalBytes - keepBytes,
          intact_records: damage.intact_records
        }
      };
    },
    { timeoutMs: appendLockTimeoutMs }
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
