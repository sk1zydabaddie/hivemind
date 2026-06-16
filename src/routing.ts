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
import { readQuotaLedger, type QuotaLedger } from "./resource-ledger.js";

export type TaskTier = "low" | "medium" | "high" | "critical";

export interface RouteDecision {
  task_tier: TaskTier;
  tool: string;
  provider_tier: ProviderRoutingTier;
  profile: AdapterProfile;
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
  requestedTool?: string
): Promise<{ ok: true; value: RouteDecision } | { ok: false; reason: string }> {
  const taskTier = inferTaskTier(contract, config);
  const ledgerResult = await readQuotaLedger(repoRoot);
  if (!ledgerResult.ok) {
    return ledgerResult;
  }

  if (requestedTool !== undefined) {
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
  const eligible = candidatesResult.value.filter((candidate) => checkTierEligibility(taskTier, candidate).ok);
  if (eligible.length === 0) {
    return { ok: false, reason: `no eligible provider for ${taskTier} task tier` };
  }

  const nonPressured = eligible.filter((candidate) => !candidate.pressured);
  const pool = nonPressured.length > 0 ? nonPressured : eligible;
  const selected = [...pool].sort((left, right) => compareCandidates(taskTier, left, right))[0];
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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
