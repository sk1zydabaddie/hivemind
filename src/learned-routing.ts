import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { readCanonMemory } from "./memory-canon.js";
import { proposeMemoryLesson, type MemoryProposal } from "./memory-log.js";
import { findGitRoot } from "./repo.js";
import {
  type LearnedRoutingPolicy,
  type RoutingCostSource,
  type RoutingProviderScorecard,
  type RoutingTaskTypeScorecard
} from "./routing-policy-schema.js";
import { isRoutingTaskType, type RoutingTaskType } from "./routing-task-type.js";

export interface RoutingObservation {
  version: 1;
  run_id: string;
  provider: string;
  routing_task_type: RoutingTaskType;
  request_count: 1;
  wall_time_ms: number;
  self_measured_tokens: number;
  provider_reported_tokens: number | null;
  effective_tokens: number;
  cost_source: Exclude<RoutingCostSource, "mixed">;
  diff_bytes: number;
  exit_code: number;
  timed_out: boolean;
  handoff_from: string | null;
}

export interface RoutingPolicyStatus {
  current_evidence_hash: string;
  current_evidence_event_count: number;
  promoted: "active" | "absent" | "stale" | "invalid";
  active_policy: LearnedRoutingPolicy | null;
  reason: string | null;
}

export async function appendRoutingObservation(
  repoRoot: string,
  taskId: string,
  observation: RoutingObservation
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const validated = parseRoutingObservation(observation);
  if (!validated.ok) {
    return validated;
  }
  const appended = await appendEvent(repoRoot, {
    type: "routing.observed",
    task_id: taskId,
    data: { ...validated.value }
  });
  return appended.ok ? { ok: true } : appended;
}

export async function deriveLearnedRoutingPolicy(
  repoRoot: string
): Promise<{ ok: true; value: LearnedRoutingPolicy } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const observations = collectObservationSamples(events.value);
  if (!observations.ok) {
    return observations;
  }
  if (observations.value.length === 0) {
    return { ok: false, reason: "no valid routing.observed Tier-1 evidence is available" };
  }

  const identity = routingEvidenceIdentity(events.value);
  const grouped = new Map<RoutingTaskType, Map<string, ObservationSample[]>>();
  for (const sample of observations.value) {
    let byProvider = grouped.get(sample.observation.routing_task_type);
    if (byProvider === undefined) {
      byProvider = new Map();
      grouped.set(sample.observation.routing_task_type, byProvider);
    }
    const samples = byProvider.get(sample.observation.provider) ?? [];
    samples.push(sample);
    byProvider.set(sample.observation.provider, samples);
  }

  const taskTypes: RoutingTaskTypeScorecard[] = [];
  for (const routingTaskType of [...grouped.keys()].sort(compareText)) {
    const byProvider = grouped.get(routingTaskType);
    if (byProvider === undefined) {
      continue;
    }
    const raw = [...byProvider.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([provider, samples]) => aggregateProvider(provider, samples));
    const maxThroughput = Math.max(...raw.map((entry) => entry.effective_throughput_bytes_per_second), 0);
    const maxEfficiency = Math.max(...raw.map((entry) => entry.merged_diff_bytes_per_1k_tokens), 0);
    taskTypes.push({
      routing_task_type: routingTaskType,
      providers: raw.map((entry) => ({
        ...entry,
        weight: round(
          0.4 * normalize(entry.effective_throughput_bytes_per_second, maxThroughput) +
          0.4 * normalize(entry.merged_diff_bytes_per_1k_tokens, maxEfficiency) +
          0.2 * (entry.handoff_safety_rate ?? 0.5)
        )
      }))
    });
  }

  return {
    ok: true,
    value: {
      version: 1,
      kind: "learned_routing_policy",
      source_evidence_hash: identity.hash,
      source_event_count: identity.count,
      formula: {
        effective_throughput: 0.4,
        merged_diff_per_quota: 0.4,
        handoff_safety: 0.2
      },
      task_types: taskTypes
    }
  };
}

export async function proposeLearnedRoutingPolicy(
  repoRoot: string
): Promise<{ ok: true; value: MemoryProposal } | { ok: false; reason: string }> {
  const derived = await deriveLearnedRoutingPolicy(repoRoot);
  if (!derived.ok) {
    return derived;
  }
  const evidence = uniqueSorted(
    derived.value.task_types.flatMap((taskType) =>
      taskType.providers.flatMap((provider) => provider.evidence)
    )
  );
  const summary = derived.value.task_types
    .map((taskType) => {
      const ranked = [...taskType.providers].sort((left, right) => right.weight - left.weight || compareText(left.provider, right.provider));
      return `${taskType.routing_task_type}: ${ranked.map((entry) => `${entry.provider}=${entry.weight}`).join(", ")}`;
    })
    .join("; ");
  return proposeMemoryLesson(repoRoot, {
    title: "Proposed metric-derived routing weights",
    lesson: `Deterministic scorecard proposal. Review sample sizes and confounders before promotion. Weights: ${summary}`,
    evidence,
    routing_policy: derived.value
  });
}

export async function readPromotedRoutingPolicy(repoRoot: string): Promise<RoutingPolicyStatus> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return {
      current_evidence_hash: "",
      current_evidence_event_count: 0,
      promoted: "invalid",
      active_policy: null,
      reason: events.reason
    };
  }
  const identity = routingEvidenceIdentity(events.value);
  const canon = await readCanonMemory(repoRoot);
  if (!canon.ok) {
    return {
      current_evidence_hash: identity.hash,
      current_evidence_event_count: identity.count,
      promoted: "invalid",
      active_policy: null,
      reason: canon.reason
    };
  }
  const promoted = canon.value
    .filter((entry) => entry.routing_policy !== null)
    .sort((left, right) => right.approved_at.localeCompare(left.approved_at) || compareText(right.canon_id, left.canon_id));
  if (promoted.length === 0) {
    return {
      current_evidence_hash: identity.hash,
      current_evidence_event_count: identity.count,
      promoted: "absent",
      active_policy: null,
      reason: "no human-promoted learned routing policy exists"
    };
  }
  const current = promoted.find((entry) =>
    entry.routing_policy?.source_evidence_hash === identity.hash &&
    entry.routing_policy.source_event_count === identity.count
  );
  if (current?.routing_policy === null || current === undefined) {
    return {
      current_evidence_hash: identity.hash,
      current_evidence_event_count: identity.count,
      promoted: "stale",
      active_policy: null,
      reason: "human-promoted learned routing policy does not match current Tier-1 routing evidence"
    };
  }
  return {
    current_evidence_hash: identity.hash,
    current_evidence_event_count: identity.count,
    promoted: "active",
    active_policy: current.routing_policy,
    reason: null
  };
}

export async function routingCommand(cwd: string, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if ((action !== "derive" && action !== "status") || rest.length > 0) {
    console.error("error: usage: hivemind routing derive | status");
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  if (action === "derive") {
    const daemonResult = await callDaemonIfConfigured<MemoryProposal>(repoRoot, "/routing/derive", {});
    const result = daemonResult.routed ? daemonResult : await proposeLearnedRoutingPolicy(repoRoot);
    if (!result.ok) {
      console.error(`error: ${result.reason}`);
      return 1;
    }
    console.log(JSON.stringify(result.value, null, 2));
    return 0;
  }

  const [derived, promoted] = await Promise.all([
    deriveLearnedRoutingPolicy(repoRoot),
    readPromotedRoutingPolicy(repoRoot)
  ]);
  console.log(JSON.stringify({
    derived: derived.ok ? derived.value : null,
    derived_error: derived.ok ? null : derived.reason,
    promoted
  }, null, 2));
  return 0;
}

interface ObservationSample {
  observation: RoutingObservation;
  completed: boolean;
  accepted: boolean;
  integrated: boolean;
  failed: boolean;
  revision_count: number;
  handoff_success: boolean;
  merged_diff_bytes: number;
  evidence: string[];
}

function collectObservationSamples(events: HivemindEvent[]): { ok: true; value: ObservationSample[] } | { ok: false; reason: string } {
  const samples: ObservationSample[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== "routing.observed") {
      continue;
    }
    if (event.task_id === null) {
      return { ok: false, reason: `routing.observed event at line ${index + 1} has no task_id` };
    }
    const parsed = parseRoutingObservation(event.data);
    if (!parsed.ok) {
      return { ok: false, reason: `invalid routing.observed event at line ${index + 1}: ${parsed.reason}` };
    }
    const evidence = [`events.jsonl#L${index + 1}`];
    let accepted = false;
    let rejected = false;
    let integrated = false;
    let integrationFailed = false;
    let terminalCompleted = false;
    let terminalFailed = false;
    let revisionCount = 0;
    for (let cursor = index + 1; cursor < events.length; cursor += 1) {
      const next = events[cursor];
      if (next.type === "routing.observed" && next.task_id === event.task_id) {
        break;
      }
      if (next.task_id === event.task_id && (next.type === "patch.accepted" || next.type === "patch.rejected")) {
        accepted = next.type === "patch.accepted";
        rejected = next.type === "patch.rejected";
        revisionCount += rejected ? 1 : 0;
        evidence.push(`events.jsonl#L${cursor + 1}`);
      }
      if (next.task_id === event.task_id && (next.type === "task.completed" || next.type === "task.failed")) {
        terminalCompleted = next.type === "task.completed";
        terminalFailed = next.type === "task.failed";
        evidence.push(`events.jsonl#L${cursor + 1}`);
      }
      if (next.task_id === event.task_id && (next.type === "task.redirected" || next.type === "task.revision_requested")) {
        revisionCount += 1;
        evidence.push(`events.jsonl#L${cursor + 1}`);
      }
      if (next.type === "integration.passed" || next.type === "integration.failed") {
        const applied = Array.isArray(next.data.applied) ? next.data.applied : [];
        if (applied.includes(event.task_id)) {
          integrated = next.type === "integration.passed";
          integrationFailed = next.type === "integration.failed";
          evidence.push(`events.jsonl#L${cursor + 1}`);
        }
      }
    }
    const completed = terminalCompleted && parsed.value.exit_code === 0;
    samples.push({
      observation: parsed.value,
      completed,
      accepted,
      integrated,
      failed: terminalFailed || !completed || rejected || integrationFailed,
      revision_count: revisionCount,
      handoff_success: parsed.value.handoff_from !== null && integrated,
      merged_diff_bytes: integrated ? parsed.value.diff_bytes : 0,
      evidence: uniqueSorted(evidence)
    });
  }
  return { ok: true, value: samples };
}

function aggregateProvider(provider: string, samples: ObservationSample[]): Omit<RoutingProviderScorecard, "weight"> {
  const mergedDiffBytes = sum(samples.map((sample) => sample.merged_diff_bytes));
  const wallTimeMs = sum(samples.map((sample) => sample.observation.wall_time_ms));
  const effectiveTokens = sum(samples.map((sample) => sample.observation.effective_tokens));
  const providerReported = samples.filter((sample) => sample.observation.cost_source === "provider_reported").length;
  const selfMeasured = samples.length - providerReported;
  const handoffAttempts = samples.filter((sample) => sample.observation.handoff_from !== null).length;
  const handoffSuccesses = samples.filter((sample) => sample.handoff_success).length;
  return {
    provider,
    sample_count: samples.length,
    request_count: sum(samples.map((sample) => sample.observation.request_count)),
    completed_count: samples.filter((sample) => sample.completed).length,
    accepted_count: samples.filter((sample) => sample.accepted).length,
    integrated_count: samples.filter((sample) => sample.integrated).length,
    failed_count: samples.filter((sample) => sample.failed).length,
    timeout_count: samples.filter((sample) => sample.observation.timed_out).length,
    revision_count: sum(samples.map((sample) => sample.revision_count)),
    handoff_attempt_count: handoffAttempts,
    handoff_success_count: handoffSuccesses,
    wall_time_ms: wallTimeMs,
    merged_diff_bytes: mergedDiffBytes,
    effective_tokens: effectiveTokens,
    effective_throughput_bytes_per_second: round(wallTimeMs === 0 ? 0 : mergedDiffBytes / (wallTimeMs / 1000)),
    merged_diff_bytes_per_1k_tokens: round(effectiveTokens === 0 ? 0 : (mergedDiffBytes * 1000) / effectiveTokens),
    handoff_safety_rate: handoffAttempts === 0 ? null : round(handoffSuccesses / handoffAttempts),
    cost_source: providerReported === samples.length ? "provider_reported" : selfMeasured === samples.length ? "self_measured" : "mixed",
    provider_reported_sample_count: providerReported,
    self_measured_sample_count: selfMeasured,
    evidence: uniqueSorted(samples.flatMap((sample) => sample.evidence))
  };
}

function parseRoutingObservation(value: unknown): { ok: true; value: RoutingObservation } | { ok: false; reason: string } {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.run_id !== "string" ||
    value.run_id.trim() === "" ||
    typeof value.provider !== "string" ||
    value.provider.trim() === "" ||
    !isRoutingTaskType(value.routing_task_type) ||
    value.request_count !== 1 ||
    !isNonNegativeInteger(value.wall_time_ms) ||
    !isNonNegativeInteger(value.self_measured_tokens) ||
    (value.provider_reported_tokens !== null && !isNonNegativeInteger(value.provider_reported_tokens)) ||
    !isNonNegativeInteger(value.effective_tokens) ||
    (value.cost_source !== "provider_reported" && value.cost_source !== "self_measured") ||
    !isNonNegativeInteger(value.diff_bytes) ||
    !Number.isSafeInteger(value.exit_code) ||
    typeof value.timed_out !== "boolean" ||
    (value.handoff_from !== null && (typeof value.handoff_from !== "string" || value.handoff_from.trim() === ""))
  ) {
    return { ok: false, reason: "routing observation does not match schema version 1" };
  }
  if (
    value.cost_source === "provider_reported" &&
    (value.provider_reported_tokens === null || value.effective_tokens !== value.provider_reported_tokens)
  ) {
    return { ok: false, reason: "provider-reported routing observation must use provider tokens as effective_tokens" };
  }
  return { ok: true, value: value as unknown as RoutingObservation };
}

function routingEvidenceIdentity(events: HivemindEvent[]): { hash: string; count: number } {
  const relevant = events.filter((event) =>
    event.type === "routing.observed" ||
    event.type === "task.completed" ||
    event.type === "task.failed" ||
    event.type === "patch.accepted" ||
    event.type === "patch.rejected" ||
    event.type === "task.redirected" ||
    event.type === "task.revision_requested" ||
    event.type === "integration.passed" ||
    event.type === "integration.failed"
  );
  const content = relevant.map((event) => JSON.stringify(event)).join("\n");
  return {
    hash: createHash("sha256").update(content, "utf8").digest("hex"),
    count: relevant.length
  };
}

export async function diffByteSize(diffPath: string): Promise<number> {
  try {
    return (await stat(path.resolve(diffPath))).size;
  } catch {
    return 0;
  }
}

function normalize(value: number, maximum: number): number {
  return maximum === 0 ? 0 : value / maximum;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
