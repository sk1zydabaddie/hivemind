import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeTask } from "./analyze.js";
import { applyPatchToCheckout, withDetachedCheckout } from "./changeset.js";
import { loadConfig } from "./config.js";
import { loadAndValidateContract } from "./contract.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import {
  readActiveLeases,
  runWithHeldTaskLeases,
  verifyLeaseCoverage,
  type TaskLeaseRequirement
} from "./lease.js";
import { removeTaskWorktree } from "./worktree.js";
import { codedFailure, type CodedFailure, type FailureCode } from "./failure-code.js";
import {
  hashJson,
  loadVerificationSet,
  verificationInputsStillMatch,
  type StoredVerificationSet,
  type VerificationSetManifest
} from "./verification-set.js";

const execFileAsync = promisify(execFile);

export interface AdoptionReview {
  pending_adoption_id: string;
  verification_id: string;
  expected_base_head: string;
  expected_state_hash: string;
  base_branch: string;
  task_ids: string[];
  changed_files: string[];
}

export interface AdoptionAuthorization {
  pending_adoption_id: string;
  verification_id: string;
  expected_base_head: string;
  expected_state_hash: string;
}

export interface AdoptionCompletion {
  adoption_id: string;
  verification_id: string;
  task_ids: string[];
  pre_adoption_ref: string;
  adopted_ref: string;
  result_tree: string;
  reconciled: boolean;
}

type AdoptionResult<T> = { ok: true; value: T } | CodedFailure;

interface AdoptionState {
  stored: StoredVerificationSet;
  live_base_head: string;
  lease_store: Record<string, string>;
  state_hash: string;
}

export interface AdoptionReadiness {
  status: "none" | "needs_reverification" | "ready" | "adopted";
  reason_code: "none" | "missing_provenance" | "moved_head" | "changed_inputs" | "lease_problem" | "oracle_block" | "verification_failed" | "base_worktree" | "unknown";
  reason: string;
  verification_id: string | null;
  task_ids: string[];
  changed_files: string[];
  base_commit: string | null;
  base_branch: string | null;
  verified_at: string | null;
}

export async function inspectLatestAdoptionReadiness(repoRoot: string): Promise<AdoptionResult<AdoptionReadiness>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const latest = [...events.value].reverse().find((event) =>
    ["integration.passed", "integration.failed", "integration.blocked", "verification.rerun_failed"].includes(event.type)
  );
  if (latest === undefined) return { ok: true, value: emptyReadiness() };
  const taskIds = stringArray(latest.data.applied) ?? stringArray(latest.data.task_ids) ?? [];
  if (latest.type === "integration.blocked") {
    return { ok: true, value: blockedReadiness(
      latest,
      taskIds,
      "oracle_block",
      eventReason(latest) ?? "Fresh project checks are blocked by the configured coverage requirement."
    ) };
  }
  if (latest.type === "integration.failed" || latest.type === "verification.rerun_failed") {
    const reason = eventReason(latest) ?? "The latest project checks did not complete successfully.";
    return { ok: true, value: blockedReadiness(latest, taskIds, "verification_failed", reason) };
  }
  const verificationId = typeof latest.data.verification_id === "string" ? latest.data.verification_id : null;
  if (
    verificationId === null ||
    typeof latest.data.verification_manifest_path !== "string" ||
    typeof latest.data.verification_manifest_sha256 !== "string"
  ) {
    return {
      ok: true,
      value: {
        ...blockedReadiness(latest, taskIds, "missing_provenance", "These checks predate verified-set provenance. Run the real project checks again before adoption."),
        verification_id: verificationId
      }
    };
  }
  if (events.value.some((event) => event.type === "adoption.completed" && event.data.verification_id === verificationId)) {
    return { ok: true, value: {
      status: "adopted", reason_code: "none", reason: "The exact verified set is already on the project branch.",
      verification_id: verificationId, task_ids: taskIds, changed_files: [], base_commit: null, base_branch: null, verified_at: latest.ts
    } };
  }
  const state = await deriveAdoptionState(repoRoot, verificationId);
  if (!state.ok) return { ok: true, value: failedReadiness(latest, verificationId, taskIds, state) };
  const ownership = await validateAdoptionOwnership(repoRoot, state.value.stored.manifest);
  if (!ownership.ok) return { ok: true, value: failedReadiness(latest, verificationId, taskIds, ownership) };
  const canonical = await requireCleanCanonicalBase(
    repoRoot,
    state.value.stored.manifest.base_branch,
    state.value.stored.manifest.base_commit
  );
  if (!canonical.ok) return { ok: true, value: failedReadiness(latest, verificationId, taskIds, canonical) };
  return { ok: true, value: {
    status: "ready",
    reason_code: "none",
    reason: "The exact verified set still matches the project and is ready for review.",
    verification_id: verificationId,
    task_ids: [...state.value.stored.manifest.task_ids],
    changed_files: [...state.value.stored.manifest.changed_files],
    base_commit: state.value.stored.manifest.base_commit,
    base_branch: state.value.stored.manifest.base_branch,
    verified_at: latest.ts
  } };
}

export async function reviewVerifiedSetAdoption(
  repoRoot: string,
  verificationId: string
): Promise<AdoptionResult<AdoptionReview>> {
  const state = await deriveAdoptionState(repoRoot, verificationId);
  if (!state.ok) return state;
  const preconditions = await validateAdoptionPreconditions(repoRoot, state.value.stored.manifest);
  if (!preconditions.ok) return preconditions;
  const canonical = await requireCleanCanonicalBase(
    repoRoot,
    state.value.stored.manifest.base_branch,
    state.value.stored.manifest.base_commit
  );
  if (!canonical.ok) return canonical;
  const pendingId = `PA-${randomUUID()}`;
  const value: AdoptionReview = {
    pending_adoption_id: pendingId,
    verification_id: verificationId,
    expected_base_head: state.value.live_base_head,
    expected_state_hash: state.value.state_hash,
    base_branch: state.value.stored.manifest.base_branch,
    task_ids: [...state.value.stored.manifest.task_ids],
    changed_files: [...state.value.stored.manifest.changed_files]
  };
  const event = await appendEvent(repoRoot, {
    type: "adoption.reviewed",
    task_id: null,
    data: { ...value }
  });
  return event.ok ? { ok: true, value } : { ok: false, reason: `failed to record adoption review: ${event.reason}` };
}

export async function adoptVerifiedSet(
  repoRoot: string,
  authorization: AdoptionAuthorization
): Promise<AdoptionResult<AdoptionCompletion>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const reviewed = findLastEvent(events.value, (event) =>
    event.type === "adoption.reviewed" && event.data.pending_adoption_id === authorization.pending_adoption_id
  );
  if (reviewed === undefined || !reviewMatchesAuthorization(reviewed, authorization)) {
    return { ok: false, reason: "adoption authorization does not match a durable pending review" };
  }
  if (events.value.some((event) =>
    ["adoption.started", "adoption.completed"].includes(event.type) &&
    event.data.pending_adoption_id === authorization.pending_adoption_id
  )) {
    return { ok: false, reason: "pending adoption authorization was already consumed" };
  }

  const state = await deriveAdoptionState(repoRoot, authorization.verification_id);
  if (!state.ok) return recordPretransitionFailure(repoRoot, authorization, state.reason);
  if (
    authorization.expected_base_head !== state.value.live_base_head ||
    authorization.expected_state_hash !== state.value.state_hash
  ) {
    return recordPretransitionFailure(repoRoot, authorization, "verified-then-stale: adoption state changed after review");
  }
  const manifest = state.value.stored.manifest;
  const preconditions = await validateAdoptionPreconditions(repoRoot, manifest);
  if (!preconditions.ok) return recordPretransitionFailure(repoRoot, authorization, preconditions.reason);
  const canonical = await requireCleanCanonicalBase(repoRoot, manifest.base_branch, manifest.base_commit);
  if (!canonical.ok) return recordPretransitionFailure(repoRoot, authorization, canonical.reason);
  const candidate = await buildCandidateCommit(repoRoot, manifest);
  if (!candidate.ok) return recordPretransitionFailure(repoRoot, authorization, candidate.reason);

  const adoptionId = `A-${randomUUID()}`;
  const startedData = {
    adoption_id: adoptionId,
    pending_adoption_id: authorization.pending_adoption_id,
    verification_id: authorization.verification_id,
    manifest_path: state.value.stored.manifest_path,
    manifest_sha256: state.value.stored.manifest_sha256,
    base_branch: manifest.base_branch,
    pre_adoption_ref: manifest.base_commit,
    candidate_commit: candidate.value.commit,
    candidate_tree: candidate.value.tree,
    task_ids: manifest.task_ids,
    lease_requirements: preconditions.value
  };
  const guarded = await runWithHeldTaskLeases(repoRoot, preconditions.value, async () => {
    const liveCanonical = await requireCleanCanonicalBase(repoRoot, manifest.base_branch, manifest.base_commit);
    if (!liveCanonical.ok) return liveCanonical;
    const started = await appendEvent(repoRoot, { type: "adoption.started", task_id: null, data: startedData });
    if (!started.ok) return { ok: false, reason: `failed to record adoption intent: ${started.reason}` };
    const transition = await git(repoRoot, ["merge", "--ff-only", candidate.value.commit]);
    if (!transition.ok) return { ok: false, reason: `adoption base transition failed: ${transition.reason}` };
    const exact = await requireExactCandidate(repoRoot, candidate.value.commit, candidate.value.tree);
    if (!exact.ok) return exact;
    const cleanup = await cleanupAdoptedTasks(repoRoot, manifest.task_ids);
    return cleanup.ok ? { ok: true as const, value: true } : cleanup;
  });
  if (!guarded.ok) {
    const head = await git(repoRoot, ["rev-parse", "HEAD"]);
    if (head.ok && head.stdout.trim() === candidate.value.commit) {
      return recordIndeterminateAttempt(
        repoRoot,
        startedData,
        `adoption transitioned the base but finalization is incomplete: ${guarded.reason}`,
        candidate.value.commit,
        true
      );
    }
    if (!head.ok || head.stdout.trim() !== manifest.base_commit) {
      return recordIndeterminateAttempt(
        repoRoot,
        startedData,
        `adoption base state is indeterminate after failure: ${guarded.reason}`,
        head.ok ? head.stdout.trim() : null,
        false
      );
    }
    return recordStartedFailure(repoRoot, startedData, guarded.reason);
  }
  return appendAdoptionCompletion(repoRoot, startedData, false);
}

export async function reconcileAdoptionsOnStartup(repoRoot: string): Promise<AdoptionResult<{ reconciled: number }>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const open = openAdoptionStarts(events.value);
  let reconciled = 0;
  for (const started of open) {
    const candidate = requiredEventString(started, "candidate_commit");
    const candidateTree = requiredEventString(started, "candidate_tree");
    const oldRef = requiredEventString(started, "pre_adoption_ref");
    if (!candidate.ok || !candidateTree.ok || !oldRef.ok) {
      const recorded = await appendIndeterminate(repoRoot, started, "adoption intent is malformed", null, false);
      if (!recorded.ok) return recorded;
      continue;
    }
    const head = await git(repoRoot, ["rev-parse", "HEAD"]);
    if (!head.ok) {
      const recorded = await appendIndeterminate(repoRoot, started, `cannot read live base ref: ${head.reason}`, null, true);
      if (!recorded.ok) return recorded;
      continue;
    }
    if (head.stdout.trim() === oldRef.value) {
      const recorded = await appendEvent(repoRoot, {
        type: "adoption.failed",
        task_id: null,
        data: { ...started.data, phase: "reconciliation", reason: "base transition did not occur" }
      });
      if (!recorded.ok) return { ok: false, reason: `failed to record adoption reconciliation failure: ${recorded.reason}` };
      continue;
    }
    if (head.stdout.trim() !== candidate.value) {
      const recorded = await appendIndeterminate(repoRoot, started, "live base ref matches neither the pre-adoption nor candidate ref", head.stdout.trim(), false);
      if (!recorded.ok) return recorded;
      continue;
    }
    const tree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
    if (!tree.ok || tree.stdout.trim() !== candidateTree.value) {
      const recorded = await appendIndeterminate(repoRoot, started, "candidate ref is present but its tree does not match the adoption intent", head.stdout.trim(), false);
      if (!recorded.ok) return recorded;
      continue;
    }
    const finalized = await reconcileExactCandidate(repoRoot, started.data);
    if (!finalized.ok) return finalized;
    reconciled += 1;
  }
  return { ok: true, value: { reconciled } };
}

async function deriveAdoptionState(repoRoot: string, verificationId: string): Promise<AdoptionResult<AdoptionState>> {
  const stored = await loadVerificationSet(repoRoot, verificationId);
  if (!stored.ok) return stored;
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const passed = findLastEvent(events.value, (event) =>
    event.type === "integration.passed" &&
    event.data.verification_id === verificationId &&
    event.data.verification_manifest_path === stored.value.manifest_path &&
    event.data.verification_manifest_sha256 === stored.value.manifest_sha256
  );
  if (passed === undefined) {
    return codedFailure("adoption_inputs_changed", "verification set is not bound to a durable integration.passed event");
  }
  if (!sameStrings(passed.data.applied, stored.value.manifest.task_ids)) {
    return codedFailure("adoption_inputs_changed", "verification set is only partially verified or event task identities differ");
  }
  const unchanged = await verificationInputsStillMatch(repoRoot, stored.value.manifest);
  // Every failure from this check is by definition "the verified inputs no
  // longer match". Adoption classifies it by WHICH CHECK failed, not by what
  // the check said -- verification-set.ts has no business knowing adoption's
  // vocabulary, so the mapping lives here, once.
  if (!unchanged.ok) return codedFailure("adoption_inputs_changed", unchanged.reason);
  const head = await git(repoRoot, ["rev-parse", `refs/heads/${stored.value.manifest.base_branch}`]);
  if (!head.ok) return codedFailure("adoption_base_moved", `cannot resolve configured base ref: ${head.reason}`);
  const liveHead = head.stdout.trim();
  if (liveHead !== stored.value.manifest.base_commit) {
    return codedFailure("adoption_base_moved", `verified-then-stale: live base HEAD ${liveHead} != verified base ${stored.value.manifest.base_commit}`);
  }
  const leases = await readActiveLeases(repoRoot);
  if (!leases.ok) return leases;
  const stateHash = hashJson({
    verification_id: verificationId,
    manifest_sha256: stored.value.manifest_sha256,
    base_branch: stored.value.manifest.base_branch,
    live_base_head: liveHead,
    config_sha256: stored.value.manifest.config_sha256,
    inputs: stored.value.manifest.inputs,
    lease_store: leases.store,
    oracle: stored.value.manifest.oracle
  });
  return { ok: true, value: { stored: stored.value, live_base_head: liveHead, lease_store: leases.store, state_hash: stateHash } };
}

async function validateAdoptionPreconditions(repoRoot: string, manifest: VerificationSetManifest): Promise<AdoptionResult<TaskLeaseRequirement[]>> {
  const ownership = await validateAdoptionOwnership(repoRoot, manifest);
  if (!ownership.ok) return ownership;
  for (const input of manifest.inputs) {
    const analyzed = await analyzeTask(repoRoot, input.task_id, { emitEvent: false });
    if (!analyzed.ok || analyzed.value.verdict !== "accept") {
      return { ok: false, reason: `patch gate refused ${input.task_id}: ${analyzed.ok ? analyzed.value.reason : analyzed.reason}` };
    }
  }
  return ownership;
}

async function validateAdoptionOwnership(repoRoot: string, manifest: VerificationSetManifest): Promise<AdoptionResult<TaskLeaseRequirement[]>> {
  if (manifest.oracle.decision === "block") return codedFailure("adoption_oracle_block", "oracle floor blocked this verification set");
  if (manifest.oracle.coverage_configured && manifest.oracle.binding && manifest.oracle.status !== "strong") {
    return codedFailure("adoption_oracle_block", `oracle floor refuses ${manifest.oracle.task_tier} adoption with ${manifest.oracle.status} coverage evidence`);
  }
  const leaseRequirements: TaskLeaseRequirement[] = [];
  for (const input of manifest.inputs) {
    const contract = await loadAndValidateContract(repoRoot, input.task_id);
    if (!contract.ok) return contract;
    if (contract.contract.base_commit !== manifest.base_commit) {
      return codedFailure("adoption_inputs_changed", `verified-then-stale: ${input.task_id} base_commit differs from the verification set`);
    }
    const lease = await verifyLeaseCoverage(repoRoot, input.task_id, contract.contract.allowed_files, {
      baseCommit: contract.contract.base_commit,
      allowedFileIntents: contract.contract.allowed_file_intents
    });
    if (!lease.ok) return codedFailure("adoption_lease_problem", `adoption lease precondition failed for ${input.task_id}: ${lease.reason}`);
    leaseRequirements.push({ task_id: input.task_id, files: lease.files });
  }
  return { ok: true, value: leaseRequirements };
}

function emptyReadiness(): AdoptionReadiness {
  return { status: "none", reason_code: "none", reason: "No verified set is waiting for adoption.", verification_id: null, task_ids: [], changed_files: [], base_commit: null, base_branch: null, verified_at: null };
}

function blockedReadiness(
  event: HivemindEvent,
  taskIds: string[],
  reasonCode: AdoptionReadiness["reason_code"],
  reason: string
): AdoptionReadiness {
  return { status: "needs_reverification", reason_code: reasonCode, reason, verification_id: null, task_ids: taskIds, changed_files: [], base_commit: null, base_branch: null, verified_at: event.ts };
}

/**
 * Maps the code the failing check produced onto what a person is told.
 *
 * This used to regex the reason to guess which check had failed, and that
 * decides what somebody reads about a failed write to their own branch: a
 * reworded upstream sentence silently turned a specific diagnosis into
 * "unknown". The idea -- a typed reason_code -- was right; the source was not.
 *
 * "unknown" now means the check genuinely did not classify itself, which is
 * honest, rather than meaning a regex missed.
 */
const adoptionReasonCodes: Record<string, AdoptionReadiness["reason_code"]> = {
  adoption_base_moved: "moved_head",
  adoption_inputs_changed: "changed_inputs",
  adoption_lease_problem: "lease_problem",
  adoption_oracle_block: "oracle_block",
  adoption_base_worktree: "base_worktree"
};

/** Exported so the mapping itself is testable without staging a whole repo. */
export function adoptionReasonCodeFor(failure: { code?: FailureCode }): AdoptionReadiness["reason_code"] {
  return (failure.code === undefined ? undefined : adoptionReasonCodes[failure.code]) ?? "unknown";
}

function failedReadiness(
  event: HivemindEvent,
  verificationId: string,
  taskIds: string[],
  failure: { reason: string; code?: FailureCode }
): AdoptionReadiness {
  const reasonCode = adoptionReasonCodeFor(failure);
  return { status: "needs_reverification", reason_code: reasonCode, reason: failure.reason, verification_id: verificationId, task_ids: taskIds, changed_files: [], base_commit: null, base_branch: null, verified_at: event.ts };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function eventReason(event: HivemindEvent): string | null {
  for (const key of ["plain_reason", "reason", "diagnostic", "recommendation", "report"]) {
    if (typeof event.data[key] === "string" && event.data[key].trim() !== "") return event.data[key] as string;
  }
  return null;
}

async function requireCleanCanonicalBase(repoRoot: string, branch: string, expectedHead: string): Promise<AdoptionResult<true>> {
  const current = await git(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (!current.ok || current.stdout.trim() !== branch) {
    return codedFailure("adoption_base_worktree", `adoption requires the clean checked-out base branch ${branch}`);
  }
  const head = await git(repoRoot, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim() !== expectedHead) {
    return codedFailure("adoption_base_moved", "verified-then-stale: checked-out base HEAD changed before adoption");
  }
  const status = await git(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).hivemind"
  ]);
  if (!status.ok || status.stdout !== "") {
    return { ok: false, reason: "adoption requires a clean base worktree with no tracked or untracked changes" };
  }
  return { ok: true, value: true };
}

async function buildCandidateCommit(repoRoot: string, manifest: VerificationSetManifest): Promise<AdoptionResult<{ commit: string; tree: string }>> {
  const checkout = await withDetachedCheckout(repoRoot, manifest.base_commit, async (checkoutPath) => {
    for (const input of manifest.inputs) {
      const applied = await applyPatchToCheckout(checkoutPath, path.join(repoRoot, ...input.patch_path.split("/")));
      if (!applied.ok) return applied;
    }
    const tree = await git(checkoutPath, ["write-tree"]);
    if (!tree.ok) return tree;
    if (tree.stdout.trim() !== manifest.result_tree) {
      return { ok: false as const, reason: "verified-then-stale: re-derived candidate tree differs from the verified tree" };
    }
    const commit = await git(checkoutPath, ["commit-tree", tree.stdout.trim(), "-p", manifest.base_commit, "-m", `Hivemind adoption ${manifest.verification_id}`], {
      GIT_AUTHOR_NAME: "Hivemind",
      GIT_AUTHOR_EMAIL: "hivemind@local",
      GIT_COMMITTER_NAME: "Hivemind",
      GIT_COMMITTER_EMAIL: "hivemind@local"
    });
    return commit.ok ? { ok: true as const, commit: commit.stdout.trim(), tree: tree.stdout.trim() } : commit;
  });
  if (!checkout.ok) return checkout;
  return checkout.value.ok
    ? { ok: true, value: { commit: checkout.value.commit, tree: checkout.value.tree } }
    : checkout.value;
}

async function reconcileExactCandidate(
  repoRoot: string,
  started: Record<string, unknown>
): Promise<AdoptionResult<AdoptionCompletion>> {
  const parsed = parseStartedData(started);
  if (!parsed.ok) return parsed;
  const exact = await requireExactCandidate(repoRoot, parsed.value.candidate_commit, parsed.value.candidate_tree);
  if (!exact.ok) return exact;
  const leases = await readActiveLeases(repoRoot);
  if (!leases.ok) return leases;
  const holders = parsed.value.lease_requirements.flatMap((requirement) => requirement.files.map((file) => leases.store[file]));
  const allReleased = holders.every((holder) => holder === undefined);
  const allHeld = parsed.value.lease_requirements.every((requirement) =>
    requirement.files.every((file) => leases.store[file] === requirement.task_id)
  );
  if (!allReleased && !allHeld) {
    return { ok: false, reason: "adoption lease state is mixed or held by another task during reconciliation" };
  }
  if (allHeld) {
    const finalized = await runWithHeldTaskLeases(repoRoot, parsed.value.lease_requirements, async () => {
      const cleanup = await cleanupAdoptedTasks(repoRoot, parsed.value.task_ids);
      return cleanup.ok ? { ok: true as const, value: true } : cleanup;
    });
    if (!finalized.ok) return finalized;
  } else {
    const cleanup = await cleanupAdoptedTasks(repoRoot, parsed.value.task_ids);
    if (!cleanup.ok) return cleanup;
  }
  return appendAdoptionCompletion(repoRoot, started, true);
}

async function appendAdoptionCompletion(
  repoRoot: string,
  started: Record<string, unknown>,
  reconciled: boolean
): Promise<AdoptionResult<AdoptionCompletion>> {
  const parsed = parseStartedData(started);
  if (!parsed.ok) return parsed;
  const value: AdoptionCompletion = {
    adoption_id: parsed.value.adoption_id,
    verification_id: parsed.value.verification_id,
    task_ids: parsed.value.task_ids,
    pre_adoption_ref: parsed.value.pre_adoption_ref,
    adopted_ref: parsed.value.candidate_commit,
    result_tree: parsed.value.candidate_tree,
    reconciled
  };
  const event = await appendEvent(repoRoot, {
    type: "adoption.completed",
    task_id: null,
    data: {
      ...started,
      ...value,
      recoverability: {
        pre_adoption_ref: value.pre_adoption_ref,
        adopted_ref: value.adopted_ref,
        automatic_rollback: false
      }
    }
  });
  return event.ok ? { ok: true, value } : { ok: false, reason: `failed to append adoption.completed: ${event.reason}` };
}

async function requireExactCandidate(repoRoot: string, commit: string, treeHash: string): Promise<AdoptionResult<true>> {
  const head = await git(repoRoot, ["rev-parse", "HEAD"]);
  const tree = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  return head.ok && tree.ok && head.stdout.trim() === commit && tree.stdout.trim() === treeHash
    ? { ok: true, value: true }
    : { ok: false, reason: "live base ref/tree does not match the recorded adoption candidate" };
}

async function cleanupAdoptedTasks(repoRoot: string, taskIds: string[]): Promise<AdoptionResult<true>> {
  for (const taskId of taskIds) {
    const removed = await removeTaskWorktree(repoRoot, taskId, { discardChanges: true });
    if (!removed.ok) return { ok: false, reason: `adopted base is exact but cleanup failed for ${taskId}: ${removed.reason}` };
  }
  return { ok: true, value: true };
}

async function recordPretransitionFailure<T>(
  repoRoot: string,
  authorization: AdoptionAuthorization,
  reason: string
): Promise<AdoptionResult<T>> {
  const event = await appendEvent(repoRoot, {
    type: "adoption.failed",
    task_id: null,
    data: { ...authorization, phase: "precondition", reason }
  });
  return event.ok ? { ok: false, reason } : { ok: false, reason: `${reason}; failed to record refusal: ${event.reason}` };
}

async function recordStartedFailure<T>(repoRoot: string, started: Record<string, unknown>, reason: string): Promise<AdoptionResult<T>> {
  const event = await appendEvent(repoRoot, {
    type: "adoption.failed",
    task_id: null,
    data: { ...started, phase: "base_transition", reason }
  });
  return event.ok ? { ok: false, reason } : { ok: false, reason: `${reason}; failed to record adoption failure: ${event.reason}` };
}

// The observed HEAD is what makes an indeterminate record actionable by hand:
// with pre_adoption_ref, candidate_commit, and what HEAD actually is, a human
// can decide for themselves whether the change landed.
async function recordIndeterminateAttempt<T>(
  repoRoot: string,
  started: Record<string, unknown>,
  reason: string,
  observedHead: string | null,
  resolvable: boolean
): Promise<AdoptionResult<T>> {
  const event = await appendEvent(repoRoot, {
    type: "adoption.indeterminate",
    task_id: null,
    data: { ...started, reason, observed_head: observedHead, resolvable }
  });
  return event.ok ? { ok: false, reason } : { ok: false, reason: `${reason}; failed to record indeterminate adoption: ${event.reason}` };
}

async function appendIndeterminate(
  repoRoot: string,
  started: HivemindEvent,
  reason: string,
  observedHead: string | null,
  resolvable: boolean
): Promise<AdoptionResult<true>> {
  const event = await appendEvent(repoRoot, {
    type: "adoption.indeterminate",
    task_id: null,
    data: { ...started.data, reason, observed_head: observedHead, resolvable }
  });
  return event.ok ? { ok: true, value: true } : { ok: false, reason: `failed to record indeterminate adoption: ${event.reason}` };
}

/**
 * An indeterminate outcome is not one thing.
 *
 * When the base provably transitioned and only finalization is incomplete,
 * later evidence really can resolve it -- clearing whatever blocked cleanup
 * lets reconciliation finish the adoption -- so that record stays open.
 *
 * When the system cannot determine the outcome at all (a malformed intent, a
 * HEAD matching neither ref, a tree that contradicts the intent), reprocessing
 * cannot turn "cannot determine" into a determination. It only re-appends the
 * same conclusion on every daemon start, without bound. Those are terminal.
 *
 * Resolvable records are still bounded, so a condition that never clears -- and
 * a record written before this field existed -- cannot append forever either.
 */
const MAX_INDETERMINATE_ATTEMPTS = 3;

function openAdoptionStarts(events: HivemindEvent[]): HivemindEvent[] {
  const resolved = new Set<unknown>();
  const unresolvable = new Set<unknown>();
  const attempts = new Map<unknown, number>();
  for (const event of events) {
    if (event.type === "adoption.completed" || event.type === "adoption.failed") {
      resolved.add(event.data.adoption_id);
      continue;
    }
    if (event.type !== "adoption.indeterminate") continue;
    const id = event.data.adoption_id;
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    if (event.data.resolvable !== true) unresolvable.add(id);
  }
  return events.filter((event) =>
    event.type === "adoption.started" &&
    !resolved.has(event.data.adoption_id) &&
    !unresolvable.has(event.data.adoption_id) &&
    (attempts.get(event.data.adoption_id) ?? 0) < MAX_INDETERMINATE_ATTEMPTS
  );
}

function reviewMatchesAuthorization(event: HivemindEvent, value: AdoptionAuthorization): boolean {
  return event.data.verification_id === value.verification_id &&
    event.data.expected_base_head === value.expected_base_head &&
    event.data.expected_state_hash === value.expected_state_hash;
}

function sameStrings(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function findLastEvent(events: HivemindEvent[], predicate: (event: HivemindEvent) => boolean): HivemindEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return undefined;
}

function parseStartedData(value: Record<string, unknown>): AdoptionResult<{
  adoption_id: string; verification_id: string; pre_adoption_ref: string; candidate_commit: string; candidate_tree: string; task_ids: string[]; lease_requirements: TaskLeaseRequirement[];
}> {
  const fields = ["adoption_id", "verification_id", "pre_adoption_ref", "candidate_commit", "candidate_tree"] as const;
  for (const field of fields) if (typeof value[field] !== "string" || value[field].trim() === "") return { ok: false, reason: `adoption intent lacks ${field}` };
  if (!Array.isArray(value.task_ids) || !value.task_ids.every((item) => typeof item === "string" && item !== "")) return { ok: false, reason: "adoption intent has invalid task_ids" };
  const leaseRequirements = value.lease_requirements === undefined ? [] : parseLeaseRequirements(value.lease_requirements);
  if (leaseRequirements === null) return { ok: false, reason: "adoption intent has invalid lease_requirements" };
  return { ok: true, value: {
    adoption_id: value.adoption_id as string,
    verification_id: value.verification_id as string,
    pre_adoption_ref: value.pre_adoption_ref as string,
    candidate_commit: value.candidate_commit as string,
    candidate_tree: value.candidate_tree as string,
    task_ids: value.task_ids as string[],
    lease_requirements: leaseRequirements
  } };
}

function parseLeaseRequirements(value: unknown): TaskLeaseRequirement[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: TaskLeaseRequirement[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.task_id !== "string" || !Array.isArray(entry.files) || !entry.files.every((file) => typeof file === "string")) return null;
    parsed.push({ task_id: entry.task_id, files: entry.files as string[] });
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEventString(event: HivemindEvent, field: string): AdoptionResult<string> {
  const value = event.data[field];
  return typeof value === "string" && value !== "" ? { ok: true, value } : { ok: false, reason: `${field} is missing` };
}

async function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env }
    });
    return { ok: true, stdout: result.stdout };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    return { ok: false, reason: stderr || "git command failed" };
  }
}
