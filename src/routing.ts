import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  type AdapterProfile,
  loadAdapterProfile,
  normalizeProfileCostRank,
  normalizeProfileRoutingTier,
  profileAdmitsRole,
  type ProviderRoutingTier
} from "./adapter.js";
import type { HivemindConfig } from "./config.js";
import {
  parseTaskTypePreferences,
  preferenceFor,
  providerCanBeChosenDeliberately
} from "./routing-preferences.js";
import type { TaskContract } from "./contract.js";
import { matchesAny, matchesPattern } from "./glob.js";
import { readPromotedRoutingPolicy } from "./learned-routing.js";
import { readQuotaLedger, type QuotaLedger } from "./resource-ledger.js";
import type { RoutingProviderScorecard } from "./routing-policy-schema.js";

export type TaskTier = "low" | "medium" | "high" | "critical";

export interface RouteDecision {
  task_tier: TaskTier;
  tool: string;
  provider_tier: ProviderRoutingTier;
  profile: AdapterProfile;
  learned_policy?: {
    status: "applied" | "fallback" | "refused_tier_cap";
    reason: string;
    source_evidence_hash: string | null;
  };
}

export interface RouteTaskProviderOptions {
  excludeTools?: string[];
  preference?: "default" | "cheapest" | "strongest";
}

interface ProviderCandidate {
  tool: string;
  profile: AdapterProfile;
  providerTier: ProviderRoutingTier;
  providerRank: number;
  costRank: number;
  pressured: boolean;
}

const providerTierRank: Record<ProviderRoutingTier, number> = {
  local: 0,
  cheap: 1,
  standard: 2,
  strong: 3
};

const taskTierRank: Record<TaskTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};

/**
 * The cheapest PROVIDER TIER each task tier may run on. This is the table to
 * change if you disagree with what routine work costs, and the reasoning is
 * here rather than in a commit message because that is where somebody looking
 * to change it will stand.
 *
 * Measured 2026-08-23, and it inverted the assumption this table was built on:
 *
 * - MODEL CHOICE is the whole cost lever. Effective measured rate spans 3.9x
 *   across the ladder, and codex-terra runs 5.1x codex-luna at equal effort.
 * - REASONING EFFORT is not a cost lever in either direction: it spans ~1.04x
 *   total cost, because reasoning is 0.4-2.5% of a call whose bulk is cached
 *   input. It changes depth substantially and price negligibly, so it is
 *   pinned high everywhere and never traded for money.
 *
 * `medium` used to floor at `standard`, which made every cheap-tier provider
 * structurally ineligible for the tier ORDINARY SOURCE CHANGES land in. The
 * effect was paying roughly five times over on routine work for no measured
 * quality reason -- not a tuning opportunity, a defect. It now floors at
 * `cheap`, which is a deliberate line and not simply "as low as possible":
 * `local` stays reserved for Low, because a local model on a real source
 * change is unmeasured here, while a cheap FRONTIER model is the same family
 * as the standard one and is measured.
 *
 * Why lowering it is safe rather than optimistic: this is a FLOOR, not a pin.
 * High and Critical still force `strong`, risk globs put dangerous paths in
 * those tiers, and `compareCandidates` only prefers cheap for low/medium.
 * A cheap attempt that fails costs itself plus the retry -- about 1.26x one
 * expensive attempt -- so the floor stays profitable until a cheap model fails
 * roughly three routine tasks in four, and deterministic verification is what
 * catches those failures rather than a person noticing later.
 */
const minimumProviderRank: Record<TaskTier, number> = {
  low: providerTierRank.local,
  medium: providerTierRank.cheap,
  high: providerTierRank.strong,
  critical: providerTierRank.strong
};

export async function routeTaskProvider(
  repoRoot: string,
  contract: TaskContract,
  config: HivemindConfig,
  requestedTool?: string,
  options: RouteTaskProviderOptions = {}
): Promise<{ ok: true; value: RouteDecision } | { ok: false; reason: string }> {
  const taskTier = inferTaskTier(contract, config);
  const ledgerResult = await readQuotaLedger(repoRoot);
  if (!ledgerResult.ok) {
    return ledgerResult;
  }
  const excluded = new Set(options.excludeTools ?? []);

  // A named tool is somebody's decision, so roles do not filter it -- roles
  // narrow what routing *picks on its own*, not what an operator may ask for.
  // The tier floor below still applies to a named tool exactly as before.
  if (requestedTool !== undefined) {
    if (excluded.has(requestedTool)) {
      return { ok: false, reason: `provider "${requestedTool}" is excluded from this routing decision` };
    }
    const profileResult = await loadAdapterProfile(repoRoot, requestedTool);
    if (!profileResult.ok) {
      return profileResult;
    }
    const candidate = candidateFromProfile(profileResult.profile, ledgerResult.value);
    const eligibility = checkTierEligibility(taskTier, candidate);
    if (!eligibility.ok) {
      return eligibility;
    }
    return {
      ok: true,
      value: {
        task_tier: taskTier,
        tool: candidate.tool,
        provider_tier: candidate.providerTier,
        profile: candidate.profile
      }
    };
  }

  const candidatesResult = await loadProviderCandidates(repoRoot, ledgerResult.value);
  if (!candidatesResult.ok) {
    return candidatesResult;
  }
  const { candidates, excludedByRole } = candidatesResult.value;
  const eligible = candidates.filter((candidate) => !excluded.has(candidate.tool) && checkTierEligibility(taskTier, candidate).ok);
  if (eligible.length === 0) {
    return { ok: false, reason: noEligibleProviderReason(taskTier, candidates, excluded, excludedByRole) };
  }

  const nonPressured = eligible.filter((candidate) => !candidate.pressured);
  const pool = nonPressured.length > 0 ? nonPressured : eligible;

  /* A person's choice for this KIND of work. The weakest of the three routing
     inputs on purpose: it is applied only after the tier floor has already
     narrowed the pool, so it can never promote a cheap provider into Critical
     work -- it can only choose among providers that were already allowed. */
  const chosen = await applyTaskTypePreference(repoRoot, contract, config, pool);
  if (chosen !== null) {
    return {
      ok: true,
      value: {
        task_tier: taskTier,
        tool: chosen.tool,
        provider_tier: chosen.providerTier,
        profile: chosen.profile
      }
    };
  }

  const preference = options.preference ?? "default";
  if (preference !== "default") {
    const selected = [...pool].sort((left, right) =>
      preference === "cheapest"
        ? compareCheapest(left, right)
        : compareStrongest(left, right)
    )[0];
    return {
      ok: true,
      value: {
        task_tier: taskTier,
        tool: selected.tool,
        provider_tier: selected.providerTier,
        profile: selected.profile
      }
    };
  }
  const learned = await chooseWithPromotedPolicy(repoRoot, contract, taskTier, candidates, pool);
  const selected = learned.selected;
  return {
    ok: true,
    value: {
      task_tier: taskTier,
      tool: selected.tool,
      provider_tier: selected.providerTier,
      profile: selected.profile,
      learned_policy: learned.metadata
    }
  };
}

async function chooseWithPromotedPolicy(
  repoRoot: string,
  contract: TaskContract,
  taskTier: TaskTier,
  allCandidates: ProviderCandidate[],
  eligiblePool: ProviderCandidate[]
): Promise<{
  selected: ProviderCandidate;
  metadata: NonNullable<RouteDecision["learned_policy"]>;
}> {
  const fallback = () => [...eligiblePool].sort((left, right) => compareCandidates(taskTier, left, right))[0];
  const promoted = await readPromotedRoutingPolicy(repoRoot);
  if (promoted.promoted !== "active" || promoted.active_policy === null) {
    return {
      selected: fallback(),
      metadata: {
        status: "fallback",
        reason: promoted.reason ?? "no active learned routing policy",
        source_evidence_hash: null
      }
    };
  }
  const scorecard = promoted.active_policy.task_types.find(
    (entry) => entry.routing_task_type === contract.routing_task_type
  );
  if (scorecard === undefined || scorecard.providers.length === 0) {
    return {
      selected: fallback(),
      metadata: {
        status: "fallback",
        reason: `active learned routing policy has no weights for ${contract.routing_task_type}`,
        source_evidence_hash: promoted.active_policy.source_evidence_hash
      }
    };
  }
  const candidatesByTool = new Map(allCandidates.map((candidate) => [candidate.tool, candidate]));
  const rankedEvidence = scorecard.providers
    .filter((entry) => candidatesByTool.has(entry.provider))
    .sort(compareScorecards);
  if (rankedEvidence.length === 0) {
    return {
      selected: fallback(),
      metadata: {
        status: "fallback",
        reason: `active learned routing policy has no installed provider for ${contract.routing_task_type}`,
        source_evidence_hash: promoted.active_policy.source_evidence_hash
      }
    };
  }
  const learnedWinner = candidatesByTool.get(rankedEvidence[0].provider);
  if (learnedWinner === undefined) {
    return {
      selected: fallback(),
      metadata: {
        status: "fallback",
        reason: "active learned routing winner is unavailable",
        source_evidence_hash: promoted.active_policy.source_evidence_hash
      }
    };
  }
  const eligibility = checkTierEligibility(taskTier, learnedWinner);
  if (!eligibility.ok) {
    return {
      selected: fallback(),
      metadata: {
        status: "refused_tier_cap",
        reason: `learned policy refused: ${eligibility.reason}`,
        source_evidence_hash: promoted.active_policy.source_evidence_hash
      }
    };
  }

  const weights = new Map(scorecard.providers.map((entry) => [entry.provider, entry.weight]));
  const selected = [...eligiblePool].sort((left, right) => {
    const weightDelta = (weights.get(right.tool) ?? Number.NEGATIVE_INFINITY) -
      (weights.get(left.tool) ?? Number.NEGATIVE_INFINITY);
    return weightDelta || compareCandidates(taskTier, left, right);
  })[0];
  return {
    selected,
    metadata: {
      status: "applied",
      reason: `human-promoted ${contract.routing_task_type} weights selected ${selected.tool}`,
      source_evidence_hash: promoted.active_policy.source_evidence_hash
    }
  };
}

function compareScorecards(left: RoutingProviderScorecard, right: RoutingProviderScorecard): number {
  return right.weight - left.weight || left.provider.localeCompare(right.provider);
}

export function inferTaskTier(contract: TaskContract, config: HivemindConfig): TaskTier {
  return inferAllowedFilesTier(contract.allowed_files, config);
}

export function inferAllowedFilesTier(allowedFiles: string[], config: HivemindConfig): TaskTier {
  let result: TaskTier = "low";
  for (const scope of allowedFiles) {
    const scopeTier = inferScopeTier(scope, config);
    if (taskTierRank[scopeTier] > taskTierRank[result]) {
      result = scopeTier;
    }
  }
  return result;
}

function inferScopeTier(scope: string, config: HivemindConfig): TaskTier {
  if (scopeMatchesPatterns(scope, config.critical_globs ?? [])) {
    return "critical";
  }
  if (scopeMatchesPatterns(scope, config.high_globs ?? [])) {
    return "high";
  }
  if (scopeMatchesPatterns(scope, config.medium_globs ?? [])) {
    return "medium";
  }
  if (scopeMatchesPatterns(scope, config.low_globs ?? [])) {
    return "low";
  }
  return "high";
}

function scopeMatchesPatterns(scope: string, patterns: string[]): boolean {
  const normalizedScope = scope.replaceAll("\\", "/");
  return matchesAny(normalizedScope, patterns) || patterns.some((pattern) => matchesPattern(pattern.replaceAll("\\", "/"), normalizedScope));
}

async function loadProviderCandidates(
  repoRoot: string,
  ledger: QuotaLedger
): Promise<
  | { ok: true; value: { candidates: ProviderCandidate[]; excludedByRole: string[] } }
  | { ok: false; reason: string }
> {
  let entries: string[];
  try {
    entries = await readdir(path.join(repoRoot, ".hivemind", "adapters"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: "adapter directory not found: .hivemind/adapters" };
    }
    throw error;
  }

  const tools = entries
    .filter((entry) => entry.endsWith(".profile.json"))
    .map((entry) => entry.slice(0, -".profile.json".length))
    .sort((left, right) => left.localeCompare(right));
  if (tools.length === 0) {
    return { ok: false, reason: "no adapter profiles found in .hivemind/adapters" };
  }

  const candidates: ProviderCandidate[] = [];
  const excludedByRole: string[] = [];
  for (const tool of tools) {
    const profileResult = await loadAdapterProfile(repoRoot, tool);
    if (!profileResult.ok) {
      return profileResult;
    }
    // Narrowing only. A profile that names no roles is unchanged, and a
    // profile removed here was never made eligible by anything else -- so this
    // can refuse a provider, never admit one. The tier floor is applied
    // separately and is untouched.
    if (!profileAdmitsRole(profileResult.profile, "worker")) {
      excludedByRole.push(tool);
      continue;
    }
    candidates.push(candidateFromProfile(profileResult.profile, ledger));
  }
  return { ok: true, value: { candidates, excludedByRole } };
}

/**
 * Says what happened to each profile, not just that nothing was left.
 *
 * This reason is what a quota pause records durably, so it is the whole of
 * what an operator gets. Naming only one cause misleads whenever there are
 * two: a below-floor worker and a skipped orchestrator produce the same empty
 * pool for completely different reasons, and only one of them is fixable by
 * adding a role.
 */
function noEligibleProviderReason(
  taskTier: TaskTier,
  candidates: ProviderCandidate[],
  excluded: Set<string>,
  excludedByRole: string[]
): string {
  const notes: string[] = [];
  const belowFloor = candidates
    .filter((candidate) => !excluded.has(candidate.tool) && !checkTierEligibility(taskTier, candidate).ok)
    .map((candidate) => candidate.tool);
  const walled = candidates.filter((candidate) => excluded.has(candidate.tool)).map((candidate) => candidate.tool);
  if (belowFloor.length > 0) {
    notes.push(`${belowFloor.join(", ")} below the ${taskTier} provider floor`);
  }
  if (walled.length > 0) {
    notes.push(`${walled.join(", ")} excluded from this decision`);
  }
  if (excludedByRole.length > 0) {
    notes.push(`${excludedByRole.join(", ")} not selectable as a worker`);
  }
  return notes.length === 0
    ? `no eligible provider for ${taskTier} task tier`
    : `no eligible provider for ${taskTier} task tier (${notes.join("; ")})`;
}

function candidateFromProfile(profile: AdapterProfile, ledger: QuotaLedger): ProviderCandidate {
  const providerTier = normalizeProfileRoutingTier(profile);
  const ledgerEntry = ledger[profile.tool];
  return {
    tool: profile.tool,
    profile,
    providerTier,
    providerRank: providerTierRank[providerTier],
    costRank: normalizeProfileCostRank(profile),
    pressured: ledgerEntry?.observed_limit !== null && ledgerEntry?.observed_limit !== undefined && ledgerEntry.unmetered !== true
  };
}

function checkTierEligibility(taskTier: TaskTier, candidate: ProviderCandidate): { ok: true } | { ok: false; reason: string } {
  const requiredRank = minimumProviderRank[taskTier];
  if (candidate.providerRank < requiredRank) {
    return {
      ok: false,
      reason: `provider "${candidate.tool}" tier ${candidate.providerTier} is below required floor for ${taskTier} task tier`
    };
  }
  return { ok: true };
}

function compareCandidates(taskTier: TaskTier, left: ProviderCandidate, right: ProviderCandidate): number {
  if (left.pressured !== right.pressured) {
    return left.pressured ? 1 : -1;
  }
  if (taskTier === "high" || taskTier === "critical") {
    return right.providerRank - left.providerRank || left.costRank - right.costRank || left.tool.localeCompare(right.tool);
  }
  return left.costRank - right.costRank || left.providerRank - right.providerRank || left.tool.localeCompare(right.tool);
}

function compareCheapest(left: ProviderCandidate, right: ProviderCandidate): number {
  return (
    left.costRank - right.costRank ||
    left.providerRank - right.providerRank ||
    left.tool.localeCompare(right.tool)
  );
}

function compareStrongest(left: ProviderCandidate, right: ProviderCandidate): number {
  return (
    right.providerRank - left.providerRank ||
    left.costRank - right.costRank ||
    left.tool.localeCompare(right.tool)
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * Resolve the operator's per-task-type preference against an already-eligible
 * pool, or null when there is nothing to apply.
 *
 * Takes the pool AFTER tier filtering, which is what makes guard 1 structural
 * rather than a check somebody has to remember: a provider the tier floor
 * excluded is not in this list to be chosen.
 */
async function applyTaskTypePreference(
  repoRoot: string,
  contract: TaskContract,
  config: HivemindConfig,
  pool: ProviderCandidate[]
): Promise<ProviderCandidate | null> {
  const parsed = parseTaskTypePreferences(
    config.task_type_routing
  );
  if (!parsed.ok) return null;
  const wanted = preferenceFor(parsed.value, contract.routing_task_type);
  if (wanted === null) return null;

  if (wanted.tool !== null) {
    const named = pool.find((candidate) => candidate.tool === wanted.tool);
    if (named === undefined) return null;
    /* Guard 3: a provider that cannot prove it honours a model pin is not
       something to aim work at. Routing may still fall back to it; it will not
       be chosen deliberately. */
    const allowed = await providerCanBeChosenDeliberately(repoRoot, named.tool);
    return allowed.allowed ? named : null;
  }

  const sorted = [...pool].sort((left, right) =>
    wanted.preference === "cheapest" ? compareCheapest(left, right) : compareStrongest(left, right)
  );
  const best = sorted[0];
  if (best === undefined) return null;
  const allowed = await providerCanBeChosenDeliberately(repoRoot, best.tool);
  return allowed.allowed ? best : null;
}
