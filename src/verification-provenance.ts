import { readFile } from "node:fs/promises";
import path from "node:path";

import { currentBuildIdentity } from "./build-identity.js";
import { readEvents } from "./events.js";

/**
 * What a "passed" was actually standing on.
 *
 * Every `checks passed` in this system used to be recorded without recording
 * **what was exercised**. Two runs produce the same green and mean different
 * things:
 *
 * > Passed — real provider, contract-authored check, integrated set
 * > Passed — fixture adapter, worker-authored check, one worktree
 *
 * Both are true. Only one is evidence about the shipped product.
 *
 * ## Why this is called PROVENANCE and not DEPTH
 *
 * The first draft called it depth, and that name had to go before anything was
 * built. **Core runs a command and reads an exit code. It never sees inside a
 * test.** Whether a check used a mock, or imported one unit rather than the
 * assembled thing, are properties of the check's own source — unobservable
 * here, and no amount of manifest binding changes that.
 *
 * What Core genuinely knows is *where each input came from*: which adapter
 * produced the code, who wrote the check, where it ran, and which build ran it.
 * That is provenance. Calling it depth would invite exactly one reading —
 * "no mocks were involved" — that it cannot support, which would make the
 * instrument built to stop green checks meaning nothing itself mean something
 * narrower than its name.
 *
 * ## What it does not cover, stated here and rendered on the surface
 *
 * A worker-authored suite full of test doubles, passing against a real
 * provider's code in an integrated set, scores well on **every axis below**.
 * That is a real blind spot, and it is surfaced next to the badge rather than
 * left for someone who trusted the label to discover.
 *
 * ## Advisory, never blocking
 *
 * M7.2's posture, for M7.2's reason: a signal that classifies its own evidence
 * must not be able to refuse work, because when it is wrong it would refuse
 * correct work for a reason nobody can argue with. This changes what a person
 * is told, never what is permitted.
 */

/** Who wrote a check. */
export type CheckAuthor =
  /** The task contract's `deterministic_validity_check`. */
  | "contract"
  /** The project's own configured verification inventory. */
  | "project_config"
  /** The full-suite fallback taken when selection could not be trusted. */
  | "fail_safe";

/** Where the checks ran. */
export type CheckScope =
  /** Against the shadow-integrated set — every task's change together. */
  | "integrated_set"
  /** Against one task's or one draft's own checkout. */
  | "single_worktree";

export interface CodeProvenanceEntry {
  task_id: string;
  /** The adapter profile that produced the change, as the trail recorded it. */
  tool: string | null;
  /**
   * Whether that profile carries a recorded capability probe that still
   * describes it. False covers three different situations — never probed, no
   * profile at all, and probed under a different account — and the field is
   * deliberately not split, because all three mean the same thing here: this
   * code came from something nobody has verified.
   */
  probe_verified: boolean;
}

export interface VerificationProvenance {
  version: 1;
  code: CodeProvenanceEntry[];
  checks: Array<{ id: string; author: CheckAuthor }>;
  scope: CheckScope;
  /** The build that ran the checks. Ties a result to the artifact. */
  artifact_identity: string;
  /**
   * Whether the checks were shown to fail when they should.
   *
   * Always `"unknown"`, and present rather than omitted **on purpose**. This is
   * mutation testing: expensive, slow, language-specific, and not mechanized
   * here. An absent field reads as "nothing to say about this"; this field has
   * something to say, and it is that nobody knows.
   */
  adversarial_coverage: "unknown";
}

/**
 * Author from the check's identity, not from a declaration.
 *
 * Contract checks are already minted as `contract-validity:<task>`, and the
 * selected inventory already carries `sources`. So this axis was half-recorded
 * before it had a name — it just had nowhere to be read.
 */
export function checkAuthor(id: string, sources: string[] | undefined): CheckAuthor {
  if (id.startsWith("contract-validity:")) return "contract";
  return sources?.includes("fail-safe") === true ? "fail_safe" : "project_config";
}

/**
 * The adapter behind each task's change, read from the durable trail.
 *
 * `task.started` records the tool it selected, so this is a read of what
 * happened rather than a question asked of anything. A task with no
 * `task.started` — hand-authored, or replayed from an older trail — reports a
 * null tool rather than a guess.
 */
export async function readCodeProvenance(
  repoRoot: string,
  taskIds: string[]
): Promise<CodeProvenanceEntry[]> {
  const events = await readEvents(repoRoot);
  const toolByTask = new Map<string, string>();
  if (events.ok) {
    for (const event of events.value) {
      if (event.type !== "task.started" || event.task_id === null) continue;
      /* Last wins: a rerouted task starts more than once, and the tool that
         produced the change is the one that ran last. */
      if (typeof event.data.tool === "string") toolByTask.set(event.task_id, event.data.tool);
    }
  }

  const entries: CodeProvenanceEntry[] = [];
  for (const taskId of taskIds) {
    const tool = toolByTask.get(taskId) ?? null;
    entries.push({
      task_id: taskId,
      tool,
      probe_verified: tool === null ? false : await hasLiveProbe(repoRoot, tool)
    });
  }
  return entries;
}

/* A profile's probe is live when a connection record exists, carries
   capabilities, and has not been marked stale — which switching accounts does.
   Read directly rather than through config-actions, to keep this module free of
   a dependency on the settings surface. */
async function hasLiveProbe(repoRoot: string, tool: string): Promise<boolean> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(path.join(repoRoot, ".hivemind", "adapters", `${tool}.connection.json`), "utf8")
    );
    if (typeof raw !== "object" || raw === null) return false;
    const record = raw as { capabilities?: unknown; capabilities_stale?: unknown };
    return (
      Array.isArray(record.capabilities) &&
      record.capabilities.length > 0 &&
      (record.capabilities_stale === null || record.capabilities_stale === undefined)
    );
  } catch {
    return false;
  }
}

/** Assemble the provenance for one verification, at the moment it runs. */
export async function buildVerificationProvenance(
  repoRoot: string,
  taskIds: string[],
  checks: Array<{ id: string; sources?: string[] }>,
  scope: CheckScope
): Promise<VerificationProvenance> {
  return {
    version: 1,
    code: await readCodeProvenance(repoRoot, taskIds),
    checks: checks.map((check) => ({ id: check.id, author: checkAuthor(check.id, check.sources) })),
    scope,
    artifact_identity: await currentBuildIdentity(),
    adversarial_coverage: "unknown"
  };
}

/**
 * One sentence, for a surface that has just said "passed".
 *
 * Deliberately short and deliberately incomplete — the limits belong beside it
 * as their own sentence, not folded into this one where they would read as
 * hedging rather than as scope.
 */
export function describeProvenance(provenance: VerificationProvenance): string {
  const real = provenance.code.filter((entry) => entry.probe_verified).length;
  const total = provenance.code.length;
  const contractChecks = provenance.checks.filter((check) => check.author === "contract").length;
  const parts = [
    total === 0
      ? "no recorded author"
      : real === total
        ? "verified provider"
        : real === 0
          ? "unverified provider"
          : `${String(real)} of ${String(total)} tasks by a verified provider`,
    contractChecks > 0 ? "contract-authored checks" : "project checks only",
    provenance.scope === "integrated_set" ? "integrated set" : "single worktree"
  ];
  return parts.join(" · ");
}
