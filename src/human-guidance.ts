import { randomUUID } from "node:crypto";
import { appendEvent, readEvents } from "./events.js";

export interface HumanGuidance {
  guidance_id: string;
  target: "orchestrator";
  message: string;
  recorded_at: string;
}

type GuidanceResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function recordHumanGuidance(
  repoRoot: string,
  request: unknown
): Promise<GuidanceResult<HumanGuidance>> {
  if (!isRecord(request)) {
    return { ok: false, reason: "human guidance must be a JSON object" };
  }
  const keys = Object.keys(request);
  if (keys.some((key) => key !== "target" && key !== "message")) {
    return { ok: false, reason: `human guidance contains unsupported authority field: ${keys.find((key) => key !== "target" && key !== "message")}` };
  }
  if (request.target !== "orchestrator") {
    return { ok: false, reason: "human guidance target must be orchestrator" };
  }
  if (typeof request.message !== "string" || request.message.trim() === "" || request.message.length > 20_000) {
    return { ok: false, reason: "human guidance message must be a non-empty string of at most 20000 characters" };
  }
  const guidance: HumanGuidance = {
    guidance_id: `H-${randomUUID()}`,
    target: "orchestrator",
    message: request.message.trim(),
    recorded_at: new Date().toISOString()
  };
  const appended = await appendEvent(repoRoot, {
    type: "human.guidance_recorded",
    task_id: null,
    data: {
      version: 1,
      ...guidance,
      advisory_only: true,
      authorization_effect: "none"
    }
  });
  return appended.ok ? { ok: true, value: guidance } : appended;
}

export async function readPendingHumanGuidance(repoRoot: string): Promise<GuidanceResult<HumanGuidance[]>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const consumed = new Set<string>();
  for (const event of events.value) {
    if (event.type !== "human.guidance_consumed") continue;
    if (!Array.isArray(event.data.guidance_ids) || !event.data.guidance_ids.every((id) => typeof id === "string")) {
      return { ok: false, reason: "durable human guidance consumption evidence is malformed" };
    }
    for (const id of event.data.guidance_ids) {
      consumed.add(id);
    }
  }
  const pending: HumanGuidance[] = [];
  for (const event of events.value) {
    if (event.type !== "human.guidance_recorded") continue;
    const id = event.data.guidance_id;
    const message = event.data.message;
    if (
      typeof id !== "string" ||
      typeof message !== "string" ||
      event.data.target !== "orchestrator" ||
      event.data.advisory_only !== true ||
      event.data.authorization_effect !== "none"
    ) {
      return { ok: false, reason: "durable human guidance evidence is malformed or claims authority" };
    }
    if (consumed.has(id)) continue;
    pending.push({ guidance_id: id, target: "orchestrator", message, recorded_at: event.ts });
  }
  return { ok: true, value: pending };
}

export async function markHumanGuidanceConsumed(
  repoRoot: string,
  guidanceIds: string[],
  sessionId: string | undefined
): Promise<GuidanceResult<void>> {
  if (guidanceIds.length === 0) return { ok: true, value: undefined };
  const appended = await appendEvent(repoRoot, {
    type: "human.guidance_consumed",
    task_id: null,
    data: {
      version: 1,
      guidance_ids: [...new Set(guidanceIds)].sort(),
      manager_session_id: sessionId ?? null,
      consumed_on: "next_proposal",
      authorization_effect: "none"
    }
  });
  return appended.ok ? { ok: true, value: undefined } : appended;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
