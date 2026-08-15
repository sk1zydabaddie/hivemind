import { useEffect, useState } from "react";

import type { WorkspaceAction } from "@/lib/workspace-actions";

/* What a "passed" was standing on, rendered wherever one is claimed.
 *
 * The rule this exists to enforce: **"passed" never renders without its
 * provenance.** Two results that look identical mean different things, and the
 * difference used to be invisible.
 *
 * It is ADVISORY. Nothing here gates, refuses, or blocks — M7.2's posture, for
 * M7.2's reason: a signal that classifies its own evidence must not be able to
 * refuse work, because when it is wrong it would refuse correct work for a
 * reason nobody can argue with.
 *
 * And it states its own blind spot **in the same place it renders**, because
 * the failure this could cause is somebody trusting the label. A worker-written
 * suite full of test doubles, passing against a real provider's code in an
 * integrated set, scores well on every axis Core can observe. Core runs a
 * command and reads an exit code; it never sees inside the check. That has to
 * be visible as a limit, not discovered later by whoever believed the badge.
 */

export interface VerificationProvenance {
  version: 1;
  code: { task_id: string; tool: string | null; probe_verified: boolean }[];
  checks: { id: string; author: "contract" | "project_config" | "fail_safe" }[];
  scope: "integrated_set" | "single_worktree";
  artifact_identity: string;
  adversarial_coverage: "unknown";
}

interface ChecksView {
  /** Absent on a run recorded before provenance existed, which is not `null`. */
  provenance?: VerificationProvenance | null;
}

/**
 * Whether this is really a provenance, rather than whether a key was present.
 *
 * The two facts this surface renders — how many tasks ran on a verified
 * provider, and who authored the checks — both read arrays off it. Neither can
 * be produced from a partial record, and rendering half a provenance would make
 * a weaker claim look like a stronger one, which is the exact failure the whole
 * feature exists to prevent.
 */
export function isProvenance(value: unknown): value is VerificationProvenance {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.code) &&
    Array.isArray(record.checks) &&
    (record.scope === "integrated_set" || record.scope === "single_worktree")
  );
}

/** The one-line summary. Short on purpose; the limits are their own sentence. */
export function summariseProvenance(provenance: VerificationProvenance): string {
  const verified = provenance.code.filter((entry) => entry.probe_verified).length;
  const total = provenance.code.length;
  const contract = provenance.checks.filter((check) => check.author === "contract").length;
  return [
    total === 0
      ? "no recorded author"
      : verified === total
        ? "verified provider"
        : verified === 0
          ? "unverified provider"
          : `${String(verified)} of ${String(total)} tasks by a verified provider`,
    contract > 0 ? "contract-authored checks" : "project checks only",
    provenance.scope === "integrated_set" ? "integrated set" : "single worktree"
  ].join(" · ");
}

export function ProvenanceNote({
  onAction,
  compact = false
}: {
  onAction: <T>(action: WorkspaceAction) => Promise<T>;
  /** The ship bar wants one line; the checks pane wants the whole thing. */
  compact?: boolean;
}): React.JSX.Element | null {
  const [provenance, setProvenance] = useState<VerificationProvenance | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void onAction<ChecksView>({ type: "checks.inspect", payload: {} })
      .then((value) => {
        if (cancelled) return;
        /* ABSENT and NULL are different values and this only handled one.
           A run recorded before provenance existed has no `provenance` key at
           all, so `=== null` was false, `undefined` was stored as though it
           were a provenance, and the render crashed reading `.code` off it --
           taking the whole ship surface down with it. Found by replaying a real
           trail; every fixture in the suite happened to carry the key.

           A partial provenance is not a provenance either, so this checks the
           shape rather than the key. Anything that is not one reads as missing,
           which is the honest answer and the safe direction: this note is
           advisory, and saying nothing is always better than asserting
           something about evidence nobody has. */
        setProvenance(isProvenance(value.provenance) ? value.provenance : null);
        setMissing(!isProvenance(value.provenance));
      })
      .catch(() => {
        /* No recorded run at all. Nothing to qualify, so nothing renders --
           this note describes a result, and there is no result. */
        if (!cancelled) setMissing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onAction]);

  if (missing) {
    /* A run recorded before provenance existed. Different from "nothing to
       say", and said differently. */
    return (
      <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">
        This run was recorded before Hivemind kept track of what its checks stood on.
      </p>
    );
  }
  if (provenance === null) return null;

  if (compact) {
    return (
      <span className="text-[11px] text-muted-foreground">{summariseProvenance(provenance)}</span>
    );
  }

  return (
    <section className="grid gap-1.5 border-t border-rule pt-2">
      <span className="text-[11px] font-medium tracking-label text-muted-foreground uppercase">
        What this stood on
      </span>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">Code by</dt>
        <dd className="m-0 text-ink">
          {provenance.code.length === 0
            ? "no recorded author"
            : provenance.code
                .map(
                  (entry) =>
                    `${entry.tool ?? "unrecorded"}${entry.probe_verified ? "" : " (unverified)"}`
                )
                .join(", ")}
        </dd>
        <dt className="text-muted-foreground">Checks by</dt>
        <dd className="m-0 text-ink">
          {describeAuthors(provenance.checks)}
        </dd>
        <dt className="text-muted-foreground">Ran against</dt>
        <dd className="m-0 text-ink">
          {provenance.scope === "integrated_set"
            ? "every task's change together"
            : "one task's own checkout"}
        </dd>
        <dt className="text-muted-foreground">Failing case tried</dt>
        <dd className="m-0 text-amber">
          not known — Hivemind does not measure this
        </dd>
      </dl>
      {/* The blind spot, beside the badge rather than in a document nobody
          opens. This is the sentence that stops the label over-claiming. */}
      <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">
        This says where the code and the checks came from — not how deeply they
        test. Hivemind runs a command and reads its exit code; it never sees inside
        a check. A suite written by the agent, full of stand-ins, would still show
        everything above.
      </p>
    </section>
  );
}

function describeAuthors(
  checks: { author: "contract" | "project_config" | "fail_safe" }[]
): string {
  const contract = checks.filter((check) => check.author === "contract").length;
  const project = checks.filter((check) => check.author === "project_config").length;
  const failSafe = checks.filter((check) => check.author === "fail_safe").length;
  const parts: string[] = [];
  if (contract > 0) parts.push(`${String(contract)} from the task's contract`);
  if (project > 0) parts.push(`${String(project)} from this project's own checks`);
  if (failSafe > 0) parts.push(`${String(failSafe)} full-suite fallback`);
  return parts.length === 0 ? "no checks recorded" : parts.join(", ");
}
