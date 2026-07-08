import { createHash } from "node:crypto";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { appendEvent } from "./events.js";
import { estimateTokens } from "./resource-ledger.js";

const snapshotVersion = 1;
const contextPressureThresholdRatio = 0.8;

export interface OrchestratorContextPressureInput {
  repoRoot: string;
  tool: string;
  specId: string;
  userMessage: string;
  fullPrompt: string;
  leanPrompt: string;
  contextWindowTokens: number;
}

export interface OrchestratorContextResult {
  prompt: string;
  mode: "full" | "lean-rehydrated";
  metering: OrchestratorContextMetering;
  snapshot_path: string | null;
}

export interface OrchestratorContextMetering {
  assembled_tokens_estimated: number;
  context_window_tokens: number;
  threshold_tokens: number;
  threshold_ratio: number;
}

export interface OrchestratorSnapshotManifest {
  version: 1;
  kind: "orchestrator";
  created_at: string;
  reason: "context_pressure";
  metering: OrchestratorContextMetering & {
    tool: string;
    full_prompt_sha256: string;
    lean_prompt_sha256: string;
  };
  working_set_manifest: {
    user_message: {
      sha256: string;
      bytes: number;
    };
    spec_ref: {
      path: string;
      spec_id: string;
    };
    status_ref: {
      source: "getStatus(repoRoot)";
      authority: ".hivemind durable store";
      includes: ["active_leases", "task_states", "patch_state", "integration_state", "replan_state"];
    };
    plan_ref: {
      path: string;
      spec_id: string;
    };
    event_ref: {
      path: ".hivemind/log/events.jsonl";
      query: "read latest relevant durable events from disk";
    };
    adapter_tools_ref: {
      path: ".hivemind/adapters/*.profile.json";
    };
  };
  narrative_notes: {
    purpose: "working notes only; not authoritative state";
    distilled_summary: string;
  };
}

export async function applyOrchestratorContextBudget(input: OrchestratorContextPressureInput): Promise<{ ok: true; value: OrchestratorContextResult } | { ok: false; reason: string }> {
  const metering = meterContext(input.fullPrompt, input.contextWindowTokens);
  if (metering.assembled_tokens_estimated < metering.threshold_tokens) {
    return { ok: true, value: { prompt: input.fullPrompt, mode: "full", metering, snapshot_path: null } };
  }

  const snapshot = buildSnapshotManifest(input, metering);
  const snapshotPath = orchestratorSnapshotPath(input.repoRoot);
  await writeJsonAtomic(snapshotPath, snapshot);
  const checkpointed = await appendEvent(input.repoRoot, {
    type: "orchestrator.checkpointed",
    task_id: null,
    data: {
      source: "context-pressure",
      snapshot_path: orchestratorSnapshotRelativePath(),
      tool: input.tool,
      assembled_tokens_estimated: metering.assembled_tokens_estimated,
      context_window_tokens: metering.context_window_tokens,
      threshold_tokens: metering.threshold_tokens
    }
  });
  if (!checkpointed.ok) {
    return checkpointed;
  }
  const resumed = await appendEvent(input.repoRoot, {
    type: "orchestrator.resumed",
    task_id: null,
    data: {
      source: "context-pressure",
      snapshot_path: orchestratorSnapshotRelativePath(),
      mode: "lean-rehydrated",
      tool: input.tool
    }
  });
  if (!resumed.ok) {
    return resumed;
  }

  return {
    ok: true,
    value: {
      prompt: input.leanPrompt,
      mode: "lean-rehydrated",
      metering,
      snapshot_path: orchestratorSnapshotRelativePath()
    }
  };
}

export function orchestratorSnapshotRelativePath(): string {
  return ".hivemind/resource/checkpoints/orchestrator.snapshot.json";
}

function orchestratorSnapshotPath(repoRoot: string): string {
  return path.join(repoRoot, orchestratorSnapshotRelativePath());
}

function meterContext(fullPrompt: string, contextWindowTokens: number): OrchestratorContextMetering {
  const thresholdTokens = Math.max(1, Math.floor(contextWindowTokens * contextPressureThresholdRatio));
  return {
    assembled_tokens_estimated: estimateTokens(fullPrompt),
    context_window_tokens: contextWindowTokens,
    threshold_tokens: thresholdTokens,
    threshold_ratio: contextPressureThresholdRatio
  };
}

function buildSnapshotManifest(input: OrchestratorContextPressureInput, metering: OrchestratorContextMetering): OrchestratorSnapshotManifest {
  return {
    version: snapshotVersion,
    kind: "orchestrator",
    created_at: new Date().toISOString(),
    reason: "context_pressure",
    metering: {
      ...metering,
      tool: input.tool,
      full_prompt_sha256: sha256(input.fullPrompt),
      lean_prompt_sha256: sha256(input.leanPrompt)
    },
    working_set_manifest: {
      user_message: {
        sha256: sha256(input.userMessage),
        bytes: Buffer.byteLength(input.userMessage, "utf8")
      },
      spec_ref: {
        path: `.hivemind/spec/${input.specId}.md`,
        spec_id: input.specId
      },
      status_ref: {
        source: "getStatus(repoRoot)",
        authority: ".hivemind durable store",
        includes: ["active_leases", "task_states", "patch_state", "integration_state", "replan_state"]
      },
      plan_ref: {
        path: `.hivemind/plans/${input.specId}.tentative.json`,
        spec_id: input.specId
      },
      event_ref: {
        path: ".hivemind/log/events.jsonl",
        query: "read latest relevant durable events from disk"
      },
      adapter_tools_ref: {
        path: ".hivemind/adapters/*.profile.json"
      }
    },
    narrative_notes: {
      purpose: "working notes only; not authoritative state",
      distilled_summary: "Context pressure triggered re-hydration. Rebuild authoritative state by reading the durable store refs in working_set_manifest."
    }
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
