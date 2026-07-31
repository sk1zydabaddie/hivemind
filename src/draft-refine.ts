import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildAgentPrompt, normalizeProfileCostRank } from "./adapter.js";
import { loadAndValidateContract, type TaskContract } from "./contract.js";
import { appendEvent } from "./events.js";
import { writeImmutableJsonArtifact } from "./immutable-artifact.js";
import {
  measurePatchDistinctness,
  type PatchDistinctness
} from "./quality-distinctness.js";
import {
  runQualityProvider,
  validateQualityProviderRoute
} from "./quality-provider.js";
import {
  selectQualityWinner,
  type QualitySelectionArtifact
} from "./quality-selection.js";
import { findGitRoot } from "./repo.js";
import { estimateTokens } from "./resource-ledger.js";
import type { RouteDecision } from "./routing.js";
import {
  disposeSpeculativeDraft,
  type SpeculativeDraftArtifact
} from "./speculative-draft.js";
import {
  admitValueQuality,
  authorizeValueQualityCall
} from "./value-quality.js";

export interface DraftRefineRequest {
  task_id: string;
}

interface StageProvider {
  tool: string;
  provider_tier: RouteDecision["provider_tier"];
  cost_rank: number;
  profile_verified_on: string;
  routing_preference: "cheapest" | "strongest";
}

export interface DraftRefineReport {
  version: 1;
  quality_run_id: string;
  task_id: string;
  strategy: "draft_refine";
  sequential: true;
  draft: {
    draft_id: "D-001";
    artifact_path: string;
    provider: StageProvider;
  };
  refinement: {
    draft_id: "R-001";
    artifact_path: string;
    provider: StageProvider;
    critique_output_artifact: string;
    critique_model_output_sha256: string;
    received_actual_draft_patch: true;
    received_actual_gate_shadow_evidence: true;
  };
  distinctness: PatchDistinctness;
  selection_artifact: string;
  selected_draft_id: string | null;
  advisory_only: true;
  automatic_adoption: false;
}

export interface DraftRefineResult {
  version: 1;
  quality_run_id: string;
  task_id: string;
  sequential: true;
  draft: SpeculativeDraftArtifact;
  refinement: SpeculativeDraftArtifact;
  critique_rationale: string;
  distinctness: PatchDistinctness;
  selection: QualitySelectionArtifact;
  report: DraftRefineReport;
}

export type DraftRefineOutcome =
  | { ok: true; value: DraftRefineResult }
  | { ok: false; reason: string; quality_run_id?: string };

export async function generateDraftRefine(
  repoRoot: string,
  request: unknown
): Promise<DraftRefineOutcome> {
  const parsed = parseDraftRefineRequest(request);
  if (!parsed.ok) {
    return parsed;
  }
  const contract = await loadAndValidateContract(repoRoot, parsed.value.task_id);
  if (!contract.ok) {
    return contract;
  }
  const admission = await admitValueQuality(repoRoot, parsed.value.task_id, {
    strategy: "draft_refine"
  });
  if (!admission.ok) {
    return admission;
  }
  const qualityRunId = admission.value.quality_run_id;

  const draftPrompt = buildDraftPrompt(contract.contract, qualityRunId);
  const draftAuthorization = await authorizeStage(
    repoRoot,
    qualityRunId,
    "D-001",
    "cheapest",
    draftPrompt
  );
  if (!draftAuthorization.ok) {
    return { ...draftAuthorization, quality_run_id: qualityRunId };
  }
  const draft = await runStage(
    repoRoot,
    qualityRunId,
    "D-001",
    draftPrompt,
    draftAuthorization.value
  );
  if (!draft.ok) {
    return { ...draft, quality_run_id: qualityRunId };
  }
  if (!canRefine(draft.value.artifact)) {
    return {
      ok: false,
      reason: `D-001 cannot ground a refinement call: ${draft.value.artifact.reason}`,
      quality_run_id: qualityRunId
    };
  }

  const draftPatch = await readArtifactPatch(repoRoot, draft.value.artifact);
  if (!draftPatch.ok) {
    return { ...draftPatch, quality_run_id: qualityRunId };
  }
  const refinePrompt = buildRefinePrompt(
    contract.contract,
    qualityRunId,
    draftPatch.value,
    draft.value.artifact
  );
  const refineAuthorization = await authorizeStage(
    repoRoot,
    qualityRunId,
    "R-001",
    "strongest",
    refinePrompt
  );
  if (!refineAuthorization.ok) {
    return { ...refineAuthorization, quality_run_id: qualityRunId };
  }
  const refinement = await runStage(
    repoRoot,
    qualityRunId,
    "R-001",
    refinePrompt,
    refineAuthorization.value
  );
  if (!refinement.ok) {
    return { ...refinement, quality_run_id: qualityRunId };
  }

  const refinementPatch = await readArtifactPatch(repoRoot, refinement.value.artifact);
  if (!refinementPatch.ok) {
    return { ...refinementPatch, quality_run_id: qualityRunId };
  }
  const distinctness = measurePatchDistinctness(
    "D-001",
    draftPatch.value,
    "R-001",
    refinementPatch.value
  );
  const selection = await selectQualityWinner(repoRoot, qualityRunId);
  if (!selection.ok) {
    return { ...selection, quality_run_id: qualityRunId };
  }

  const reportPath = path.join(
    repoRoot,
    ".hivemind",
    "resource",
    "quality-runs",
    qualityRunId,
    "refinement.json"
  );
  const report: DraftRefineReport = {
    version: 1,
    quality_run_id: qualityRunId,
    task_id: parsed.value.task_id,
    strategy: "draft_refine",
    sequential: true,
    draft: {
      draft_id: "D-001",
      artifact_path: draft.value.artifact.artifact_path,
      provider: providerRecord(draftAuthorization.value, "cheapest")
    },
    refinement: {
      draft_id: "R-001",
      artifact_path: refinement.value.artifact.artifact_path,
      provider: providerRecord(refineAuthorization.value, "strongest"),
      critique_output_artifact: `${refinement.value.artifact.artifact_path}/output.jsonl`,
      critique_model_output_sha256: hashText(refinement.value.model_output),
      received_actual_draft_patch: true,
      received_actual_gate_shadow_evidence: true
    },
    distinctness,
    selection_artifact: `.hivemind/resource/quality-runs/${qualityRunId}/selection.json`,
    selected_draft_id: selection.value.selected_draft_id,
    advisory_only: true,
    automatic_adoption: false
  };
  try {
    await writeImmutableJsonArtifact(reportPath, report);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `draft-refine report could not be finalized: ${errorMessage(error)}`,
      quality_run_id: qualityRunId
    };
  }
  const recorded = await appendEvent(repoRoot, {
    type: "quality.refinement_completed",
    task_id: parsed.value.task_id,
    data: {
      version: 1,
      quality_run_id: qualityRunId,
      report_artifact: `.hivemind/resource/quality-runs/${qualityRunId}/refinement.json`,
      draft_id: "D-001",
      refinement_id: "R-001",
      selected_draft_id: selection.value.selected_draft_id,
      advisory_only: true,
      automatic_adoption: false
    }
  });
  if (!recorded.ok) {
    return {
      ok: false,
      reason: `refinement artifact was written but quality.refinement_completed could not be appended: ${recorded.reason}`,
      quality_run_id: qualityRunId
    };
  }
  return {
    ok: true,
    value: {
      version: 1,
      quality_run_id: qualityRunId,
      task_id: parsed.value.task_id,
      sequential: true,
      draft: draft.value.artifact,
      refinement: refinement.value.artifact,
      critique_rationale: refinement.value.model_output,
      distinctness,
      selection: selection.value,
      report
    }
  };
}

export async function draftRefineCommand(cwd: string, args: string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== "draft-refine" || args[1].trim() === "") {
    console.error("error: usage: hivemind quality draft-refine <task-id>");
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (repoRoot === null) {
    console.error("error: not a git repository");
    return 1;
  }
  const result = await generateDraftRefine(repoRoot, { task_id: args[1] });
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

async function authorizeStage(
  repoRoot: string,
  qualityRunId: string,
  draftId: "D-001" | "R-001",
  preference: "cheapest" | "strongest",
  prompt: string
): Promise<{ ok: true; value: RouteDecision } | { ok: false; reason: string }> {
  const authorization = await authorizeValueQualityCall(repoRoot, qualityRunId, {
    routingPreference: preference,
    estimatedInputTokens: estimateTokens(prompt)
  });
  if (!authorization.ok) {
    return {
      ok: false,
      reason: `${draftId} was refused before provider spawn: ${authorization.reason}`
    };
  }
  const routeValidation = validateQualityProviderRoute(authorization.value.route);
  return routeValidation.ok
    ? { ok: true, value: authorization.value.route }
    : { ok: false, reason: `${draftId} ${routeValidation.reason}` };
}

async function runStage(
  repoRoot: string,
  qualityRunId: string,
  draftId: "D-001" | "R-001",
  prompt: string,
  route: RouteDecision
): Promise<{
  ok: true;
  value: { artifact: SpeculativeDraftArtifact; model_output: string };
} | { ok: false; reason: string }> {
  let modelOutput = "";
  const disposed = await disposeSpeculativeDraft(
    repoRoot,
    { quality_run_id: qualityRunId, draft_id: draftId },
    async (checkoutPath) => {
      const execution = await runQualityProvider(
        repoRoot,
        route,
        checkoutPath,
        prompt,
        qualityRunId
      );
      modelOutput = execution.model_output;
      return execution.producer_result;
    }
  );
  if (!disposed.ok) {
    return disposed;
  }
  return {
    ok: true,
    value: {
      artifact: disposed.value,
      model_output: modelOutput
    }
  };
}

function buildDraftPrompt(contract: TaskContract, qualityRunId: string): string {
  return [
    buildAgentPrompt(contract),
    "",
    "M7.7e draft-cheap/refine-expensive draft rules:",
    `- Quality run: ${qualityRunId}`,
    "- Artifact identity: D-001",
    "- This is an isolated detached checkout at the canonical base commit.",
    "- Write a complete candidate patch in this checkout only.",
    "- Do not commit, create branches, acquire leases, or touch .hivemind state.",
    "- The patch is advisory and will be disposed by Hivemind's existing scope gate and shadow verifier.",
    "- Do not claim acceptance, integration, or selection.",
    "",
    "Canonical task contract:",
    JSON.stringify(contract, null, 2)
  ].join("\n");
}

function buildRefinePrompt(
  contract: TaskContract,
  qualityRunId: string,
  draftPatch: string,
  draft: SpeculativeDraftArtifact
): string {
  return [
    buildAgentPrompt(contract),
    "",
    "M7.7e draft-cheap/refine-expensive refinement rules:",
    `- Quality run: ${qualityRunId}`,
    "- Artifact identity: R-001",
    "- This is a fresh isolated detached checkout at the canonical base commit, not D-001's checkout.",
    "- Inspect D-001's immutable patch and its actual gate/shadow evidence below.",
    "- Identify concrete weaknesses, omissions, or verification failures in that evidence.",
    "- Write a complete refined patch in this checkout only; do not emit an incremental patch against D-001.",
    "- A cosmetic rewrite or style-only refactor is not a substantive refinement.",
    "- In your final response, begin with `REFINEMENT CRITIQUE:` and explain the specific evidence you responded to and the changes you made.",
    "- Do not commit, create branches, acquire leases, or touch .hivemind state.",
    "- The refinement is advisory and will independently pass through Hivemind's existing scope gate and shadow verifier.",
    "- Do not claim acceptance, integration, or selection.",
    "",
    "Canonical task contract:",
    JSON.stringify(contract, null, 2),
    "",
    "D-001 immutable patch:",
    "```diff",
    draftPatch.trimEnd(),
    "```",
    "",
    `D-001 actual gate evidence: ${JSON.stringify(draft.gate)}`,
    `D-001 actual shadow evidence: ${JSON.stringify(draft.shadow)}`
  ].join("\n");
}

function canRefine(draft: SpeculativeDraftArtifact): boolean {
  return (
    draft.outcome === "eligible" ||
    (draft.outcome === "gate_rejected" && draft.gate.status === "reject") ||
    draft.outcome === "shadow_failed"
  );
}

async function readArtifactPatch(
  repoRoot: string,
  artifact: SpeculativeDraftArtifact
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  try {
    return {
      ok: true,
      value: await readFile(path.join(repoRoot, artifact.artifact_path, "diff.patch"), "utf8")
    };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `could not read immutable ${artifact.draft_id} patch: ${errorMessage(error)}`
    };
  }
}

function providerRecord(
  route: RouteDecision,
  preference: StageProvider["routing_preference"]
): StageProvider {
  return {
    tool: route.tool,
    provider_tier: route.provider_tier,
    cost_rank: normalizeProfileCostRank(route.profile),
    profile_verified_on: route.profile.verified_on,
    routing_preference: preference
  };
}

function parseDraftRefineRequest(
  value: unknown
): { ok: true; value: DraftRefineRequest } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "draft-refine request must be a JSON object" };
  }
  if (Object.keys(value).some((key) => key !== "task_id")) {
    return { ok: false, reason: "draft-refine request contains an unsupported field" };
  }
  if (typeof value.task_id !== "string" || value.task_id.trim() === "") {
    return { ok: false, reason: "draft-refine task_id must be a non-empty string" };
  }
  return { ok: true, value: { task_id: value.task_id } };
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
