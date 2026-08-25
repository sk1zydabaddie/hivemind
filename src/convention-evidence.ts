/**
 * Observed conventions, read out of the durable trail.
 *
 * The two richest sources of "what this repository actually expects" are a
 * scope rejection (a worker tried something the scope forbade) and a mid-run
 * correction (a human had to state a rule by hand). A rejection was recorded as
 * a bare verdict: `patch.rejected` carries `{verdict, reason, plain_reason}`
 * and nothing else, so a reader cannot tell an honest mistake from a convention
 * nobody wrote down.
 *
 * ## Why this is a join and not a new field
 *
 * Every missing half is already durable, written by something else, and keyed
 * by the same task:
 *
 *   patch.rejected                       the verdict and why it was refused
 *   .hivemind/tasks/<id>.contract.json   the scope it was refused against
 *   .hivemind/patches/<id>/diff.patch    the paths actually touched
 *   write_intent.submitted               what the worker declared it would do
 *   task.created                         title, type, acceptance criterion
 *
 * So the attempt is recoverable by reading, and no durable format gains a
 * field. That matters more than it looks: twenty-one modules declare
 * `version: 1`, and a format that grows a field needs every reader of every
 * older record to keep working. A join has no migration, works on trails
 * written months ago, and cannot invalidate a record that already exists.
 *
 * Corrections needed even less. `human.guidance_recorded` has always carried
 * its full `message` -- what was missing was a reader, not a field.
 *
 * ## What this is NOT
 *
 * It reports evidence and proposes nothing. Turning "T-101 touched
 * src/schema/profile.ts while it was read-only" into "migrations do not modify
 * the schema they migrate" is an inference, and inference belongs to a later
 * step with a human at the end of it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { readEvents, type HivemindEvent } from "./events.js";

export interface EvidenceCitation {
  /** The same `events.jsonl#L<n>` shape the consolidation worker already uses. */
  ref: string;
  type: string;
  at: string;
}

export interface ScopeRejectionEvidence {
  kind: "scope_rejection";
  task_id: string;
  title: string | null;
  task_type: string | null;
  /** The verdict as recorded: "reject" or "escalate". */
  verdict: string;
  /** Why it was refused, in the gate's words. */
  reason: string;
  /** What the scope allowed, read from the durable contract. */
  allowed_files: string[];
  read_only_files: string[];
  forbidden_files: string[];
  /** What was actually touched, read from the patch bundle's diff. */
  touched_files: string[];
  /** Touched paths that the contract did not allow -- the concrete overstep. */
  out_of_scope_files: string[];
  /** What the worker declared it would do, when it submitted a write intent. */
  declared_files: string[];
  declared_notes: string[];
  citations: EvidenceCitation[];
}

export interface CorrectionEvidence {
  kind: "correction";
  guidance_id: string;
  /** The text itself, which the event has carried all along. */
  message: string;
  recorded_at: string;
  citations: EvidenceCitation[];
}

export type ConventionEvidence = ScopeRejectionEvidence | CorrectionEvidence;

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Event types that are NOT convention evidence, and why.
 *
 * `task.failed` is the one worth naming: on this machine every recorded
 * instance is an infrastructure fault ("worker exited 1 ... The command line is
 * too long"), which is a Hivemind bug rather than something the repository
 * expects. Feeding that class to a proposer produces a confident sentence with
 * a citation attached, which is worse than proposing nothing. The exclusion is
 * by TYPE rather than by asking a model to judge, because a type is checkable
 * and a judgement is not.
 */
export const NOT_CONVENTION_EVIDENCE: readonly string[] = [
  "task.failed",
  "task.paused",
  "lease.rejected",
  "manager.judgment_requested",
  "manager.action_retry_requested",
  "quota.low"
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function citation(event: HivemindEvent, index: number): EvidenceCitation {
  return { ref: `events.jsonl#L${index + 1}`, type: event.type, at: event.ts };
}

/** Contract scope, read tolerantly: an old or invalid contract is absent, not fatal. */
export interface ContractScope {
  title: string | null;
  routing_task_type: string | null;
  allowed_files: string[];
  read_only_files: string[];
  forbidden_files: string[];
}

async function readContractScope(repoRoot: string, taskId: string): Promise<ContractScope | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(repoRoot, ".hivemind", "tasks", `${taskId}.contract.json`), "utf8")
    ) as Record<string, unknown>;
    return {
      title: typeof raw.title === "string" ? raw.title : null,
      routing_task_type: typeof raw.routing_task_type === "string" ? raw.routing_task_type : null,
      allowed_files: stringList(raw.allowed_files),
      read_only_files: stringList(raw.read_only_files),
      forbidden_files: stringList(raw.forbidden_files)
    };
  } catch {
    /* No contract, or one this build cannot parse. The evidence is still worth
       reporting without its scope -- what must never happen is a throw that
       loses every other piece of evidence in the trail. */
    return null;
  }
}

/**
 * Which paths a diff touched.
 *
 * `files_changed.json` exists in every bundle and is zero bytes in all of them,
 * so the diff is the only durable record of what was attempted. Parsed rather
 * than trusted: only the `diff --git` header names both sides unambiguously.
 */
export function touchedFilesFromDiff(diff: string): string[] {
  const touched = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line.trim());
    if (match) {
      touched.add(match[2]);
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/u.exec(line.trim());
    if (plus && plus[1] !== "/dev/null") touched.add(plus[1]);
  }
  return [...touched].sort();
}

async function readTouchedFiles(repoRoot: string, taskId: string): Promise<string[]> {
  try {
    return touchedFilesFromDiff(
      await readFile(path.join(repoRoot, ".hivemind", "patches", taskId, "diff.patch"), "utf8")
    );
  } catch {
    return [];
  }
}

/**
 * Everything in the trail that could describe a convention, with citations.
 *
 * Ordered oldest first, which is the order a person reads a history in.
 */
export async function collectConventionEvidence(repoRoot: string): Promise<Result<ConventionEvidence[]>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;

  const rejectedTasks = new Set(
    events.value
      .filter((event) => event.type === "patch.rejected" && typeof event.task_id === "string")
      .map((event) => event.task_id as string)
  );
  const scopes = new Map<string, ContractScope | null>();
  const touched = new Map<string, string[]>();
  for (const taskId of rejectedTasks) {
    scopes.set(taskId, await readContractScope(repoRoot, taskId));
    touched.set(taskId, await readTouchedFiles(repoRoot, taskId));
  }
  return { ok: true, value: conventionEvidenceFrom(events.value, { scopes, touched }) };
}

/** The pure half, so a test can supply a trail without writing one to disk. */
export function conventionEvidenceFrom(
  events: readonly HivemindEvent[],
  durable: { scopes: Map<string, ContractScope | null>; touched: Map<string, string[]> } = {
    scopes: new Map(),
    touched: new Map()
  }
): ConventionEvidence[] {
  const collected: ConventionEvidence[] = [];

  /* The most recent write intent and creation record for each task, kept as we
     walk forward. A rejection is explained by what was declared BEFORE it, so a
     later resubmission must not be read back onto an earlier refusal. */
  const latestIntent = new Map<string, { event: HivemindEvent; index: number }>();
  const created = new Map<string, { event: HivemindEvent; index: number }>();

  for (const [index, event] of events.entries()) {
    const taskId = typeof event.task_id === "string" ? event.task_id : null;

    if (event.type === "task.created" && taskId !== null) {
      created.set(taskId, { event, index });
      continue;
    }
    if (event.type === "write_intent.submitted" && taskId !== null) {
      latestIntent.set(taskId, { event, index });
      continue;
    }
    if (event.type === "human.guidance_recorded") {
      const data = asRecord(event.data);
      const message = typeof data.message === "string" ? data.message.trim() : "";
      const guidanceId = typeof data.guidance_id === "string" ? data.guidance_id : "";
      /* A guidance record that claims authority is malformed, and the reader
         that owns that rule refuses it there. Here it is simply not evidence:
         this module reports what was said, never what it permits. */
      if (message === "" || guidanceId === "" || data.advisory_only !== true) continue;
      collected.push({
        kind: "correction",
        guidance_id: guidanceId,
        message,
        recorded_at: event.ts,
        citations: [citation(event, index)]
      });
      continue;
    }
    if (event.type !== "patch.rejected" || taskId === null) continue;

    const data = asRecord(event.data);
    const scope = durable.scopes.get(taskId) ?? null;
    const touchedFiles = durable.touched.get(taskId) ?? [];
    const intent = latestIntent.get(taskId);
    const intentData = intent ? asRecord(intent.event.data) : {};
    const creation = created.get(taskId);
    const createdData = creation ? asRecord(creation.event.data) : {};

    const citations = [citation(event, index)];
    if (intent) citations.push(citation(intent.event, intent.index));
    if (creation) citations.push(citation(creation.event, creation.index));

    const allowed = new Set(scope?.allowed_files ?? []);
    collected.push({
      kind: "scope_rejection",
      task_id: taskId,
      title: scope?.title ?? (typeof createdData.title === "string" ? createdData.title : null),
      task_type:
        scope?.routing_task_type ??
        (typeof createdData.routing_task_type === "string" ? createdData.routing_task_type : null),
      verdict: typeof data.verdict === "string" ? data.verdict : "reject",
      /* `plain_reason` is the sibling every user-facing surface reads; `reason`
         is the evidence other code matches on. Prefer the readable one and fall
         back, because this is read by a person. */
      reason:
        typeof data.plain_reason === "string" && data.plain_reason.trim() !== ""
          ? data.plain_reason
          : typeof data.reason === "string"
            ? data.reason
            : "",
      allowed_files: scope?.allowed_files ?? [],
      read_only_files: scope?.read_only_files ?? [],
      forbidden_files: scope?.forbidden_files ?? [],
      touched_files: touchedFiles,
      /* The concrete overstep, computed rather than asserted. Empty when the
         contract could not be read -- absent evidence, never a claim of none. */
      out_of_scope_files:
        scope === null ? [] : touchedFiles.filter((file) => !allowed.has(file)),
      declared_files: stringList(intentData.intended_files),
      /* `possible_risks` and `will_not_change` are where a worker states, in its
         own words, what it intends and what it will leave alone -- the "what was
         attempted" half the rejection event lacks. */
      declared_notes: [...stringList(intentData.possible_risks), ...stringList(intentData.will_not_change)],
      citations
    });
  }

  return collected;
}

/**
 * How much of it there is, for a surface that has to decide whether proposing
 * anything is honest yet.
 *
 * `explained` is the number that matters: a rejection whose attempt could not
 * be recovered is a fact about a refusal, not about a convention, and a first
 * run usually produces nothing else. The correct output then is silence rather
 * than a confident sentence drawn from one event.
 */
export function evidenceStanding(evidence: readonly ConventionEvidence[]): {
  scope_rejections: number;
  corrections: number;
  explained_rejections: number;
} {
  const rejections = evidence.filter(
    (entry): entry is ScopeRejectionEvidence => entry.kind === "scope_rejection"
  );
  return {
    scope_rejections: rejections.length,
    corrections: evidence.filter((entry) => entry.kind === "correction").length,
    explained_rejections: rejections.filter(
      (entry) =>
        entry.out_of_scope_files.length > 0 || entry.declared_files.length > 0 || entry.touched_files.length > 0
    ).length
  };
}
