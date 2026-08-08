import { copyFile, mkdir, open, readFile, truncate } from "node:fs/promises";
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
export async function readTrail<T>(
  repoRoot: string,
  trailPath: string,
  relativePath: string,
  validate: (value: unknown) => { ok: true } | { ok: false; reason: string },
  repairCommand: string
): Promise<{ ok: true; value: T[] } | TrailReadFailure> {
  for (let attempt = 0; ; attempt += 1) {
    let content: string;
    try {
      content = await readFile(trailPath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return { ok: true, value: [] };
      }
      throw error;
    }

    const parsed = parseTrail<T>(content, relativePath, validate, repairCommand);
    if (parsed.ok || parsed.damage?.kind !== "incomplete_trailing_line") {
      return parsed;
    }
    if (attempt >= trailingPartialRetries) {
      return parsed;
    }
    await sleep(trailingPartialRetryMs);
  }
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
