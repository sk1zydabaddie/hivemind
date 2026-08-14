/**
 * What a person is shown when an action is refused.
 *
 * **The mapping moved to Core** (`src/plain-reason.ts`) on 2026-08-14. This
 * file used to carry a regex list matching Core's failure prose and rewriting
 * it, which was wrong in three ways at once:
 *
 * - anything unmapped rendered raw internal text into a polished surface;
 * - the list had to be re-derived whenever Core reworded anything, and broke
 *   silently when it did;
 * - it made the client the authority on what Core's failures mean, which is
 *   the coupling the thin-client boundary exists to prevent.
 *
 * Core now attaches a `plain` sentence to a refusal it can phrase, the daemon
 * returns it, and the Tauri shell prefers it over the machine reason. So by the
 * time an error reaches here it is usually *already* the sentence.
 *
 * What is left is presentation-only, and deliberately small: strip the `error:`
 * prefix a CLI path adds, and collapse a transport failure into something that
 * is not a stack trace. It maps no Core vocabulary at all, and a new Core
 * refusal needs no change here — which is the whole point of the move.
 */
export function plainActionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.replace(/^error:\s*/iu, "").trim();
  if (text === "") return "";

  /* Transport rather than refusal: these never reach Core, so Core cannot
     phrase them and this is the only place that can. */
  if (/daemon action (connection|request|response) failed|daemon is not running/iu.test(text)) {
    return "Hivemind lost contact with the project. It will reconnect on its own; if it does not, reopen the project.";
  }
  if (/timed out/iu.test(text)) {
    return "That took longer than Hivemind waits for. Nothing was changed.";
  }
  return text;
}
