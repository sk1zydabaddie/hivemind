import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import type { DraftScope, TentativePlan, TentativePlanTask } from "./plan.js";
import { type SpecResult } from "./spec.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";

export type ReplanCause = "scope-too-narrow" | "overlap" | "agent-incapable" | "spec-ambiguity";
export type ReplanRemedy = "widen" | "re-sequence" | "re-route" | "escalate";

export interface ReplanRecord {
  version: 1;
  spec_id: string;
  task_id: string;
  status: "active" | "blocked";
  budget: number;
  known_failed_scope_hashes: string[];
  attempts: ReplanAttempt[];
  escalation?: {
    ts: string;
    reason: string;
    cause: ReplanCause;
  };
}

export interface ReplanAttempt {
  attempt_id: string;
  ts: string;
  scope_hash: string;
  alternate_scope_hashes: string[];
  scope: DraftScope;
  cause: ReplanCause;
  remedy: ReplanRemedy;
  evidence: ReplanEvidence;
}

export interface ReplanEvidence {
  failure_count: number;
  event_count: number;
  manager_failure_count: number;
  reasons: string[];
  session_paths: string[];
}

export interface ReplanEvaluationResult {
  spec_id: string;
  task_id: string;
  status: "no_thrash" | "replan_required" | "blocked";
  cause?: ReplanCause;
  remedy?: ReplanRemedy;
  budget: number;
  attempt_count: number;
  attempts_remaining: number;
  scope_hash?: string;
  replan_path?: string;
  evidence: ReplanEvidence;
}

export interface ReplanStatus {
  spec_id: string;
  task_id: string;
  status: "active" | "blocked";
  budget: number;
  attempt_count: number;
  attempts_remaining: number;
  last_cause: ReplanCause | null;
  last_remedy: ReplanRemedy | null;
  escalation: ReplanRecord["escalation"] | null;
}

interface FailedScopeTask {
  task_id: string;
  draft_scope: DraftScope;
}

interface ManagerFailure {
  action_type: string;
  reason: string;
  session_path: string;
}

const defaultReplanBudget = 3;

export async function evaluateThrashForPlan(
  repoRoot: string,
  plan: TentativePlan,
  taskId: string,
  budget = defaultReplanBudget
): Promise<SpecResult<ReplanEvaluationResult>> {
  if (!Number.isSafeInteger(budget) || budget < 1) {
    return { ok: false, reason: "re-plan budget must be a positive integer" };
  }

  const task = plan.tasks.find((entry) => entry.task_id === taskId);
  if (task === undefined) {
    return { ok: false, reason: `tentative plan does not contain task ${taskId}` };
  }

  const evidence = await collectThrashEvidence(repoRoot, taskId);
  if (!evidence.ok) {
    return evidence;
  }
  if (evidence.value.failure_count < 2) {
    return {
      ok: true,
      value: {
        spec_id: plan.spec_id,
        task_id: taskId,
        status: "no_thrash",
        budget,
        attempt_count: 0,
        attempts_remaining: budget,
        evidence: evidence.value
      }
    };
  }

  const cause = classifyThrash(evidence.value);
  const remedy = remedyForCause(cause);
  const scope = activeTaskScope(task);
  const scopeHash = hashScope(scope);
  const draftHash = hashScope(task.draft_scope);
  const now = new Date().toISOString();
  const loaded = await readReplanRecord(repoRoot, plan.spec_id, taskId);
  if (!loaded.ok) {
    return loaded;
  }
  const prior = loaded.value;
  const attempt: ReplanAttempt = {
    attempt_id: randomUUID(),
    ts: now,
    scope_hash: scopeHash,
    alternate_scope_hashes: uniqueSorted(scopeHash === draftHash ? [] : [draftHash]),
    scope,
    cause,
    remedy,
    evidence: evidence.value
  };
  const attempts = [...(prior?.attempts ?? []), attempt];
  const known = uniqueSorted([...attempts.flatMap((entry) => [entry.scope_hash, ...entry.alternate_scope_hashes])]);
  const blocked = attempts.length >= budget;
  const record: ReplanRecord = {
    version: 1,
    spec_id: plan.spec_id,
    task_id: taskId,
    status: blocked ? "blocked" : "active",
    budget,
    known_failed_scope_hashes: known,
    attempts,
    ...(blocked
      ? {
          escalation: {
            ts: now,
            cause,
            reason: `re-plan budget exhausted for ${taskId}; escalate ${cause} to the human/spec owner`
          }
        }
      : {})
  };

  await writeJsonAtomic(replanRecordPath(repoRoot, plan.spec_id, taskId), record);
  const replanEvent = await appendEvent(repoRoot, {
    type: "replan.triggered",
    task_id: taskId,
    data: {
      spec_id: plan.spec_id,
      cause,
      remedy,
      scope_hash: scopeHash,
      attempt_count: attempts.length,
      budget,
      status: record.status
    }
  });
  if (!replanEvent.ok) {
    return replanEvent;
  }
  if (blocked) {
    const blockedEvent = await appendEvent(repoRoot, {
      type: "task.blocked",
      task_id: taskId,
      data: {
        spec_id: plan.spec_id,
        cause,
        remedy: "escalate",
        reason: record.escalation?.reason ?? "re-plan budget exhausted"
      }
    });
    if (!blockedEvent.ok) {
      return blockedEvent;
    }
  }

  return {
    ok: true,
    value: {
      spec_id: plan.spec_id,
      task_id: taskId,
      status: blocked ? "blocked" : "replan_required",
      cause,
      remedy,
      budget,
      attempt_count: attempts.length,
      attempts_remaining: Math.max(0, budget - attempts.length),
      scope_hash: scopeHash,
      replan_path: replanRecordRelativePath(plan.spec_id, taskId),
      evidence: evidence.value
    }
  };
}

export async function assertNoKnownFailedScopeRepeat(
  repoRoot: string,
  specId: string,
  tasks: FailedScopeTask[]
): Promise<SpecResult<void>> {
  for (const task of tasks) {
    const loaded = await readReplanRecord(repoRoot, specId, task.task_id);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value === null) {
      continue;
    }
    const proposedHash = hashScope(task.draft_scope);
    if (loaded.value.known_failed_scope_hashes.includes(proposedHash)) {
      return {
        ok: false,
        reason: `known failed scope repeat: task ${task.task_id} re-proposes scope ${proposedHash} from ${replanRecordRelativePath(specId, task.task_id)}`
      };
    }
  }
  return { ok: true, value: undefined };
}

export async function listReplanStatuses(repoRoot: string): Promise<SpecResult<ReplanStatus[]>> {
  const recordsDir = path.join(repoRoot, ".hivemind", "replans");
  let entries: string[];
  try {
    entries = await readdir(recordsDir);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: [] };
    }
    throw error;
  }

  const statuses: ReplanStatus[] = [];
  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const raw = await readJson(path.join(recordsDir, entry), `.hivemind/replans/${entry}`);
    if (!raw.ok) {
      return raw;
    }
    const record = validateReplanRecord(raw.value, `.hivemind/replans/${entry}`);
    if (!record.ok) {
      return record;
    }
    const last = record.value.attempts.at(-1);
    statuses.push({
      spec_id: record.value.spec_id,
      task_id: record.value.task_id,
      status: record.value.status,
      budget: record.value.budget,
      attempt_count: record.value.attempts.length,
      attempts_remaining: Math.max(0, record.value.budget - record.value.attempts.length),
      last_cause: last?.cause ?? null,
      last_remedy: last?.remedy ?? null,
      escalation: record.value.escalation ?? null
    });
  }
  return { ok: true, value: statuses };
}

function activeTaskScope(task: TentativePlanTask): DraftScope {
  return task.grounded_scope ?? task.draft_scope;
}

function hashScope(scope: DraftScope): string {
  return createHash("sha256").update(JSON.stringify(canonicalScope(scope))).digest("hex");
}

function canonicalScope(scope: DraftScope): DraftScope {
  return {
    allowed_files: uniqueSorted(scope.allowed_files),
    read_only_files: uniqueSorted(scope.read_only_files),
    forbidden_files: uniqueSorted(scope.forbidden_files),
    must_not_change: uniqueSorted(scope.must_not_change)
  };
}

async function collectThrashEvidence(repoRoot: string, taskId: string): Promise<SpecResult<ReplanEvidence>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const eventReasons = events.value.filter((event) => event.task_id === taskId).flatMap(eventFailureReason);
  const managerFailures = await readManagerFailures(repoRoot, taskId);
  if (!managerFailures.ok) {
    return managerFailures;
  }
  const managerReasons = managerFailures.value.map((failure) => `${failure.action_type}: ${failure.reason}`);
  const reasons = uniqueSorted([...eventReasons, ...managerReasons]);
  return {
    ok: true,
    value: {
      failure_count: eventReasons.length + managerFailures.value.length,
      event_count: eventReasons.length,
      manager_failure_count: managerFailures.value.length,
      reasons,
      session_paths: uniqueSorted(managerFailures.value.map((failure) => failure.session_path))
    }
  };
}

function eventFailureReason(event: HivemindEvent): string[] {
  if (event.type === "patch.rejected") {
    return [readReason(event.data, "patch rejected")];
  }
  if (event.type === "lease.rejected") {
    return [readReason(event.data, "lease rejected")];
  }
  if (event.type === "write_intent.rejected") {
    return [readReason(event.data, "write intent rejected")];
  }
  if (event.type === "task.blocked") {
    return [readReason(event.data, "task blocked")];
  }
  return [];
}

async function readManagerFailures(repoRoot: string, taskId: string): Promise<SpecResult<ManagerFailure[]>> {
  const sessionsDir = path.join(repoRoot, ".hivemind", "orchestrator", "sessions");
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: [] };
    }
    throw error;
  }

  const failures: ManagerFailure[] = [];
  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const relativePath = `.hivemind/orchestrator/sessions/${entry}`;
    const raw = await readJson(path.join(sessionsDir, entry), relativePath);
    if (!raw.ok) {
      return raw;
    }
    if (!isRecord(raw.value) || !Array.isArray(raw.value.executed_actions)) {
      return { ok: false, reason: `${relativePath} must contain executed_actions` };
    }
    for (const action of raw.value.executed_actions) {
      if (!isRecord(action) || typeof action.type !== "string" || !isRecord(action.result)) {
        return { ok: false, reason: `${relativePath} contains an invalid executed action` };
      }
      if (!actionMatchesTask(action, taskId) || action.result.ok !== false || typeof action.result.reason !== "string") {
        continue;
      }
      failures.push({
        action_type: action.type,
        reason: action.result.reason,
        session_path: relativePath
      });
    }
  }
  return { ok: true, value: failures };
}

function actionMatchesTask(action: Record<string, unknown>, taskId: string): boolean {
  return typeof action.task_id === "string" && action.task_id === taskId;
}

function classifyThrash(evidence: ReplanEvidence): ReplanCause {
  const haystack = evidence.reasons.join("\n").toLowerCase();
  if (/\b(ambigu|unclear|underspecified|conflicting spec|spec ambiguity)\b/u.test(haystack)) {
    return "spec-ambiguity";
  }
  if (/\b(overlap|conflict|already held|lease|parallel_scope_overlap|both allow)\b/u.test(haystack)) {
    return "overlap";
  }
  if (evidence.reasons.filter((reason) => reason.toLowerCase().startsWith("run_worker:")).length >= 2) {
    return "agent-incapable";
  }
  if (/\b(outside scope|out-of-scope|not allowed|outside allowed|allowed_files|diff-scope|must not change|outside the granted lease)\b/u.test(haystack)) {
    return "scope-too-narrow";
  }
  return "spec-ambiguity";
}

function remedyForCause(cause: ReplanCause): ReplanRemedy {
  if (cause === "scope-too-narrow") {
    return "widen";
  }
  if (cause === "overlap") {
    return "re-sequence";
  }
  if (cause === "agent-incapable") {
    return "re-route";
  }
  return "escalate";
}

async function readReplanRecord(repoRoot: string, specId: string, taskId: string): Promise<SpecResult<ReplanRecord | null>> {
  const relativePath = replanRecordRelativePath(specId, taskId);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: null };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in ${relativePath}` };
    }
    throw error;
  }
  const record = validateReplanRecord(raw, relativePath);
  if (!record.ok) {
    return record;
  }
  if (record.value.spec_id !== specId || record.value.task_id !== taskId) {
    return { ok: false, reason: `${relativePath} must contain spec_id ${specId} and task_id ${taskId}` };
  }
  return record;
}

function validateReplanRecord(raw: unknown, relativePath: string): SpecResult<ReplanRecord> {
  if (!isRecord(raw)) {
    return { ok: false, reason: `${relativePath} must be a JSON object` };
  }
  const gated = checkFormatVersion(raw, formatVersions.replan, relativePath);
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  if (typeof raw.spec_id !== "string" || raw.spec_id.trim() === "") {
    return { ok: false, reason: `${relativePath} spec_id must be a non-empty string` };
  }
  if (typeof raw.task_id !== "string" || raw.task_id.trim() === "") {
    return { ok: false, reason: `${relativePath} task_id must be a non-empty string` };
  }
  if (raw.status !== "active" && raw.status !== "blocked") {
    return { ok: false, reason: `${relativePath} status must be active or blocked` };
  }
  if (typeof raw.budget !== "number" || !Number.isSafeInteger(raw.budget) || raw.budget < 1) {
    return { ok: false, reason: `${relativePath} budget must be a positive integer` };
  }
  if (!Array.isArray(raw.known_failed_scope_hashes) || !raw.known_failed_scope_hashes.every((entry) => typeof entry === "string")) {
    return { ok: false, reason: `${relativePath} known_failed_scope_hashes must be an array of strings` };
  }
  if (!Array.isArray(raw.attempts)) {
    return { ok: false, reason: `${relativePath} attempts must be an array` };
  }
  for (const [index, attempt] of raw.attempts.entries()) {
    const attemptResult = validateReplanAttempt(attempt, `${relativePath} attempts[${index}]`);
    if (!attemptResult.ok) {
      return attemptResult;
    }
  }
  if (raw.escalation !== undefined && !isValidEscalation(raw.escalation)) {
    return { ok: false, reason: `${relativePath} escalation must contain ts, reason, and cause` };
  }
  return { ok: true, value: raw as unknown as ReplanRecord };
}

function validateReplanAttempt(raw: unknown, label: string): SpecResult<void> {
  if (!isRecord(raw)) {
    return { ok: false, reason: `${label} must be a JSON object` };
  }
  if (typeof raw.attempt_id !== "string" || raw.attempt_id.trim() === "") {
    return { ok: false, reason: `${label}.attempt_id must be a non-empty string` };
  }
  if (typeof raw.ts !== "string" || Number.isNaN(Date.parse(raw.ts))) {
    return { ok: false, reason: `${label}.ts must be an ISO timestamp string` };
  }
  if (typeof raw.scope_hash !== "string" || raw.scope_hash.trim() === "") {
    return { ok: false, reason: `${label}.scope_hash must be a non-empty string` };
  }
  if (!Array.isArray(raw.alternate_scope_hashes) || !raw.alternate_scope_hashes.every((entry) => typeof entry === "string")) {
    return { ok: false, reason: `${label}.alternate_scope_hashes must be an array of strings` };
  }
  if (!isCause(raw.cause)) {
    return { ok: false, reason: `${label}.cause is invalid` };
  }
  if (!isRemedy(raw.remedy)) {
    return { ok: false, reason: `${label}.remedy is invalid` };
  }
  if (!isRecord(raw.scope) || !isStringArray(raw.scope.allowed_files) || !isStringArray(raw.scope.read_only_files) || !isStringArray(raw.scope.forbidden_files) || !isStringArray(raw.scope.must_not_change)) {
    return { ok: false, reason: `${label}.scope must contain scope path arrays` };
  }
  if (!isRecord(raw.evidence) || !Number.isSafeInteger(raw.evidence.failure_count)) {
    return { ok: false, reason: `${label}.evidence must contain failure_count` };
  }
  return { ok: true, value: undefined };
}

function isValidEscalation(value: unknown): value is ReplanRecord["escalation"] {
  return isRecord(value) && typeof value.ts === "string" && !Number.isNaN(Date.parse(value.ts)) && typeof value.reason === "string" && isCause(value.cause);
}

function isCause(value: unknown): value is ReplanCause {
  return value === "scope-too-narrow" || value === "overlap" || value === "agent-incapable" || value === "spec-ambiguity";
}

function isRemedy(value: unknown): value is ReplanRemedy {
  return value === "widen" || value === "re-sequence" || value === "re-route" || value === "escalate";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

async function readJson(filePath: string, relativePath: string): Promise<SpecResult<unknown>> {
  try {
    return { ok: true, value: JSON.parse(await readFile(filePath, "utf8")) };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in ${relativePath}` };
    }
    throw error;
  }
}

function readReason(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.reason === "string" && data.reason.trim() !== "") {
    return data.reason;
  }
  return `${fallback}: ${JSON.stringify(data)}`;
}

function replanRecordPath(repoRoot: string, specId: string, taskId: string): string {
  return path.join(repoRoot, replanRecordRelativePath(specId, taskId));
}

function replanRecordRelativePath(specId: string, taskId: string): string {
  return `.hivemind/replans/${specId}.${taskId}.json`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
