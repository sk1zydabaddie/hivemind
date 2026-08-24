/**
 * Running a candidate check command once, before it can be stored.
 *
 * The defect this exists for: the setup field accepted any string, so a field
 * that blocks progress got filled with whatever unblocked it. `npm test` typed
 * into a project with no tests is not a check -- it is a guaranteed-red gate
 * that fails every integration AFTER the planning and worker money is spent,
 * which is strictly worse than the declared absence the person could have
 * chosen in one press.
 *
 * So the answer is measured rather than accepted. The command runs once, here,
 * through the same executor the gate uses, and what it did decides what
 * happens:
 *
 *   passed        -- stored, with the trial recorded alongside it.
 *   failed        -- it IS a check and it is red right now. Reported with its
 *                    output; storing it takes a second, explicit decision.
 *   not_runnable  -- nothing ran: a typo, a missing script, a missing tool.
 *                    Never stored under any confirmation, because there is no
 *                    project state in which an unrunnable string is a check.
 *   timed_out     -- ran and did not finish inside the setup budget. Not
 *                    stored: the outcome is unknown, and an unknown is not a
 *                    pass.
 */
import { runNamedCheck } from "./check-runner.js";

export type CheckTrialOutcome = "passed" | "failed" | "not_runnable" | "timed_out";

export interface CheckTrial {
  command: string;
  outcome: CheckTrialOutcome;
  exit_code: number;
  duration_ms: number;
  /** The last of what it printed, bounded -- a check can print megabytes. */
  output_tail: string;
  /** One line naming what happened, for the surface that has to say it. */
  detail: string;
}

/** Long enough for a real suite, short enough that a person is still there. */
export const CHECK_TRIAL_TIMEOUT_MS = 180_000;

/** Two screens of output is enough to recognise a failure and not enough to be a log. */
const OUTPUT_TAIL_LIMIT = 1_600;

/**
 * Signatures of "the command never ran", which no exit code distinguishes.
 *
 * A shell reports a missing program with 127, `cmd.exe` with 9009, and a
 * package manager reports a missing script with its own ordinary failure code
 * and a specific message -- so the message has to be read for that last case.
 * This is a deliberate exception to the rule against deciding control flow from
 * message text: the classification is about text a THIRD PARTY produced, where
 * no typed code exists, and the fallback when a signature is not matched is the
 * safe direction (treating it as a real failure, which stores nothing without a
 * second explicit decision).
 */
const NEVER_RAN = [
  /* npm, pnpm, yarn, bun, for a script that is not in package.json. */
  /missing script/iu,
  /command ".*" not found/iu,
  /no such file or directory/iu,
  /is not recognized as an internal or external command/iu,
  /^\s*'.*' is not recognized/imu,
  /command not found/iu,
  /: not found\s*$/imu,
  /\bENOENT\b/u,
  /unknown command/iu
];

export async function tryCheckCommand(repoRoot: string, command: string): Promise<CheckTrial> {
  const trimmed = command.trim();
  const result = await runNamedCheck(repoRoot, "setup-trial", trimmed, {
    timeoutMs: CHECK_TRIAL_TIMEOUT_MS
  });
  const printed = `${result.stdout}\n${result.stderr}`.trim();
  const tail = printed.length > OUTPUT_TAIL_LIMIT ? printed.slice(-OUTPUT_TAIL_LIMIT) : printed;
  const seconds = ((result.duration_ms ?? 0) / 1000).toFixed(1);

  if (result.timed_out === true) {
    return {
      command: trimmed,
      outcome: "timed_out",
      exit_code: result.exit_code,
      duration_ms: result.duration_ms ?? 0,
      output_tail: tail,
      detail: `Still running after ${Math.round(CHECK_TRIAL_TIMEOUT_MS / 1000)}s, so it was stopped. Whether it passes is unknown.`
    };
  }

  if (result.exit_code === 0) {
    return {
      command: trimmed,
      outcome: "passed",
      exit_code: 0,
      duration_ms: result.duration_ms ?? 0,
      output_tail: tail,
      detail: `Ran clean in ${seconds}s.`
    };
  }

  /* 127 and 9009 are the two exit codes that mean the program was not found;
     everything else needs the message, because the runner that failed to find
     a SCRIPT exits with its ordinary failure code. */
  const neverRan =
    result.exit_code === 127 ||
    result.exit_code === 9009 ||
    NEVER_RAN.some((pattern) => pattern.test(printed));
  if (neverRan) {
    return {
      command: trimmed,
      outcome: "not_runnable",
      exit_code: result.exit_code,
      duration_ms: result.duration_ms ?? 0,
      output_tail: tail,
      detail: "Nothing ran — this command does not exist in this project."
    };
  }

  return {
    command: trimmed,
    outcome: "failed",
    exit_code: result.exit_code,
    duration_ms: result.duration_ms ?? 0,
    output_tail: tail,
    detail: `Ran and failed after ${seconds}s, exit code ${result.exit_code}.`
  };
}
