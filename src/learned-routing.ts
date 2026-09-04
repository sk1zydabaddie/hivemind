import { isRecord } from "./json.js";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  readVerifiedCapabilityCorpusReport,
  type VerifiedCapabilityCorpusReport
} from "./capability-corpus-evidence.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { readCanonMemory, type CanonMemoryEntry } from "./memory-canon.js";
import { proposeMemoryLesson, type MemoryProposal } from "./memory-log.js";
import { findGitRoot } from "./repo.js";
import {
  type LearnedRoutingPolicy,
  type CorpusRoutingEvidenceBinding,
  type RoutingEvidenceSource,
  type RoutingCostSource,
  type RoutingProviderScorecard,
  type RoutingSourceRanking,
  type RoutingTaskTypeScorecard,
  validateLearnedRoutingPolicy
} from "./routing-policy-schema.js";
import { isRoutingTaskType, type RoutingTaskType } from "./routing-task-type.js";
import type { ValueQualityPolicy } from "./value-quality-policy-schema.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";

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

interface CorpusRegistration {
  version: 1;
  corpus_run_id: string;
  report_path: string;
  manifest_path: string;
  report_sha256: string;
  manifest_sha256: string;
  included_providers: string[];
  started_at: string;
  completed_at: string;
  attempt_count: number;
  models: Array<{ provider: string; model: string }>;
  provenance: "controlled_shadow_corpus";
}

interface EvidenceBoundPolicy {
  source_evidence_hash: string;
  source_event_count: number;
}

export interface PromotedEvidencePolicyStatus<Policy extends EvidenceBoundPolicy> {
  current_evidence_hash: string;
  current_evidence_event_count: number;
  promoted: "active" | "absent" | "stale" | "invalid";
  active_policy: Policy | null;
  active_canon_id: string | null;
  reason: string | null;
}

export type RoutingPolicyStatus = PromotedEvidencePolicyStatus<LearnedRoutingPolicy>;
export type ValueQualityPolicyStatus = PromotedEvidencePolicyStatus<ValueQualityPolicy>;

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

export async function ingestCapabilityCorpusEvidence(
  repoRoot: string,
  corpusRunId: string,
  includedProviders?: string[]
): Promise<{ ok: true; value: CorpusRegistration } | { ok: false; reason: string }> {
  const verified = await readVerifiedCapabilityCorpusReport(repoRoot, corpusRunId);
  if (!verified.ok) return verified;
  const registration = registrationFromVerifiedReport(verified.value, includedProviders);
  if (!registration.ok) return registration;
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const existing = events.value.filter(
    (event) => event.type === "routing.corpus_registered" && event.data.corpus_run_id === corpusRunId
  );
  if (existing.length > 1) {
    return { ok: false, reason: `capability corpus registration is ambiguous: ${corpusRunId}` };
  }
  if (existing.length === 1) {
    const parsed = parseCorpusRegistration(existing[0].data);
    if (!parsed.ok) return parsed;
    return hashJson(parsed.value) === hashJson(registration.value)
      ? { ok: true, value: parsed.value }
      : { ok: false, reason: `capability corpus registration conflicts with immutable evidence: ${corpusRunId}` };
  }
  const appended = await appendEvent(repoRoot, {
    type: "routing.corpus_registered",
    task_id: null,
    data: { ...registration.value }
  });
  return appended.ok ? { ok: true, value: registration.value } : appended;
}

export async function deriveLearnedRoutingPolicy(
  repoRoot: string
): Promise<{ ok: true; value: LearnedRoutingPolicy } | { ok: false; reason: string }> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const production = collectObservationSamples(events.value);
  if (!production.ok) return production;
  const corpus = await collectCorpusObservationSamples(repoRoot, events.value);
  if (!corpus.ok) return corpus;
  const observations = [...production.value, ...corpus.value.samples];
  if (observations.length === 0) {
    return { ok: false, reason: "no valid production or registered corpus Tier-1 routing evidence is available" };
  }

  const identity = routingEvidenceIdentity(events.value);
  const grouped = new Map<RoutingTaskType, Map<RoutingEvidenceSource, Map<string, ObservationSample[]>>>();
  for (const sample of observations) {
    let bySource = grouped.get(sample.observation.routing_task_type);
    if (bySource === undefined) {
      bySource = new Map();
      grouped.set(sample.observation.routing_task_type, bySource);
    }
    let byProvider = bySource.get(sample.source);
    if (byProvider === undefined) {
      byProvider = new Map();
      bySource.set(sample.source, byProvider);
    }
    const samples = byProvider.get(sample.observation.provider) ?? [];
    samples.push(sample);
    byProvider.set(sample.observation.provider, samples);
  }

  const taskTypes: RoutingTaskTypeScorecard[] = [];
  for (const routingTaskType of [...grouped.keys()].sort(compareText)) {
    const bySource = grouped.get(routingTaskType);
    if (bySource === undefined) continue;
    const productionScores = deriveSourceScorecards("production", bySource.get("production") ?? new Map());
    const corpusScores = deriveSourceScorecards("corpus_shadow", bySource.get("corpus_shadow") ?? new Map());
    const selectedSource: RoutingEvidenceSource = productionScores.length > 0 ? "production" : "corpus_shadow";
    const selectedScores = selectedSource === "production" ? productionScores : corpusScores;
    const productionRanking = sourceRanking("production", productionScores);
    const corpusRanking = sourceRanking("corpus_shadow", corpusScores);
    taskTypes.push({
      routing_task_type: routingTaskType,
      providers: selectedScores,
      provenance: {
        selected_source: selectedSource,
        production: productionRanking,
        corpus_shadow: corpusRanking,
        rankings_disagree: rankingsDisagree(productionRanking, corpusRanking)
      }
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
        handoff_safety: 0.2,
        corpus_shadow_success_rate: 1
      },
      corpus_evidence: corpus.value.bindings,
      task_types: taskTypes
    }
  };
}

export async function validateRoutingPolicyEvidenceIdentity(
  repoRoot: string,
  policy: LearnedRoutingPolicy
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = validateLearnedRoutingPolicy(policy);
  if (!parsed.ok) return parsed;
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const corpusVerification = await verifyRegisteredCorpusEvidence(repoRoot, events.value);
  if (!corpusVerification.ok) return corpusVerification;
  const identity = routingEvidenceIdentity(events.value);
  if (
    parsed.value.source_evidence_hash !== identity.hash ||
    parsed.value.source_event_count !== identity.count
  ) {
    return { ok: false, reason: "routing policy evidence identity does not bind the current cited evidence" };
  }
  return { ok: true };
}

export async function proposeLearnedRoutingPolicy(
  repoRoot: string
): Promise<{ ok: true; value: MemoryProposal } | { ok: false; reason: string }> {
  const derived = await deriveLearnedRoutingPolicy(repoRoot);
  if (!derived.ok) {
    return derived;
  }
  const evidence = uniqueSorted(
    [
      ...derived.value.task_types.flatMap((taskType) => [
        ...taskType.provenance.production.evidence,
        ...taskType.provenance.corpus_shadow.evidence
      ]),
      ...derived.value.corpus_evidence.map((entry) =>
        `capability-corpus:${entry.corpus_run_id}@sha256:${entry.report_sha256}`
      )
    ]
  );
  const summary = derived.value.task_types
    .map((taskType) => {
      const ranked = [...taskType.providers].sort((left, right) => right.weight - left.weight || compareText(left.provider, right.provider));
      const disagreement = taskType.provenance.rankings_disagree === true ? "; production and corpus rankings disagree" : "";
      return `${taskType.routing_task_type} (${taskType.provenance.selected_source}): ${ranked.map((entry) => `${entry.provider}=${entry.weight}`).join(", ")}${disagreement}`;
    })
    .join("; ");
  const corpusScope = derived.value.corpus_evidence.length === 0
    ? "No controlled corpus evidence is registered."
    : `Controlled shadow corpus reports: ${derived.value.corpus_evidence.map((entry) => `${entry.corpus_run_id} [${entry.models.map((model) => `${model.provider}=${model.model}`).join(", ")}], ${entry.started_at}..${entry.completed_at}`).join("; ")}.`;
  return proposeMemoryLesson(repoRoot, {
    title: "Proposed metric-derived routing weights",
    lesson: [
      "Deterministic scorecard proposal. Review sample sizes and confounders before promotion.",
      corpusScope,
      "Corpus evidence is controlled shadow measurement on three fixed task shapes, not general production reliability. A future task type may behave differently.",
      "Model identifiers and measurement dates are recorded, but a provider changing behavior behind the same model identifier cannot be detected automatically; reviewers must judge snapshot staleness.",
      "Production routing observations remain a distinct evidence source. When present they are selected over corpus priors, and disagreement is surfaced rather than pooled silently.",
      `Weights: ${summary}`
    ].join(" "),
    evidence,
    routing_policy: derived.value
  });
}

export async function readPromotedRoutingPolicy(repoRoot: string): Promise<RoutingPolicyStatus> {
  return readPromotedEvidencePolicy(
    repoRoot,
    (entry) => entry.routing_policy,
    "no human-promoted learned routing policy exists",
    "human-promoted learned routing policy does not match current Tier-1 routing evidence"
  );
}

export async function readPromotedValueQualityPolicy(repoRoot: string): Promise<ValueQualityPolicyStatus> {
  return readPromotedEvidencePolicy(
    repoRoot,
    (entry) => entry.value_quality_policy,
    "no human-promoted value-quality policy exists",
    "human-promoted value-quality policy does not match current Tier-1 routing evidence"
  );
}

async function readPromotedEvidencePolicy<Policy extends EvidenceBoundPolicy>(
  repoRoot: string,
  selectPolicy: (entry: CanonMemoryEntry) => Policy | null,
  absentReason: string,
  staleReason: string
): Promise<PromotedEvidencePolicyStatus<Policy>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return {
      current_evidence_hash: "",
      current_evidence_event_count: 0,
      promoted: "invalid",
      active_policy: null,
      active_canon_id: null,
      reason: events.reason
    };
  }
  const corpusVerification = await verifyRegisteredCorpusEvidence(repoRoot, events.value);
  if (!corpusVerification.ok) {
    return {
      current_evidence_hash: "",
      current_evidence_event_count: 0,
      promoted: "invalid",
      active_policy: null,
      active_canon_id: null,
      reason: corpusVerification.reason
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
      active_canon_id: null,
      reason: canon.reason
    };
  }
  const promoted = canon.value
    .map((entry) => ({ entry, policy: selectPolicy(entry) }))
    .filter((candidate): candidate is { entry: CanonMemoryEntry; policy: Policy } => candidate.policy !== null)
    .sort((left, right) =>
      right.entry.approved_at.localeCompare(left.entry.approved_at) ||
      compareText(right.entry.canon_id, left.entry.canon_id)
    );
  if (promoted.length === 0) {
    return {
      current_evidence_hash: identity.hash,
      current_evidence_event_count: identity.count,
      promoted: "absent",
      active_policy: null,
      active_canon_id: null,
      reason: absentReason
    };
  }
  const current = promoted.find(({ policy }) =>
    policy.source_evidence_hash === identity.hash &&
    policy.source_event_count === identity.count
  );
  if (current === undefined) {
    return {
      current_evidence_hash: identity.hash,
      current_evidence_event_count: identity.count,
      promoted: "stale",
      active_policy: null,
      active_canon_id: null,
      reason: staleReason
    };
  }
  return {
    current_evidence_hash: identity.hash,
    current_evidence_event_count: identity.count,
    promoted: "active",
    active_policy: current.policy,
    active_canon_id: current.entry.canon_id,
    reason: null
  };
}

export async function routingCommand(cwd: string, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (
    (action !== "derive" && action !== "status" && action !== "ingest-corpus") ||
    ((action === "derive" || action === "status") && rest.length > 0) ||
    (action === "ingest-corpus" && !isCorpusIngestArgs(rest))
  ) {
    console.error("error: usage: hivemind routing derive | status | ingest-corpus <corpus-run-id> [--provider <tool>]");
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  if (action === "ingest-corpus") {
    const includedProviders = rest.length === 3 ? [rest[2]] : undefined;
    const daemonResult = await callDaemonIfConfigured<CorpusRegistration>(repoRoot, "/routing/corpus/ingest", {
      corpus_run_id: rest[0],
      included_providers: includedProviders
    });
    const result = daemonResult.routed
      ? daemonResult
      : await ingestCapabilityCorpusEvidence(repoRoot, rest[0], includedProviders);
    if (!result.ok) {
      console.error(`error: ${result.reason}`);
      return 1;
    }
    console.log(JSON.stringify(result.value, null, 2));
    return 0;
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
  source: RoutingEvidenceSource;
  model: string | null;
  cost_usd: number | null;
  observation: RoutingObservation;
  completed: boolean;
  accepted: boolean;
  integrated: boolean;
  failed: boolean;
  revision_count: number;
  handoff_success: boolean;
  merged_diff_bytes: number;
  shadow_validated_diff_bytes: number;
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
      source: "production",
      model: null,
      cost_usd: null,
      observation: parsed.value,
      completed,
      accepted,
      integrated,
      failed: terminalFailed || !completed || rejected || integrationFailed,
      revision_count: revisionCount,
      handoff_success: parsed.value.handoff_from !== null && integrated,
      merged_diff_bytes: integrated ? parsed.value.diff_bytes : 0,
      shadow_validated_diff_bytes: 0,
      evidence: uniqueSorted(evidence)
    });
  }
  return { ok: true, value: samples };
}

async function collectCorpusObservationSamples(
  repoRoot: string,
  events: HivemindEvent[]
): Promise<{
  ok: true;
  value: { samples: ObservationSample[]; bindings: CorpusRoutingEvidenceBinding[] };
} | { ok: false; reason: string }> {
  const verified = await verifyRegisteredCorpusEvidence(repoRoot, events);
  if (!verified.ok) return verified;
  const samples: ObservationSample[] = [];
  for (const entry of verified.value) {
    const tasks = new Map(entry.verified.definition.tasks.map((task) => [task.task_id, task]));
    for (const attempt of entry.verified.report.attempts) {
      if (!entry.registration.included_providers.includes(attempt.tool)) continue;
      const task = tasks.get(attempt.task_id);
      if (task === undefined) {
        return { ok: false, reason: `registered corpus ${entry.registration.corpus_run_id} contains an unknown task ${attempt.task_id}` };
      }
      const diffBytes = await diffByteSize(path.join(repoRoot, attempt.artifact_path, "diff.patch"));
      const providerTokens = attempt.provider_reported_usage?.total_tokens ?? null;
      const selfTokens = attempt.self_measured_tokens ?? 0;
      const effectiveTokens = providerTokens ?? selfTokens;
      const accepted = attempt.gate?.verdict === "accept";
      const completed = attempt.exit_code === 0;
      samples.push({
        source: "corpus_shadow",
        model: attempt.model,
        cost_usd: attempt.cost_usd,
        observation: {
          version: 1,
          run_id: entry.registration.corpus_run_id,
          provider: attempt.tool,
          routing_task_type: task.routing_task_type,
          request_count: 1,
          wall_time_ms: attempt.wall_time_ms,
          self_measured_tokens: selfTokens,
          provider_reported_tokens: providerTokens,
          effective_tokens: effectiveTokens,
          cost_source: providerTokens === null ? "self_measured" : "provider_reported",
          diff_bytes: diffBytes,
          exit_code: attempt.exit_code ?? -1,
          timed_out: false,
          handoff_from: null
        },
        completed,
        accepted,
        integrated: false,
        failed: !attempt.success,
        revision_count: attempt.revision_count,
        handoff_success: false,
        merged_diff_bytes: 0,
        shadow_validated_diff_bytes: attempt.success ? diffBytes : 0,
        evidence: [
          `capability-corpus:${entry.registration.corpus_run_id}@sha256:${entry.registration.report_sha256}`,
          `capability-corpus:${entry.registration.corpus_run_id}/${attempt.tool}/iteration-${String(attempt.iteration).padStart(3, "0")}/${attempt.task_id}`
        ]
      });
    }
  }
  return {
    ok: true,
    value: {
      samples,
      bindings: verified.value.map(({ registration }) => ({
        corpus_run_id: registration.corpus_run_id,
        report_sha256: registration.report_sha256,
        manifest_sha256: registration.manifest_sha256,
        included_providers: [...registration.included_providers],
        started_at: registration.started_at,
        completed_at: registration.completed_at,
        models: registration.models.map((model) => ({ ...model })),
        attempt_count: registration.attempt_count
      }))
    }
  };
}

async function verifyRegisteredCorpusEvidence(
  repoRoot: string,
  events: HivemindEvent[]
): Promise<{
  ok: true;
  value: Array<{ registration: CorpusRegistration; verified: VerifiedCapabilityCorpusReport }>;
} | { ok: false; reason: string }> {
  const registrations = events.filter((event) => event.type === "routing.corpus_registered");
  const seen = new Set<string>();
  const result: Array<{ registration: CorpusRegistration; verified: VerifiedCapabilityCorpusReport }> = [];
  for (const event of registrations) {
    const parsed = parseCorpusRegistration(event.data);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.corpus_run_id)) {
      return { ok: false, reason: `capability corpus is registered more than once: ${parsed.value.corpus_run_id}` };
    }
    seen.add(parsed.value.corpus_run_id);
    const verified = await readVerifiedCapabilityCorpusReport(repoRoot, parsed.value.corpus_run_id);
    if (!verified.ok) return verified;
    const current = registrationFromVerifiedReport(verified.value, parsed.value.included_providers);
    if (!current.ok || hashJson(current.value) !== hashJson(parsed.value)) {
      return { ok: false, reason: `registered capability corpus no longer matches its evidence hash: ${parsed.value.corpus_run_id}` };
    }
    result.push({ registration: parsed.value, verified: verified.value });
  }
  return { ok: true, value: result };
}

function registrationFromVerifiedReport(
  verified: VerifiedCapabilityCorpusReport,
  requestedProviders?: string[]
): { ok: true; value: CorpusRegistration } | { ok: false; reason: string } {
  const availableProviders = uniqueSorted(verified.report.attempts.map((attempt) => attempt.tool));
  const includedProviders = requestedProviders === undefined ? availableProviders : uniqueSorted(requestedProviders);
  if (includedProviders.length === 0 || includedProviders.some((provider) => !availableProviders.includes(provider))) {
    return { ok: false, reason: "corpus provider selection is empty or is not present in the verified report" };
  }
  const attempts = verified.report.attempts.filter((attempt) => includedProviders.includes(attempt.tool));
  return { ok: true, value: {
    version: 1,
    corpus_run_id: verified.report.corpus_run_id,
    report_path: verified.report_path,
    manifest_path: verified.manifest_path,
    report_sha256: verified.report_sha256,
    manifest_sha256: verified.manifest_sha256,
    started_at: verified.report.started_at,
    completed_at: verified.report.completed_at,
    included_providers: includedProviders,
    attempt_count: attempts.length,
    models: uniqueModels(attempts.map((attempt) => ({ provider: attempt.tool, model: attempt.model }))),
    provenance: "controlled_shadow_corpus"
  } };
}

function parseCorpusRegistration(
  value: unknown
): { ok: true; value: CorpusRegistration } | { ok: false; reason: string } {
  const gated = checkFormatVersion(value, formatVersions.capabilityCorpusEvidence, "the corpus registration");
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  if (
    !isRecord(value) ||
    typeof value.corpus_run_id !== "string" ||
    !/^CC-[A-Za-z0-9-]+$/u.test(value.corpus_run_id) ||
    typeof value.report_path !== "string" ||
    typeof value.manifest_path !== "string" ||
    typeof value.report_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.report_sha256) ||
    typeof value.manifest_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.manifest_sha256) ||
    !Array.isArray(value.included_providers) ||
    value.included_providers.length === 0 ||
    value.included_providers.some((provider) => typeof provider !== "string" || provider.length === 0) ||
    typeof value.started_at !== "string" ||
    typeof value.completed_at !== "string" ||
    !isNonNegativeInteger(value.attempt_count) ||
    value.provenance !== "controlled_shadow_corpus" ||
    !Array.isArray(value.models) ||
    value.models.some((model) => !isRecord(model) || typeof model.provider !== "string" || typeof model.model !== "string")
  ) {
    return { ok: false, reason: "routing.corpus_registered event does not match schema version 1" };
  }
  return { ok: true, value: value as unknown as CorpusRegistration };
}

function isCorpusIngestArgs(args: string[]): boolean {
  return args.length === 1 || (args.length === 3 && args[1] === "--provider" && args[2].length > 0);
}

function uniqueModels(models: Array<{ provider: string; model: string }>): Array<{ provider: string; model: string }> {
  return [...new Map(models.map((model) => [`${model.provider}\0${model.model}`, model])).values()]
    .sort((left, right) => compareText(left.provider, right.provider) || compareText(left.model, right.model));
}

function aggregateProvider(
  source: RoutingEvidenceSource,
  provider: string,
  samples: ObservationSample[]
): Omit<RoutingProviderScorecard, "weight"> {
  const mergedDiffBytes = sum(samples.map((sample) => sample.merged_diff_bytes));
  const shadowValidatedDiffBytes = sum(samples.map((sample) => sample.shadow_validated_diff_bytes));
  const successfulDiffBytes = mergedDiffBytes + shadowValidatedDiffBytes;
  const wallTimeMs = sum(samples.map((sample) => sample.observation.wall_time_ms));
  const effectiveTokens = sum(samples.map((sample) => sample.observation.effective_tokens));
  const providerReported = samples.filter((sample) => sample.observation.cost_source === "provider_reported").length;
  const selfMeasured = samples.length - providerReported;
  const handoffAttempts = samples.filter((sample) => sample.observation.handoff_from !== null).length;
  const handoffSuccesses = samples.filter((sample) => sample.handoff_success).length;
  const successCount = samples.filter((sample) => !sample.failed && sample.completed && sample.accepted).length;
  const knownCosts = samples.map((sample) => sample.cost_usd);
  const totalCost = knownCosts.every((cost) => cost !== null)
    ? sum(knownCosts.map((cost) => cost ?? 0))
    : null;
  return {
    provider,
    evidence_source: source,
    model_ids: uniqueSorted(samples.flatMap((sample) => sample.model === null ? [] : [sample.model])),
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
    shadow_validated_diff_bytes: shadowValidatedDiffBytes,
    successful_diff_bytes: successfulDiffBytes,
    effective_tokens: effectiveTokens,
    effective_throughput_bytes_per_second: round(wallTimeMs === 0 ? 0 : successfulDiffBytes / (wallTimeMs / 1000)),
    merged_diff_bytes_per_1k_tokens: round(effectiveTokens === 0 ? 0 : (mergedDiffBytes * 1000) / effectiveTokens),
    successful_diff_bytes_per_1k_tokens: round(effectiveTokens === 0 ? 0 : (successfulDiffBytes * 1000) / effectiveTokens),
    success_rate: samples.length === 0 ? 0 : round(successCount / samples.length),
    cost_per_success_usd: totalCost === null || successCount === 0 ? null : roundCost(totalCost / successCount),
    handoff_safety_rate: handoffAttempts === 0 ? null : round(handoffSuccesses / handoffAttempts),
    cost_source: providerReported === samples.length ? "provider_reported" : selfMeasured === samples.length ? "self_measured" : "mixed",
    provider_reported_sample_count: providerReported,
    self_measured_sample_count: selfMeasured,
    evidence: uniqueSorted(samples.flatMap((sample) => sample.evidence))
  };
}

function deriveSourceScorecards(
  source: RoutingEvidenceSource,
  byProvider: Map<string, ObservationSample[]>
): RoutingProviderScorecard[] {
  const raw = [...byProvider.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([provider, samples]) => aggregateProvider(source, provider, samples));
  if (source === "corpus_shadow") {
    return raw.map((entry) => ({ ...entry, weight: entry.success_rate }));
  }
  const maxThroughput = Math.max(...raw.map((entry) => entry.effective_throughput_bytes_per_second), 0);
  const maxEfficiency = Math.max(...raw.map((entry) => entry.merged_diff_bytes_per_1k_tokens), 0);
  return raw.map((entry) => ({
    ...entry,
    weight: round(
      0.4 * normalize(entry.effective_throughput_bytes_per_second, maxThroughput) +
      0.4 * normalize(entry.merged_diff_bytes_per_1k_tokens, maxEfficiency) +
      0.2 * (entry.handoff_safety_rate ?? 0.5)
    )
  }));
}

function sourceRanking(source: RoutingEvidenceSource, scorecards: RoutingProviderScorecard[]): RoutingSourceRanking {
  const ranked = [...scorecards].sort((left, right) =>
    right.weight - left.weight ||
    compareNullableCost(left.cost_per_success_usd, right.cost_per_success_usd) ||
    compareText(left.provider, right.provider)
  );
  return {
    source,
    sample_count: sum(ranked.map((entry) => entry.sample_count)),
    ranking: ranked.map((entry) => ({
      provider: entry.provider,
      weight: entry.weight,
      sample_count: entry.sample_count,
      success_rate: entry.success_rate,
      cost_per_success_usd: entry.cost_per_success_usd
    })),
    evidence: uniqueSorted(ranked.flatMap((entry) => entry.evidence))
  };
}

function rankingsDisagree(left: RoutingSourceRanking, right: RoutingSourceRanking): boolean | null {
  const common = left.ranking.map((entry) => entry.provider).filter((provider) =>
    right.ranking.some((entry) => entry.provider === provider)
  );
  if (common.length < 2) return null;
  const leftOrder = left.ranking.filter((entry) => common.includes(entry.provider)).map((entry) => entry.provider);
  const rightOrder = right.ranking.filter((entry) => common.includes(entry.provider)).map((entry) => entry.provider);
  return leftOrder.some((provider, index) => provider !== rightOrder[index]);
}

function compareNullableCost(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function parseRoutingObservation(value: unknown): { ok: true; value: RoutingObservation } | { ok: false; reason: string } {
  const gated = checkFormatVersion(value, formatVersions.routingObservation, "the routing observation");
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  if (
    !isRecord(value) ||
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
    event.type === "routing.corpus_registered" ||
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

function roundCost(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
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
