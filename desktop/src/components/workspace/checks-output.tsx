import { useEffect, useState } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { ProvenanceNote } from "@/components/workspace/provenance-note";
import type { WorkspaceAction } from "@/lib/workspace-actions";

/* Why the checks failed, in the checks' own words.
 *
 * This is what the embedded terminal was refused in favour of. The ask behind
 * "give me a shell" was almost always *seeing why `npm test` failed*, and that
 * needs no shell: Hivemind already ran the command. It only needed to keep the
 * output, which until this pass it threw away.
 *
 * What it can do: show the recorded stdout and stderr of the last run of the
 * project's checks. What it cannot do: run anything, re-run anything, or change
 * a verdict. It is a record, and reading a record is not an action — re-running
 * is `verification.rerun`, a different action behind a different gate.
 */

export interface ChecksOutput {
  checks_run_id: string;
  checks: {
    id: string;
    command: string;
    exit_code: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }[];
  ran_at: string;
  task_ids: string[];
  tests: string | null;
}

export function ChecksOutputPane({
  onAction
}: {
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
}): React.JSX.Element {
  const [output, setOutput] = useState<ChecksOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void onAction<ChecksOutput>({ type: "checks.inspect", payload: {} })
      .then((value) => {
        if (cancelled) return;
        setOutput(value);
        setLoading(false);
      })
      .catch((problem: unknown) => {
        if (cancelled) return;
        /* Core's own sentence. When nothing has been recorded it says so
           plainly, which is the honest answer and not an error state. */
        setError(problem instanceof Error ? problem.message : String(problem));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onAction]);

  if (loading) {
    return <p className="m-0 px-5 py-4 text-[13px] text-muted-foreground">Reading what the checks said…</p>;
  }
  if (error !== null || output === null) {
    return (
      <div className="grid content-start gap-2 px-5 py-4">
        <p className="m-0 text-[13px] leading-relaxed text-muted-foreground" role="status">
          {error ?? "Nothing has been recorded yet."}
        </p>
        <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
          Hivemind keeps what the project's checks printed the last time it ran them. A run
          from before this was kept has no output to show — that is a gap in the record,
          not a check that printed nothing.
        </p>
      </div>
    );
  }

  const failed = output.checks.filter((check) => check.exit_code !== 0);
  return (
    <ScrollArea className="min-h-0">
      <div className="grid gap-3 px-4 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          <span className={failed.length === 0 ? "font-medium text-ink" : "font-medium text-clay"}>
            {failed.length === 0
              ? `All ${output.checks.length} passed`
              : `${failed.length} of ${output.checks.length} failed`}
          </span>
          <span aria-hidden="true" className="h-2.5 w-px bg-rule" />
          <span>{formatWhen(output.ran_at)}</span>
        </div>

        {/* A result never stands alone. What it was standing on renders with
            it, and so does what that does not cover. */}
        <ProvenanceNote onAction={onAction} />

        {output.checks.length === 0 ? (
          <p className="m-0 text-[13px] text-muted-foreground">
            This run recorded no checks at all.
          </p>
        ) : null}

        {/* Failures first. A person opening this has one question, and making
            them scroll past six passing checks to reach it is the same
            mistake as burying the sentence that needs them. */}
        {[...output.checks]
          .sort((left, right) => Number(right.exit_code !== 0) - Number(left.exit_code !== 0))
          .map((check, index) => (
            <section
              className="border border-rule bg-panel"
              key={`${check.id}-${String(index)}`}
            >
              <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-rule px-3 py-2">
                <strong className="text-[13px] font-semibold text-ink">{check.id}</strong>
                <code className="font-mono text-[11px] text-muted-foreground">{check.command}</code>
                <span
                  className={`ml-auto font-mono text-[11px] font-medium ${
                    check.exit_code === 0 ? "text-navy" : "text-clay"
                  }`}
                >
                  {check.exit_code === 0 ? "passed" : `exit ${check.exit_code}`}
                </span>
              </header>
              <Stream label="what it printed" text={check.stdout} />
              <Stream label="errors" text={check.stderr} tone="clay" />
              {check.stdout.trim() === "" && check.stderr.trim() === "" ? (
                <p className="m-0 px-3 py-2 text-[12px] text-muted-foreground">
                  This check printed nothing.
                </p>
              ) : null}
              {check.truncated ? (
                <p className="m-0 border-t border-rule px-3 py-2 text-[11px] leading-relaxed text-amber">
                  This check printed more than Hivemind keeps. What is above is the
                  beginning of it, not all of it.
                </p>
              ) : null}
            </section>
          ))}
      </div>
    </ScrollArea>
  );
}

function Stream({
  label,
  text,
  tone
}: {
  label: string;
  text: string;
  tone?: "clay";
}): React.JSX.Element | null {
  if (text.trim() === "") return null;
  return (
    <div className="grid gap-1 border-t border-rule px-3 py-2 first:border-t-0">
      <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
        {label}
      </span>
      <pre
        className={`m-0 overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre ${
          tone === "clay" ? "text-clay" : "text-ink"
        }`}
      >
        {text.trimEnd()}
      </pre>
    </div>
  );
}

function formatWhen(value: string): string {
  const when = new Date(value);
  return Number.isNaN(when.getTime())
    ? "at an unrecorded time"
    : when.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
}
