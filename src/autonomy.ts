import { createHash } from "node:crypto";
import path from "node:path";

import { writeJsonAtomic } from "./atomic.js";
import { loadConfig } from "./config.js";
import { appendEvent } from "./events.js";
import { readJsonFile } from "./json.js";
import type { SpecResult } from "./spec.js";
import { autonomyLevels, DEFAULT_AUTONOMY_LEVEL, type AutonomyLevel } from "./autonomy-level.js";

export { autonomyLevels, DEFAULT_AUTONOMY_LEVEL, type AutonomyLevel } from "./autonomy-level.js";

export interface AutonomyDecisionInput {
  level: AutonomyLevel;
  session_id: string | null;
  decision: "plan_ratification" | "manager_action" | "run_started";
  action_type: string;
  interruption: "suppressed" | "required" | "not_applicable";
  authorization_source: "autonomy_policy" | "human" | "deterministic_pipeline";
  pending_action_id?: string;
  result?: "authorized" | "paused" | "refused" | "started";
  reason: string;
}

export async function readProjectAutonomyLevel(repoRoot: string): Promise<SpecResult<AutonomyLevel>> {
  const loaded = await loadConfig(repoRoot);
  if (!loaded.ok) return loaded;
  return { ok: true, value: loaded.config.manager_autonomy?.level ?? DEFAULT_AUTONOMY_LEVEL };
}

export async function setProjectAutonomyLevel(
  repoRoot: string,
  level: AutonomyLevel
): Promise<SpecResult<{ level: AutonomyLevel; previous_level: AutonomyLevel }>> {
  if (!autonomyLevels.includes(level)) {
    return { ok: false, reason: "autonomy level must be auto, review_plan, or review_everything" };
  }
  const loaded = await loadConfig(repoRoot);
  if (!loaded.ok) return loaded;
  const previousLevel = loaded.config.manager_autonomy?.level ?? DEFAULT_AUTONOMY_LEVEL;
  if (previousLevel === level) return { ok: true, value: { level, previous_level: previousLevel } };

  const configPath = path.join(repoRoot, ".hivemind", "config.json");
  const raw = await readJsonFile(configPath);
  if (!isRecord(raw)) return { ok: false, reason: "config must be a JSON object" };
  const priorManager = isRecord(raw.manager_autonomy) ? raw.manager_autonomy : {};
  const next = { ...raw, manager_autonomy: { ...priorManager, level } };
  await writeJsonAtomic(configPath, next);
  const recorded = await appendEvent(repoRoot, {
    type: "autonomy.level_changed",
    task_id: null,
    data: {
      version: 1,
      previous_level: previousLevel,
      level,
      applies_from: "next_interruption_decision",
      config_hash: hashJson(next)
    }
  });
  if (!recorded.ok) {
    await writeJsonAtomic(configPath, raw);
    return { ok: false, reason: `autonomy level change was rolled back because its durable event failed: ${recorded.reason}` };
  }
  return { ok: true, value: { level, previous_level: previousLevel } };
}

export async function recordAutonomyDecision(
  repoRoot: string,
  input: AutonomyDecisionInput
): Promise<SpecResult<AutonomyDecisionInput>> {
  const recorded = await appendEvent(repoRoot, {
    type: "autonomy.decision_recorded",
    task_id: null,
    data: { version: 1, ...input }
  });
  return recorded.ok ? { ok: true, value: input } : recorded;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
