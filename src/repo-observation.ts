import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Did this run change the branch?
 *
 * The worker prompt has always said *"Submit a diff only. Do not commit, push,
 * rename unrelated files"* — and that is a sentence, not a boundary. A model
 * that ignores it produces exactly the same successful-looking run as one that
 * obeys it, and Hivemind's whole submit → analyze → adopt chain rests on the
 * change still being uncommitted when it gets there.
 *
 * This turns the sentence into a measurement, and it is the cheapest capability
 * in the contract by a wide margin:
 *
 *   - it costs two `git rev-parse` calls and no provider cooperation at all;
 *   - it works identically on a harness nobody has written an adapter for,
 *     including one that does not exist yet;
 *   - it cannot be defeated by a prompt the model chooses to ignore, because it
 *     observes the repository rather than the agent.
 *
 * It is also the one observation in the contract that genuinely SETTLES its
 * claim rather than merely failing to refute it. "This run created no commit"
 * is completely established by comparing HEAD before and after: there is no
 * hidden way to have committed. That is why `leaves_change_uncommitted` is
 * scoped `this-run` and an observation is allowed to verify it, while the same
 * evidence class cannot establish confinement.
 */

export interface RepoMark {
  /** The commit HEAD pointed at, or null in a repository with no commits. */
  head: string | null;
  /** The branch or detached ref, so a checkout is caught as well as a commit. */
  ref: string | null;
  /** True when neither could be read. The comparison then answers `unknown`. */
  unreadable: boolean;
}

export type BranchStanding =
  /** HEAD and the ref are exactly where they were. */
  | "unchanged"
  /** Something moved. The agent committed, checked out, or reset. */
  | "moved"
  /** The repository could not be read at one end, so nothing can be claimed. */
  | "unknown";

export interface BranchObservation {
  standing: BranchStanding;
  before: RepoMark;
  after: RepoMark;
  detail: string;
}

export async function markRepo(repoRoot: string): Promise<RepoMark> {
  const head = await gitLine(repoRoot, ["rev-parse", "HEAD"]);
  const ref = await gitLine(repoRoot, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  return { head, ref, unreadable: head === null && ref === null };
}

export function compareRepoMarks(before: RepoMark, after: RepoMark): BranchObservation {
  if (before.unreadable || after.unreadable) {
    return {
      standing: "unknown",
      before,
      after,
      detail:
        "Hivemind could not read this project's history before and after the run, so it cannot say whether the agent changed your branch."
    };
  }
  if (before.head === after.head && before.ref === after.ref) {
    return {
      standing: "unchanged",
      before,
      after,
      detail: "Your branch was exactly where it started when the agent finished."
    };
  }
  /* Named separately because they are different accidents and the person can
     act on them differently: a commit is work that skipped review, a checkout
     is a run that happened somewhere other than where it was sent. */
  const what =
    before.ref !== after.ref
      ? "It moved this project onto a different branch"
      : "It committed its work instead of leaving it for you to look at";
  return {
    standing: "moved",
    before,
    after,
    detail: `${what}, which would skip the review Hivemind exists to give you.`
  };
}

async function gitLine(repoRoot: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoRoot,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const line = result.stdout.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}
