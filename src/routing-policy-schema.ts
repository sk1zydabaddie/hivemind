import { isRoutingTaskType, type RoutingTaskType } from "./routing-task-type.js";

export type RoutingCostSource = "provider_reported" | "self_measured" | "mixed";
export type RoutingEvidenceSource = "production" | "corpus_shadow";

export interface CorpusRoutingEvidenceBinding {
  corpus_run_id: string;
  report_sha256: string;
  manifest_sha256: string;
  included_providers: string[];
  started_at: string;
  completed_at: string;
  models: Array<{ provider: string; model: string }>;
  attempt_count: number;
}

export interface RoutingProviderScorecard {
  provider: string;
  evidence_source: RoutingEvidenceSource;
  model_ids: string[];
  weight: number;
  sample_count: number;
  request_count: number;
  completed_count: number;
  accepted_count: number;
  integrated_count: number;
  failed_count: number;
  timeout_count: number;
  revision_count: number;
  handoff_attempt_count: number;
  handoff_success_count: number;
  wall_time_ms: number;
  merged_diff_bytes: number;
  shadow_validated_diff_bytes: number;
  successful_diff_bytes: number;
  effective_tokens: number;
  effective_throughput_bytes_per_second: number;
  merged_diff_bytes_per_1k_tokens: number;
  successful_diff_bytes_per_1k_tokens: number;
  success_rate: number;
  cost_per_success_usd: number | null;
  handoff_safety_rate: number | null;
  cost_source: RoutingCostSource;
  provider_reported_sample_count: number;
  self_measured_sample_count: number;
  evidence: string[];
}

export interface RoutingSourceRanking {
  source: RoutingEvidenceSource;
  sample_count: number;
  ranking: Array<{
    provider: string;
    weight: number;
    sample_count: number;
    success_rate: number;
    cost_per_success_usd: number | null;
  }>;
  evidence: string[];
}

export interface RoutingTaskTypeScorecard {
  routing_task_type: RoutingTaskType;
  providers: RoutingProviderScorecard[];
  provenance: {
    selected_source: RoutingEvidenceSource;
    production: RoutingSourceRanking;
    corpus_shadow: RoutingSourceRanking;
    rankings_disagree: boolean | null;
  };
}

export interface LearnedRoutingPolicy {
  version: 1;
  kind: "learned_routing_policy";
  source_evidence_hash: string;
  source_event_count: number;
  formula: {
    effective_throughput: number;
    merged_diff_per_quota: number;
    handoff_safety: number;
    corpus_shadow_success_rate: number;
  };
  corpus_evidence: CorpusRoutingEvidenceBinding[];
  task_types: RoutingTaskTypeScorecard[];
}

export function validateLearnedRoutingPolicy(value: unknown): { ok: true; value: LearnedRoutingPolicy } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "routing policy must be a JSON object" };
  }
  if (
    value.version !== 1 ||
    value.kind !== "learned_routing_policy" ||
    typeof value.source_evidence_hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.source_evidence_hash) ||
    !isNonNegativeInteger(value.source_event_count) ||
    !isFormula(value.formula) ||
    !isCorpusEvidence(value.corpus_evidence) ||
    !Array.isArray(value.task_types)
  ) {
    return { ok: false, reason: "routing policy header does not match schema version 1" };
  }

  const seenTaskTypes = new Set<string>();
  for (const [taskTypeIndex, rawTaskType] of value.task_types.entries()) {
    if (
      !isRecord(rawTaskType) ||
      !isRoutingTaskType(rawTaskType.routing_task_type) ||
      !Array.isArray(rawTaskType.providers) ||
      !isTaskTypeProvenance(rawTaskType.provenance)
    ) {
      return { ok: false, reason: `routing policy task_types[${taskTypeIndex}] is invalid` };
    }
    if (seenTaskTypes.has(rawTaskType.routing_task_type)) {
      return { ok: false, reason: `routing policy repeats task type ${rawTaskType.routing_task_type}` };
    }
    seenTaskTypes.add(rawTaskType.routing_task_type);
    const seenProviders = new Set<string>();
    for (const [providerIndex, provider] of rawTaskType.providers.entries()) {
      const validated = validateProviderScorecard(provider, taskTypeIndex, providerIndex);
      if (!validated.ok) {
        return validated;
      }
      if (seenProviders.has(validated.value.provider)) {
        return { ok: false, reason: `routing policy repeats provider ${validated.value.provider} for ${rawTaskType.routing_task_type}` };
      }
      seenProviders.add(validated.value.provider);
    }
  }
  return { ok: true, value: value as unknown as LearnedRoutingPolicy };
}

function validateProviderScorecard(
  value: unknown,
  taskTypeIndex: number,
  providerIndex: number
): { ok: true; value: RoutingProviderScorecard } | { ok: false; reason: string } {
  const label = `routing policy task_types[${taskTypeIndex}].providers[${providerIndex}]`;
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    value.provider.trim() === "" ||
    (value.evidence_source !== "production" && value.evidence_source !== "corpus_shadow") ||
    !Array.isArray(value.model_ids) ||
    value.model_ids.some((model) => typeof model !== "string" || model.trim() === "")
  ) {
    return { ok: false, reason: `${label}.provider must be a non-empty string` };
  }
  const integerFields = [
    "sample_count",
    "request_count",
    "completed_count",
    "accepted_count",
    "integrated_count",
    "failed_count",
    "timeout_count",
    "revision_count",
    "handoff_attempt_count",
    "handoff_success_count",
    "wall_time_ms",
    "merged_diff_bytes",
    "shadow_validated_diff_bytes",
    "successful_diff_bytes",
    "effective_tokens",
    "provider_reported_sample_count",
    "self_measured_sample_count"
  ];
  if (integerFields.some((field) => !isNonNegativeInteger(value[field]))) {
    return { ok: false, reason: `${label} contains an invalid count` };
  }
  for (const field of [
    "weight",
    "effective_throughput_bytes_per_second",
    "merged_diff_bytes_per_1k_tokens",
    "successful_diff_bytes_per_1k_tokens",
    "success_rate"
  ]) {
    if (!isNonNegativeFinite(value[field])) {
      return { ok: false, reason: `${label}.${field} must be a non-negative finite number` };
    }
  }
  if (Number(value.success_rate) > 1 || (value.cost_per_success_usd !== null && !isNonNegativeFinite(value.cost_per_success_usd))) {
    return { ok: false, reason: `${label} contains invalid success or cost evidence` };
  }
  if (value.handoff_safety_rate !== null && (!isNonNegativeFinite(value.handoff_safety_rate) || value.handoff_safety_rate > 1)) {
    return { ok: false, reason: `${label}.handoff_safety_rate must be null or between zero and one` };
  }
  if (value.cost_source !== "provider_reported" && value.cost_source !== "self_measured" && value.cost_source !== "mixed") {
    return { ok: false, reason: `${label}.cost_source is invalid` };
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.some((item) => typeof item !== "string" || item.trim() === "")) {
    return { ok: false, reason: `${label}.evidence must contain non-empty references` };
  }
  return { ok: true, value: value as unknown as RoutingProviderScorecard };
}

function isFormula(value: unknown): boolean {
  return isRecord(value) &&
    value.effective_throughput === 0.4 &&
    value.merged_diff_per_quota === 0.4 &&
    value.handoff_safety === 0.2 &&
    value.corpus_shadow_success_rate === 1;
}

function isCorpusEvidence(value: unknown): value is CorpusRoutingEvidenceBinding[] {
  return Array.isArray(value) && value.every((entry) =>
    isRecord(entry) &&
    typeof entry.corpus_run_id === "string" &&
    /^[A-Za-z0-9-]+$/u.test(entry.corpus_run_id) &&
    typeof entry.report_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(entry.report_sha256) &&
    typeof entry.manifest_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(entry.manifest_sha256) &&
    Array.isArray(entry.included_providers) &&
    entry.included_providers.length > 0 &&
    entry.included_providers.every((provider) => typeof provider === "string" && provider.length > 0) &&
    typeof entry.started_at === "string" &&
    typeof entry.completed_at === "string" &&
    isNonNegativeInteger(entry.attempt_count) &&
    Array.isArray(entry.models) &&
    entry.models.every((model) => isRecord(model) && typeof model.provider === "string" && typeof model.model === "string")
  );
}

function isTaskTypeProvenance(value: unknown): boolean {
  return isRecord(value) &&
    (value.selected_source === "production" || value.selected_source === "corpus_shadow") &&
    isSourceRanking(value.production, "production") &&
    isSourceRanking(value.corpus_shadow, "corpus_shadow") &&
    (value.rankings_disagree === null || typeof value.rankings_disagree === "boolean");
}

function isSourceRanking(value: unknown, source: RoutingEvidenceSource): boolean {
  return isRecord(value) &&
    value.source === source &&
    isNonNegativeInteger(value.sample_count) &&
    Array.isArray(value.ranking) &&
    value.ranking.every((entry) =>
      isRecord(entry) &&
      typeof entry.provider === "string" &&
      isNonNegativeFinite(entry.weight) &&
      isNonNegativeInteger(entry.sample_count) &&
      isNonNegativeFinite(entry.success_rate) &&
      entry.success_rate <= 1 &&
      (entry.cost_per_success_usd === null || isNonNegativeFinite(entry.cost_per_success_usd))
    ) &&
    Array.isArray(value.evidence) &&
    value.evidence.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
