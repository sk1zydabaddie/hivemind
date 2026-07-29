import { randomUUID } from "node:crypto";
import { appendEvent, readEvents, type HivemindEvent } from "./events.js";
import { isMemoryProposalId, type MemoryResult } from "./memory-types.js";
import { validateLearnedRoutingPolicy, type LearnedRoutingPolicy } from "./routing-policy-schema.js";
import { validateVerificationPolicy, type VerificationPolicy } from "./verification-policy-schema.js";

export interface MemoryProposalInput {
  title: string;
  lesson: string;
  evidence: string[];
  task_id?: string;
  routing_policy?: LearnedRoutingPolicy;
  verification_policy?: VerificationPolicy;
}

export interface MemoryProposal {
  version: 1;
  proposal_id: string;
  proposed_at: string;
  title: string;
  lesson: string;
  evidence: string[];
  task_id: string | null;
  routing_policy: LearnedRoutingPolicy | null;
  verification_policy: VerificationPolicy | null;
}

export async function proposeMemoryLesson(
  repoRoot: string,
  input: unknown
): Promise<MemoryResult<MemoryProposal>> {
  const parsed = validateMemoryProposalInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  const proposalId = `M-${randomUUID()}`;
  const appended = await appendEvent(repoRoot, {
    type: "memory.proposed",
    task_id: parsed.value.task_id,
    data: {
      version: 1,
      proposal_id: proposalId,
      title: parsed.value.title,
      lesson: parsed.value.lesson,
      evidence: parsed.value.evidence,
      ...(parsed.value.routing_policy === null ? {} : { routing_policy: parsed.value.routing_policy }),
      ...(parsed.value.verification_policy === null ? {} : { verification_policy: parsed.value.verification_policy })
    }
  });
  if (!appended.ok) {
    return appended;
  }

  return {
    ok: true,
    value: proposalFromEvent(appended.value, proposalId, parsed.value)
  };
}

export async function readMemoryProposal(
  repoRoot: string,
  proposalId: string
): Promise<MemoryResult<MemoryProposal>> {
  if (!isMemoryProposalId(proposalId)) {
    return { ok: false, reason: "memory proposal id must use the M-<uuid> format" };
  }

  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }

  const matches = events.value.filter(
    (event) => event.type === "memory.proposed" && event.data.proposal_id === proposalId
  );
  if (matches.length === 0) {
    return { ok: false, reason: `memory proposal not found: ${proposalId}` };
  }
  if (matches.length !== 1) {
    return { ok: false, reason: `memory proposal id is ambiguous in Tier-1 log: ${proposalId}` };
  }
  return parseMemoryProposalEvent(matches[0]);
}

function validateMemoryProposalInput(
  input: unknown
): MemoryResult<{
  title: string;
  lesson: string;
  evidence: string[];
  task_id: string | null;
  routing_policy: LearnedRoutingPolicy | null;
  verification_policy: VerificationPolicy | null;
}> {
  if (!isRecord(input)) {
    return { ok: false, reason: "memory proposal must be a JSON object" };
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title === "") {
    return { ok: false, reason: "memory proposal title must be a non-empty string" };
  }
  const lesson = typeof input.lesson === "string" ? input.lesson.trim() : "";
  if (lesson === "") {
    return { ok: false, reason: "memory proposal lesson must be a non-empty string" };
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    return { ok: false, reason: "memory proposal must cite at least one evidence item" };
  }
  const evidence: string[] = [];
  for (const [index, value] of input.evidence.entries()) {
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, reason: `memory proposal evidence[${index}] must be a non-empty string` };
    }
    evidence.push(value.trim());
  }
  if (input.task_id !== undefined && (typeof input.task_id !== "string" || input.task_id.trim() === "")) {
    return { ok: false, reason: "memory proposal task_id must be a non-empty string when provided" };
  }
  const routingPolicy = input.routing_policy === undefined
    ? { ok: true as const, value: null }
    : validateLearnedRoutingPolicy(input.routing_policy);
  if (!routingPolicy.ok) {
    return { ok: false, reason: `memory proposal routing_policy is invalid: ${routingPolicy.reason}` };
  }
  const verificationPolicy = input.verification_policy === undefined
    ? { ok: true as const, value: null }
    : validateVerificationPolicy(input.verification_policy);
  if (!verificationPolicy.ok) {
    return { ok: false, reason: `memory proposal verification_policy is invalid: ${verificationPolicy.reason}` };
  }
  return {
    ok: true,
    value: {
      title,
      lesson,
      evidence,
      task_id: input.task_id?.trim() ?? null,
      routing_policy: routingPolicy.value,
      verification_policy: verificationPolicy.value
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMemoryProposalEvent(event: HivemindEvent): MemoryResult<MemoryProposal> {
  const proposalId = event.data.proposal_id;
  const title = event.data.title;
  const lesson = event.data.lesson;
  const evidence = event.data.evidence;
  const routingPolicy = event.data.routing_policy === undefined
    ? { ok: true as const, value: null }
    : validateLearnedRoutingPolicy(event.data.routing_policy);
  const verificationPolicy = event.data.verification_policy === undefined
    ? { ok: true as const, value: null }
    : validateVerificationPolicy(event.data.verification_policy);
  if (
    event.type !== "memory.proposed" ||
    typeof proposalId !== "string" ||
    !isMemoryProposalId(proposalId) ||
    event.data.version !== 1 ||
    typeof title !== "string" ||
    title.trim() === "" ||
    typeof lesson !== "string" ||
    lesson.trim() === "" ||
    !Array.isArray(evidence) ||
    evidence.length === 0 ||
    evidence.some((item) => typeof item !== "string" || item.trim() === "") ||
    !routingPolicy.ok ||
    !verificationPolicy.ok
  ) {
    return { ok: false, reason: "memory.proposed event has invalid proposal data" };
  }
  return {
    ok: true,
    value: {
      version: 1,
      proposal_id: proposalId,
      proposed_at: event.ts,
      title: title.trim(),
      lesson: lesson.trim(),
      evidence: evidence.map((item) => String(item).trim()),
      task_id: event.task_id,
      routing_policy: routingPolicy.ok ? routingPolicy.value : null,
      verification_policy: verificationPolicy.ok ? verificationPolicy.value : null
    }
  };
}

function proposalFromEvent(
  event: HivemindEvent,
  proposalId: string,
  input: {
    title: string;
    lesson: string;
    evidence: string[];
    task_id: string | null;
    routing_policy: LearnedRoutingPolicy | null;
    verification_policy: VerificationPolicy | null;
  }
): MemoryProposal {
  return {
    version: 1,
    proposal_id: proposalId,
    proposed_at: event.ts,
    title: input.title,
    lesson: input.lesson,
    evidence: input.evidence,
    task_id: input.task_id,
    routing_policy: input.routing_policy,
    verification_policy: input.verification_policy
  };
}
