import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  type AdapterProfile,
  loadAdapterProfile,
  normalizeProfileCostRank,
  normalizeProfileRoutingTier,
  type ProviderRoutingTier
} from "./adapter.js";
import type { HivemindConfig } from "./config.js";
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

const minimumProviderRank: Record<TaskTier, number> = {
  low: providerTierRank.local,
  medium: providerTierRank.standard,
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
  const eligible = candidatesResult.value.filter((candidate) => !excluded.has(candidate.tool) && checkTierEligibility(taskTier, candidate).ok);
  if (eligible.length === 0) {
    return { ok: false, reason: `no eligible provider for ${taskTier} task tier` };
  }

  const nonPressured = eligible.filter((candidate) => !candidate.pressured);
  const pool = nonPressured.length > 0 ? nonPressured : eligible;
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
  const learned = await chooseWithPromotedPolicy(repoRoot, contract, taskTier, candidatesResult.value, pool);
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
  let result: TaskTier = "low";
  for (const scope of contract.allowed_files) {
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
): Promise<{ ok: true; value: ProviderCandidate[] } | { ok: false; reason: string }> {
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
  for (const tool of tools) {
    const profileResult = await loadAdapterProfile(repoRoot, tool);
    if (!profileResult.ok) {
      return profileResult;
    }
    candidates.push(candidateFromProfile(profileResult.profile, ledger));
  }
  return { ok: true, value: candidates };
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
