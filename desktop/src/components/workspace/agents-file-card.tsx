import { FileText, Check } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AgentsFileProposalView, WorkspaceAction } from "@/lib/workspace-actions";
import { plainActionError } from "@/lib/plain-language";

/**
 * The proposed AGENTS.md, and the diff it would make.
 *
 * Hivemind proposes; the person accepts. Nothing here writes until the button
 * is pressed, the diff is shown rather than the finished file, and Core -- not
 * this component -- decides what actually lands: the accept sends back only the
 * two hashes this card was shown, never content.
 *
 * It renders nothing at all when there is nothing honest to propose. A card
 * that says "no suggestions" is a card that has to be read every time somebody
 * opens the tab, and the refusal reasons here ("nothing was detected yet",
 * "you edited it") are answers to a question nobody asked.
 */
export function AgentsFileCard({
  onAction
}: {
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element | null {
  const [proposal, setProposal] = useState<AgentsFileProposalView | null>(null);
  const [applied, setApplied] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void onAction<AgentsFileProposalView>({ type: "agents.propose", payload: {} })
      .then((value) => {
        if (!cancelled) setProposal(value);
      })
      .catch(() => {
        /* A refusal is the ordinary answer here -- nothing detected yet, or a
           section somebody edited by hand. The card simply does not appear. */
      });
    return () => {
      cancelled = true;
    };
  }, [onAction]);

  if (proposal === null || dismissed) return null;

  const accept = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await onAction({
        type: "agents.apply",
        payload: { proposed_sha: proposal.proposed_sha, existing_sha: proposal.existing_sha }
      });
      setApplied(true);
    } catch (cause) {
      setError(plainActionError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-md border border-rule bg-canvas px-3 py-2.5">
      <div className="flex items-start gap-2">
        <FileText aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <strong className="block text-[12px] font-medium text-ink">
            {applied ? "AGENTS.md updated" : "A starter AGENTS.md, from what is in this project"}
          </strong>
          <p className="mt-0.5 mb-0 text-[11px] leading-relaxed text-muted-foreground">
            {applied
              ? "Every worker reads it from now on. Edit it whenever you like — Hivemind will not overwrite your changes."
              : `Hivemind would ${proposal.summary}. Everything in it was read from your files, not guessed, and it carries knowledge only — it cannot change what gets checked.`}
          </p>

          {applied ? null : (
            <>
              <pre className="mt-2 mb-0 max-h-40 overflow-auto rounded-xs bg-panel px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre text-muted-foreground">
                {proposal.diff.split("\n").map((line, index) => (
                  <div
                    className={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? "text-moss"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "text-clay"
                          : undefined
                    }
                    key={index}
                  >
                    {line === "" ? " " : line}
                  </div>
                ))}
              </pre>
              <p className="mt-1.5 mb-0 text-[10.5px] leading-relaxed text-muted-foreground">
                {proposal.bytes} bytes. It sits in the cached part of every worker prompt, so it
                is billed at roughly a tenth after the first call
                {proposal.over_target
                  ? `, but it is over the ${proposal.size_target_bytes}-byte guide and is paid for on every task.`
                  : "."}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button disabled={busy} size="sm" type="button" onClick={() => void accept()}>
                  {busy ? "Writing…" : "Use this"}
                  {busy ? null : <Check aria-hidden="true" />}
                </Button>
                <Button disabled={busy} size="sm" type="button" variant="outline" onClick={() => setDismissed(true)}>
                  Not now
                </Button>
              </div>
            </>
          )}

          {error === "" ? null : (
            <p className="mt-1.5 mb-0 text-[11px] break-words text-clay" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
