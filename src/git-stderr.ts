/**
 * Classifying git's stderr, which is the one place we genuinely have nothing
 * else to read.
 *
 * INVARIANT: control flow must never depend on the text of a message. Git is
 * the exception that proves it -- it is a separate program whose diagnostics
 * are prose, localized, and free to change between versions. So the rule
 * becomes: this parsing exists in exactly ONE place, is named for what it is,
 * and FAILS CLOSED when it does not recognise the text.
 *
 * "Fails closed" is meaningful only if each caller says what closed means:
 *
 * - Worktree cleanup retry (`isBusyStderr`): unrecognised means DO NOT RETRY.
 *   The removal is reported as failed, the task's cleanup does not complete,
 *   and the lease stays held with the debris still present. Nothing is
 *   reclaimed on a guess. Retrying on an unrecognised message would be the
 *   open direction -- it spends the retry budget and can report success on a
 *   cleanup that never happened.
 *
 * - Branch deletion (`isMissingBranchStderr`): unrecognised means the failure
 *   is REAL and propagates. Only a branch git positively says is absent is
 *   treated as already-deleted; anything else refuses rather than assuming the
 *   work is done.
 *
 * Do not add a caller that treats no-match as permission to proceed. If a new
 * decision needs git's opinion, the question is whether git can be asked
 * directly -- by exit code, by a porcelain command -- before it is asked by
 * regex.
 */

/**
 * Substrings that indicate a file is still held by another process, so a
 * retry may succeed. Windows, Linux and macOS phrase this differently, and
 * git passes some of them through from the OS.
 *
 * UNTRUSTED: this is another program's output. A miss must be harmless.
 */
const busyStderrPatterns = [
  "resource busy",
  "used by another process",
  "access is denied",
  "permission denied",
  "device or resource busy",
  "text file busy",
  "directory not empty"
] as const;

/**
 * UNTRUSTED classification of git stderr: does it say a file is still held?
 *
 * Callers must treat `false` as "not known to be transient", never as "known
 * to be permanent" -- the difference matters, because only the first is safe
 * to act on by giving up.
 */
export function isBusyStderr(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return busyStderrPatterns.some((pattern) => text.includes(pattern));
}

/**
 * UNTRUSTED classification of git stderr: does it say the branch is absent?
 *
 * Used only to make branch deletion idempotent. A false negative costs a
 * spurious failure, which is the safe direction; a false positive would report
 * a branch as deleted when it still exists.
 */
export function isMissingBranchStderr(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("not found") || text.includes("error: branch") && text.includes("not found");
}

/**
 * The errno-bearing half. A thrown Node error carries a real, typed `code`,
 * and that is strictly better evidence than any sentence -- so it is read
 * before anything is rendered into prose.
 *
 * This is the bug's exact shape one layer up: the typed errno existed, was
 * flattened into a message by `error.message`, and was then recovered by
 * regexing that message. Read it here, while it is still a value.
 */
const busyErrnos = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "ETXTBSY"]);

export function isBusyErrno(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    busyErrnos.has((error as { code: string }).code)
  );
}
