import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { list } from "@/lib/durable";
import type { WorkspaceAction } from "@/lib/workspace-actions";

/**
 * "Your machine's verifications are in the repository."
 *
 * Adding an ignore rule does nothing to a file git already has. A project set
 * up before the split keeps sharing its connection records on every clone and
 * every pull until somebody runs `git rm --cached` — and that is a silent
 * state, which is exactly why it is surfaced rather than left in a note.
 *
 * What it is offering to stop is not untidiness. A connection record proves
 * capabilities were measured on ONE binary, under ONE account, on ONE machine.
 * Anybody cloning the repository inherits the verdict, and until this pass
 * inherited the capability with it — a routing privilege granted on evidence
 * their machine never produced. That is the capability contract accepting a
 * declaration again, made by somebody else's computer instead of a config file.
 *
 * It stages the removal and stops. The commit belongs to the person, and the
 * files stay on disk because they are live state this project is using now.
 */
export function SharingBar({
  onAction
}: {
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element | null {
  const [tracked, setTracked] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<readonly string[] | null>(null);
  const [problem, setProblem] = useState("");

  /* `tracked` is optional and read through `list`, and the answer itself may be
     absent. Typing it as `{ tracked: string[] }` was the durable-record class
     again, one layer further out: not an old record this time but a caller that
     answers the action differently -- the replay harness has no git, returns
     nothing at all, and `result.tracked.length` took the whole setup surface
     down with it. The `catch` could not help, because the promise RESOLVED. */
  const look = useCallback(async () => {
    try {
      const result = await onAction<{ tracked?: readonly string[] } | null>({
        type: "sharing.inspect",
        payload: {}
      });
      setTracked(list(result?.tracked));
    } catch {
      /* Not a repository, or no git. Nothing is tracked, so nothing travels. */
      setTracked([]);
    }
  }, [onAction]);

  useEffect(() => {
    void look();
  }, [look]);

  if (done !== null) {
    return (
      <section
        className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-navy/20 bg-navy-wash px-4 py-2 text-[12px]"
        role="status"
      >
        <strong className="font-semibold text-ink">
          {done.length} {done.length === 1 ? "file is" : "files are"} no longer shared
        </strong>
        <span className="min-w-0 flex-1 break-words text-muted-foreground">
          They are still on disk and this project still uses them — git has just
          stopped carrying them. Commit the staged change to make it stick.
        </span>
      </section>
    );
  }

  if (tracked.length === 0) return null;

  const verdicts = tracked.filter((file) => file.endsWith(".connection.json")).length;

  return (
    <section
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber/25 bg-amber-wash px-4 py-2 text-[12px]"
      role="status"
    >
      <strong className="font-semibold text-ink">
        This project shares files that describe your machine
      </strong>
      <span className="min-w-0 flex-1 break-words text-muted-foreground">
        {tracked.length} {tracked.length === 1 ? "file" : "files"} in{" "}
        <span className="font-mono">.hivemind/</span> {tracked.length === 1 ? "is" : "are"} tracked
        by git.
        {verdicts > 0 ? (
          <>
            {" "}
            {verdicts === 1 ? "One is a connection record" : `${verdicts} are connection records`} —
            anyone who clones this repository inherits a check that only ever ran here.
          </>
        ) : null}
      </span>
      <Button
        disabled={busy}
        size="sm"
        type="button"
        onClick={() => {
          setBusy(true);
          setProblem("");
          void onAction<{ removed?: readonly string[] } | null>({
            type: "sharing.untrack",
            payload: {}
          })
            .then((result) => setDone(list(result?.removed)))
            .catch((cause: unknown) =>
              setProblem(cause instanceof Error ? cause.message : String(cause))
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Stopping…" : "Stop sharing them"}
      </Button>
      {problem === "" ? null : <span className="w-full break-words text-clay">{problem}</span>}
    </section>
  );
}
