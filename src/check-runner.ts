import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface NamedCheckResult {
  id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  /** Present only when a timeout was supplied and the command hit it. */
  timed_out?: boolean;
  duration_ms?: number;
}

/**
 * Run one check, in the project, and report what happened.
 *
 * The single executor on purpose. Setup validates a candidate command through
 * this same function, so the run that decides whether a command is storable
 * cannot differ from the run that later decides whether a change ships -- a
 * setup check that passed under different rules than the gate would be worse
 * than no check at all.
 *
 * `timeoutMs` exists for the setup path, which has a person waiting on it. The
 * gate passes nothing and keeps its previous unbounded behaviour, because a
 * long suite there is the suite doing its job.
 */
export async function runNamedCheck(
  cwd: string,
  id: string,
  command: string,
  options: { timeoutMs?: number } = {}
): Promise<NamedCheckResult> {
  const startedAt = Date.now();
  try {
    const result = await execAsync(command, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 32,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs })
    });
    return {
      id,
      command,
      exit_code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: Date.now() - startedAt
    };
  } catch (error: unknown) {
    const field = (name: string): unknown =>
      typeof error === "object" && error !== null && name in error
        ? (error as Record<string, unknown>)[name]
        : undefined;
    const code = field("code");
    return {
      id,
      command,
      /* A string `code` is a spawn failure (ENOENT and friends), not an exit
         status: the command never ran, and reporting 1 for that would make it
         indistinguishable from a check that ran and failed. */
      exit_code: typeof code === "number" ? code : 1,
      stdout: field("stdout") === undefined ? "" : String(field("stdout")),
      stderr:
        field("stderr") === undefined || String(field("stderr")) === ""
          ? typeof code === "string"
            ? String(field("message") ?? code)
            : ""
          : String(field("stderr")),
      /* `killed` with a signal is how exec reports its own timeout. */
      ...(field("killed") === true ? { timed_out: true } : {}),
      duration_ms: Date.now() - startedAt
    };
  }
}
