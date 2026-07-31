import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildAgentPrompt } from "./adapter.js";
import { loadAndValidateContract, type TaskContract } from "./contract.js";
import { writeImmutableJsonArtifact } from "./immutable-artifact.js";
import {
  measurePatchDistinctness,
  type PatchDistinctness
} from "./quality-distinctness.js";
import {
  runQualityProvider,
  validateQualityProviderRoute
} from "./quality-provider.js";
import { findGitRoot } from "./repo.js";
import { estimateTokens } from "./resource-ledger.js";
import {
  disposeSpeculativeDraft,
  type SpeculativeDraftArtifact
} from "./speculative-draft.js";
import {
  admitValueQuality,
  authorizeValueQualityCall
} from "./value-quality.js";

const defaultDraftCount = 2;
const maximumDraftCount = 3;

export interface BestOfNRequest {
  task_id: string;
  n?: number;
  tool?: string;
}

export type DraftDistinctnessPair = PatchDistinctness;

export interface BestOfNDistinctnessReport {
  version: 1;
  quality_run_id: string;
  task_id: string;
  method: "normalized changed-line set Jaccard";
  prompt_diversity_strategy: "prior-draft contrast framing";
  provider_specific_seed_or_temperature: false;
  human_judgment_required: true;
  pairs: DraftDistinctnessPair[];
}

export interface BestOfNResult {
  version: 1;
  quality_run_id: string;
  task_id: string;
  requested_draft_count: number;
  sequential: true;
  drafts: SpeculativeDraftArtifact[];
  distinctness: BestOfNDistinctnessReport;
}

export type BestOfNOutcome =
  | { ok: true; value: BestOfNResult }
  | { ok: false; reason: string; quality_run_id?: string };

interface PriorDraftEvidence {
  draft_id: string;
  patch: string;
  gate: SpeculativeDraftArtifact["gate"];
  shadow: SpeculativeDraftArtifact["shadow"];
}

export async function generateBestOfN(
  repoRoot: string,
  request: unknown
): Promise<BestOfNOutcome> {
  const parsed = parseBestOfNRequest(request);
  if (!parsed.ok) {
    return parsed;
  }
  const contract = await loadAndValidateContract(repoRoot, parsed.value.task_id);
  if (!contract.ok) {
    return contract;
  }
  const draftCount = parsed.value.n ?? defaultDraftCount;
  const admission = await admitValueQuality(repoRoot, parsed.value.task_id, {
    strategy: "best_of_n",
    n: draftCount
  });
  if (!admission.ok) {
    return admission;
  }

  const qualityRunId = admission.value.quality_run_id;
  const drafts: SpeculativeDraftArtifact[] = [];
  const priorDrafts: PriorDraftEvidence[] = [];

  for (let draftNumber = 1; draftNumber <= draftCount; draftNumber += 1) {
    const draftId = formatDraftId(draftNumber);
    const prompt = buildBestOfNPrompt(
      contract.contract,
      qualityRunId,
      draftId,
      draftNumber,
      priorDrafts
    );
    const authorization = await authorizeValueQualityCall(repoRoot, qualityRunId, {
      ...(parsed.value.tool === undefined ? {} : { requestedTool: parsed.value.tool }),
      estimatedInputTokens: estimateTokens(prompt)
    });
    if (!authorization.ok) {
      return {
        ok: false,
        reason: `draft ${draftId} was refused before provider spawn: ${authorization.reason}`,
        quality_run_id: qualityRunId
      };
    }
    const routeValidation = validateQualityProviderRoute(authorization.value.route);
    if (!routeValidation.ok) {
      return {
        ok: false,
        reason: `draft ${draftId} ${routeValidation.reason}`,
        quality_run_id: qualityRunId
      };
    }

    const disposed = await disposeSpeculativeDraft(
      repoRoot,
      { quality_run_id: qualityRunId, draft_id: draftId },
      async (checkoutPath) => {
        const execution = await runQualityProvider(
          repoRoot,
          authorization.value.route,
          checkoutPath,
          prompt,
          qualityRunId
        );
        return execution.producer_result;
      }
    );
    if (!disposed.ok) {
      return {
        ok: false,
        reason: disposed.reason,
        quality_run_id: qualityRunId
      };
    }
    drafts.push(disposed.value);
    priorDrafts.push({
      draft_id: draftId,
      patch: await readFile(path.join(repoRoot, disposed.value.artifact_path, "diff.patch"), "utf8"),
      gate: disposed.value.gate,
      shadow: disposed.value.shadow
    });
    if (
      disposed.value.outcome === "producer_crashed" ||
      disposed.value.outcome === "producer_timed_out" ||
      disposed.value.outcome === "producer_cancelled" ||
      disposed.value.outcome === "producer_exception"
    ) {
      return {
        ok: false,
        reason: `draft ${draftId} provider execution stopped the quality run: ${disposed.value.reason}`,
        quality_run_id: qualityRunId
      };
    }
  }

  const distinctness = buildDistinctnessReport(
    qualityRunId,
    parsed.value.task_id,
    priorDrafts
  );
  try {
    await writeImmutableJsonArtifact(
      path.join(
        repoRoot,
        ".hivemind",
        "resource",
        "quality-runs",
        qualityRunId,
        "distinctness.json"
      ),
      distinctness
    );
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `best-of-N distinctness artifact could not be finalized: ${errorMessage(error)}`,
      quality_run_id: qualityRunId
    };
  }
  return {
    ok: true,
    value: {
      version: 1,
      quality_run_id: qualityRunId,
      task_id: parsed.value.task_id,
      requested_draft_count: draftCount,
      sequential: true,
      drafts,
      distinctness
    }
  };
}

export async function bestOfNCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseBestOfNCommandArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (repoRoot === null) {
    console.error("error: not a git repository");
    return 1;
  }
  const result = await generateBestOfN(repoRoot, parsed.value);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

function buildBestOfNPrompt(
  contract: TaskContract,
  qualityRunId: string,
  draftId: string,
  draftNumber: number,
  priorDrafts: PriorDraftEvidence[]
): string {
  const diversityInstruction = draftNumber === 1
    ? [
        "This is the first candidate. Solve the scoped contract directly with your strongest implementation.",
        "Do not optimize for superficial novelty; produce a coherent, complete approach."
      ]
    : [
        `This is candidate ${draftNumber}. Prior immutable candidate patches and their real disposer evidence appear below.`,
        "Pursue a materially different design or implementation from every prior candidate.",
        "Change architecture, decomposition, algorithm, data flow, or another substantive choice where the contract permits.",
        "Cosmetic renaming, formatting changes, or restating a prior patch do not count as a different approach.",
        "Do not edit a prior candidate: create an independent solution from the unchanged base checkout."
      ];
  return [
    buildAgentPrompt(contract),
    "",
    "M7.7c speculative draft rules:",
    `- Quality run: ${qualityRunId}`,
    `- Draft identity: ${draftId}`,
    "- This is an isolated detached checkout at the canonical base commit.",
    "- Write the candidate patch in this checkout only.",
    "- Do not commit, create branches, acquire leases, or touch .hivemind state.",
    "- The patch remains advisory and will be disposed by Hivemind's existing scope gate and shadow verifier.",
    "- Do not claim acceptance, integration, or selection.",
    ...diversityInstruction.map((line) => `- ${line}`),
    "",
    "Canonical task contract:",
    JSON.stringify(contract, null, 2),
    "",
    ...(priorDrafts.length === 0
      ? ["Prior immutable candidates: (none)"]
      : [
          "Prior immutable candidates and real disposer evidence:",
          ...priorDrafts.flatMap((prior) => [
            `### ${prior.draft_id}`,
            "```diff",
            prior.patch.trimEnd(),
            "```",
            `Gate evidence: ${JSON.stringify(prior.gate)}`,
            `Shadow evidence: ${JSON.stringify(prior.shadow)}`
          ])
        ])
  ].join("\n");
}

function buildDistinctnessReport(
  qualityRunId: string,
  taskId: string,
  drafts: PriorDraftEvidence[]
): BestOfNDistinctnessReport {
  const pairs: DraftDistinctnessPair[] = [];
  for (let leftIndex = 0; leftIndex < drafts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < drafts.length; rightIndex += 1) {
      const left = drafts[leftIndex];
      const right = drafts[rightIndex];
      pairs.push(measurePatchDistinctness(
        left.draft_id,
        left.patch,
        right.draft_id,
        right.patch
      ));
    }
  }
  return {
    version: 1,
    quality_run_id: qualityRunId,
    task_id: taskId,
    method: "normalized changed-line set Jaccard",
    prompt_diversity_strategy: "prior-draft contrast framing",
    provider_specific_seed_or_temperature: false,
    human_judgment_required: true,
    pairs
  };
}

function parseBestOfNRequest(
  value: unknown
): { ok: true; value: BestOfNRequest } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "best-of-N request must be a JSON object" };
  }
  if (Object.keys(value).some((key) => key !== "task_id" && key !== "n" && key !== "tool")) {
    return { ok: false, reason: "best-of-N request contains an unsupported field" };
  }
  if (typeof value.task_id !== "string" || value.task_id.trim() === "") {
    return { ok: false, reason: "best-of-N task_id must be a non-empty string" };
  }
  if (
    value.n !== undefined &&
    (!Number.isSafeInteger(value.n) ||
      Number(value.n) < defaultDraftCount ||
      Number(value.n) > maximumDraftCount)
  ) {
    return { ok: false, reason: "best-of-N draft count must be an integer from 2 through 3" };
  }
  if (value.tool !== undefined && (typeof value.tool !== "string" || value.tool.trim() === "")) {
    return { ok: false, reason: "best-of-N tool must be a non-empty string when provided" };
  }
  return {
    ok: true,
    value: {
      task_id: value.task_id,
      ...(value.n === undefined ? {} : { n: Number(value.n) }),
      ...(value.tool === undefined ? {} : { tool: value.tool })
    }
  };
}

function parseBestOfNCommandArgs(
  args: string[]
): { ok: true; value: BestOfNRequest } | { ok: false; reason: string } {
  if (args.length < 2 || args[0] !== "best-of-n" || args[1].trim() === "") {
    return { ok: false, reason: bestOfNUsage() };
  }
  const request: Record<string, unknown> = { task_id: args[1] };
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index];
    const flagValue = args[index + 1];
    if (flagValue === undefined) {
      return { ok: false, reason: bestOfNUsage() };
    }
    if (flag === "--n" && /^\d+$/u.test(flagValue)) {
      if ("n" in request) {
        return { ok: false, reason: bestOfNUsage() };
      }
      request.n = Number(flagValue);
      continue;
    }
    if (flag === "--tool" && flagValue.trim() !== "") {
      if ("tool" in request) {
        return { ok: false, reason: bestOfNUsage() };
      }
      request.tool = flagValue;
      continue;
    }
    return { ok: false, reason: bestOfNUsage() };
  }
  return parseBestOfNRequest(request);
}

function bestOfNUsage(): string {
  return "usage: hivemind quality best-of-n <task-id> [--n 2|3] [--tool <adapter>]";
}

function formatDraftId(value: number): string {
  return `D-${String(value).padStart(3, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "unknown error";
}
