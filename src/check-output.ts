import { mkdir, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { writeFileAtomic } from "./atomic.js";
import type { NamedCheckResult } from "./check-runner.js";

/**
 * What the project's checks actually printed, kept so a person can read it.
 *
 * This exists because of what an embedded terminal was asked for and refused
 * for. The real need underneath "give me a shell" is *seeing why the checks
 * failed* — and that need does not require a shell, because Hivemind already
 * ran the command. It only required keeping the output.
 *
 * Until now it did not. `verification.completed` recorded each check's `id`,
 * `command` and `exit_code`, and dropped stdout and stderr on the floor. A
 * person could see THAT `npm test` exited 1 and never what it said.
 *
 * The output is stored beside the trail rather than inside it, exactly as a
 * patch bundle is. An event carrying a megabyte of test output would be a
 * durable record nobody can append quickly and every reader has to page past;
 * the event keeps the identifier and the file keeps the bytes.
 *
 * Read-only afterwards, and never re-run: this is a record of what happened,
 * not a way to make it happen again. Re-running is `verification.rerun`, which
 * is a different action with a different gate.
 */

/** Per stream, per check. A runaway log cannot become the trail's problem. */
export const CHECK_OUTPUT_LIMIT_BYTES = 256 * 1024;

export interface StoredCheckOutput {
  id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  /** True when either stream was longer than the limit and was cut. */
  truncated: boolean;
}

export interface CheckOutputRun {
  checks_run_id: string;
  checks: StoredCheckOutput[];
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

const CHECKS_DIR = ".hivemind/checks";

function runDirectory(repoRoot: string, checksRunId: string): string {
  return path.join(repoRoot, ...CHECKS_DIR.split("/"), checksRunId);
}

/* The identifier is generated here rather than derived from the checks, so two
   runs of the same checks over the same tree do not collide and quietly
   overwrite each other's output -- the second one is what a person is reading
   when they ask why it failed the FIRST time. */
export function newChecksRunId(): string {
  return `C-${randomUUID()}`;
}

/** Keep one run's output. Never throws: losing a log must not fail the run. */
export async function storeCheckOutput(
  repoRoot: string,
  checksRunId: string,
  checks: NamedCheckResult[]
): Promise<Result<{ checks_run_id: string }>> {
  const directory = runDirectory(repoRoot, checksRunId);
  try {
    await mkdir(directory, { recursive: true });
    for (const [index, check] of checks.entries()) {
      /* Numbered by position as well as named, because two checks may share an
         id across the contract-validity and selected sets, and the second one
         silently replacing the first is precisely the log somebody needs. */
      const stored: StoredCheckOutput = {
        id: check.id,
        command: check.command,
        exit_code: check.exit_code,
        stdout: clamp(check.stdout),
        stderr: clamp(check.stderr),
        truncated:
          Buffer.byteLength(check.stdout) > CHECK_OUTPUT_LIMIT_BYTES ||
          Buffer.byteLength(check.stderr) > CHECK_OUTPUT_LIMIT_BYTES
      };
      await writeFileAtomic(
        path.join(directory, `${String(index).padStart(3, "0")}.json`),
        `${JSON.stringify(stored, null, 2)}\n`
      );
    }
    return { ok: true, value: { checks_run_id: checksRunId } };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** One run's stored output, in the order the checks ran. */
export async function readCheckOutput(
  repoRoot: string,
  checksRunId: string
): Promise<Result<CheckOutputRun>> {
  /* The identifier goes into a path, so it is validated as an identifier
     rather than trusted as one. `C-` plus a UUID is the whole shape. */
  if (!/^C-[0-9a-f-]{36}$/u.test(checksRunId)) {
    return { ok: false, reason: "checks_run_id is invalid" };
  }
  const directory = runDirectory(repoRoot, checksRunId);
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { ok: false, reason: `no recorded check output for ${checksRunId}` };
  }
  const checks: StoredCheckOutput[] = [];
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      if (isStoredCheckOutput(raw)) checks.push(raw);
    } catch {
      /* One unreadable file does not hide the rest. */
    }
  }
  return { ok: true, value: { checks_run_id: checksRunId, checks } };
}

function clamp(value: string): string {
  return Buffer.byteLength(value) > CHECK_OUTPUT_LIMIT_BYTES
    ? Buffer.from(value).subarray(0, CHECK_OUTPUT_LIMIT_BYTES).toString("utf8")
    : value;
}

function isStoredCheckOutput(value: unknown): value is StoredCheckOutput {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.command === "string" &&
    typeof record.exit_code === "number" &&
    typeof record.stdout === "string" &&
    typeof record.stderr === "string"
  );
}
