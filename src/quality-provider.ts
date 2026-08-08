import {
  findDangerousAdapterArgs,
  formatAdapterProcessFailure,
  runAdapterProcess,
  type AdapterProcessResult
} from "./adapter.js";
import { estimateTokens } from "./resource-ledger.js";
import { appendEvent } from "./events.js";
import { qualityRunCancelled } from "./quality-control.js";
import type { RouteDecision } from "./routing.js";
import {
  type SpeculativeDraftOutput,
  type SpeculativeDraftProducerResult,
  type SpeculativeDraftProvenance
} from "./speculative-draft.js";

export interface QualityProviderExecution {
  producer_result: SpeculativeDraftProducerResult;
  model_output: string;
}

export function validateQualityProviderRoute(
  route: RouteDecision
): { ok: true } | { ok: false; reason: string } {
  const dangerousArgs = findDangerousAdapterArgs(route.profile.invoke);
  return dangerousArgs.length === 0
    ? { ok: true }
    : {
        ok: false,
        reason: `adapter profile "${route.tool}" contains dangerous invocation flags (${dangerousArgs.join(", ")}); speculative generation requires a confined writable profile`
      };
}

export async function runQualityProvider(
  repoRoot: string,
  route: RouteDecision,
  checkoutPath: string,
  prompt: string,
  qualityRunId: string,
  draftId: string,
  taskId: string
): Promise<QualityProviderExecution> {
  const output: SpeculativeDraftOutput[] = [];
  const startedAt = Date.now();
  const processResult = await runAdapterProcess(
    repoRoot,
    route.profile,
    checkoutPath,
    prompt,
    {
      usageSessionId: qualityRunId,
      usageRunId: qualityRunId,
      shouldCancel: () => qualityRunCancelled(repoRoot, qualityRunId),
      onProcessStart: async (identity) => {
        const recorded = await appendEvent(repoRoot, {
          type: "quality.worker_process_started",
          // The event is about a task; emitting null made every reader that
          // scopes by task drop it silently.
          task_id: taskId,
          data: {
            version: 1,
            quality_run_id: qualityRunId,
            draft_id: draftId,
            provider: route.tool,
            pid: identity.pid,
            process_instance_id: identity.process_instance_id
          }
        });
        return recorded.ok ? { ok: true as const } : recorded;
      },
      onStreamChunk: (chunk) => output.push(chunk)
    }
  );
  const wallTimeMs = Date.now() - startedAt;
  if (!processResult.ok) {
    return {
      producer_result: {
        status: "crashed",
        reason: processResult.reason,
        output,
        provenance: buildUnstartedProvenance(route, qualityRunId, wallTimeMs)
      },
      model_output: ""
    };
  }

  ensureCapturedOutput(output, processResult.value);
  const provenance = buildProcessProvenance(
    route,
    qualityRunId,
    wallTimeMs,
    processResult.value,
    processResult.value.quotaRequest,
    prompt
  );
  if (processResult.value.timedOut) {
    return {
      producer_result: {
        status: "timed_out",
        reason: `quality adapter "${route.tool}" timed out`,
        output,
        provenance
      },
      model_output: processResult.value.modelOutput
    };
  }
  if (processResult.value.cancelled === true) {
    return {
      producer_result: {
        status: "cancelled",
        reason: `quality run ${qualityRunId} cancelled by durable human request`,
        output,
        provenance
      },
      model_output: processResult.value.modelOutput
    };
  }
  if (processResult.value.exitCode !== 0) {
    return {
      producer_result: {
        status: "crashed",
        reason: formatAdapterProcessFailure(
          route.tool,
          processResult.value,
          "speculative quality adapter"
        ),
        output,
        provenance
      },
      model_output: processResult.value.modelOutput
    };
  }
  return {
    producer_result: {
      status: "completed",
      output,
      provenance
    },
    model_output: processResult.value.modelOutput
  };
}

function buildUnstartedProvenance(
  route: RouteDecision,
  sessionId: string,
  wallTimeMs: number
): SpeculativeDraftProvenance {
  return {
    source: "adapter",
    tool: route.tool,
    provider_tier: route.provider_tier,
    profile_verified_on: route.profile.verified_on,
    usage_session_id: sessionId,
    exit_code: null,
    wall_time_ms: wallTimeMs,
    effective_tokens: null,
    accounting_source: null,
    provider_usage_status: null
  };
}

function buildProcessProvenance(
  route: RouteDecision,
  sessionId: string,
  wallTimeMs: number,
  processResult: AdapterProcessResult,
  lastRequest: {
    effective_tokens: number;
    accounting_source: "provider_reported" | "self_measured";
  } | null,
  prompt: string
): SpeculativeDraftProvenance {
  const providerUsage = processResult.providerUsageCapture.status === "captured"
    ? processResult.providerUsageCapture.usage.total_tokens
    : null;
  const fallbackTokens = estimateTokens(prompt) + estimateTokens(processResult.modelOutput);
  return {
    source: "adapter",
    tool: route.tool,
    provider_tier: route.provider_tier,
    profile_verified_on: route.profile.verified_on,
    usage_session_id: sessionId,
    exit_code: processResult.exitCode,
    wall_time_ms: wallTimeMs,
    effective_tokens: lastRequest?.effective_tokens ?? providerUsage ?? fallbackTokens,
    accounting_source:
      lastRequest?.accounting_source ??
      (providerUsage === null ? "self_measured" : "provider_reported"),
    provider_usage_status: processResult.providerUsageCapture.status
  };
}

function ensureCapturedOutput(
  output: SpeculativeDraftOutput[],
  result: AdapterProcessResult
): void {
  if (output.length > 0) {
    return;
  }
  if (result.stdout !== "") {
    output.push({ stream: "stdout", text: result.stdout });
  }
  if (result.stderr !== "") {
    output.push({ stream: "stderr", text: result.stderr });
  }
}
