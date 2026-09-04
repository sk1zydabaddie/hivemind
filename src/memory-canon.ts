import { isRecord } from "./json.js";
import { isNodeError } from "./error-detail.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isMemoryProposalId, type MemoryResult } from "./memory-types.js";
import { validateLearnedRoutingPolicy, type LearnedRoutingPolicy } from "./routing-policy-schema.js";
import { validateValueQualityPolicy, type ValueQualityPolicy } from "./value-quality-policy-schema.js";
import { validateVerificationPolicy, type VerificationPolicy } from "./verification-policy-schema.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";

export interface CanonMemoryEntry {
  version: 1;
  canon_id: string;
  proposal_id: string;
  approved_at: string;
  approved_by: "human";
  evidence_acknowledged: string[];
  title: string;
  lesson: string;
  evidence: string[];
  source_task_id: string | null;
  routing_policy: LearnedRoutingPolicy | null;
  value_quality_policy: ValueQualityPolicy | null;
  verification_policy: VerificationPolicy | null;
}

export async function readCanonMemory(repoRoot: string): Promise<MemoryResult<CanonMemoryEntry[]>> {
  const directory = path.join(repoRoot, ".hivemind", "canon");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: true, value: [] };
    }
    throw error;
  }

  const entries: CanonMemoryEntry[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".memory.json")).sort(compareText)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    } catch (error: unknown) {
      return {
        ok: false,
        reason: error instanceof SyntaxError
          ? `invalid JSON in .hivemind/canon/${name}`
          : `could not read .hivemind/canon/${name}: ${errorMessage(error)}`
      };
    }
    const validated = validateCanonMemoryEntry(parsed);
    if (!validated.ok) {
      return { ok: false, reason: `invalid canon entry .hivemind/canon/${name}: ${validated.reason}` };
    }
    if (name !== `${validated.value.proposal_id}.memory.json`) {
      return { ok: false, reason: `canon filename does not match proposal id: .hivemind/canon/${name}` };
    }
    entries.push(validated.value);
  }
  return { ok: true, value: entries };
}

export function formatCanonForPlanning(entries: CanonMemoryEntry[]): string {
  if (entries.length === 0) {
    return "(none)";
  }
  return entries
    .map((entry) => [
      `[${entry.canon_id}] ${entry.title}`,
      entry.lesson,
      `Evidence: ${entry.evidence.join(" | ")}`,
      ...(entry.routing_policy === null ? [] : [`Routing policy: ${JSON.stringify(entry.routing_policy)}`]),
      ...(entry.value_quality_policy === null ? [] : [`Value-quality policy: ${JSON.stringify(entry.value_quality_policy)}`]),
      ...(entry.verification_policy === null ? [] : [`Verification policy: ${JSON.stringify(entry.verification_policy)}`])
    ].join("\n"))
    .join("\n\n");
}

function validateCanonMemoryEntry(value: unknown): MemoryResult<CanonMemoryEntry> {
  if (!isRecord(value)) {
    return { ok: false, reason: "entry must be a JSON object" };
  }
  const expectedKeys = [
    "approved_at",
    "approved_by",
    "canon_id",
    "evidence",
    "evidence_acknowledged",
    "lesson",
    "proposal_id",
    "source_task_id",
    "title",
    "version",
    ...(Object.prototype.hasOwnProperty.call(value, "routing_policy") ? ["routing_policy"] : []),
    ...(Object.prototype.hasOwnProperty.call(value, "value_quality_policy") ? ["value_quality_policy"] : []),
    ...(Object.prototype.hasOwnProperty.call(value, "verification_policy") ? ["verification_policy"] : [])
  ];
  if (JSON.stringify(Object.keys(value).sort(compareText)) !== JSON.stringify(expectedKeys.sort(compareText))) {
    return { ok: false, reason: "entry fields do not match the canon schema" };
  }
  const routingPolicy = value.routing_policy === undefined || value.routing_policy === null
    ? { ok: true as const, value: null }
    : validateLearnedRoutingPolicy(value.routing_policy);
  const verificationPolicy = value.verification_policy === undefined || value.verification_policy === null
    ? { ok: true as const, value: null }
    : validateVerificationPolicy(value.verification_policy);
  const valueQualityPolicy = value.value_quality_policy === undefined || value.value_quality_policy === null
    ? { ok: true as const, value: null }
    : validateValueQualityPolicy(value.value_quality_policy);
  const gated = checkFormatVersion(value, formatVersions.memoryCanon, "the memory canon record");
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
  }
  if (
    typeof value.canon_id !== "string" ||
    value.canon_id !== value.proposal_id ||
    typeof value.proposal_id !== "string" ||
    !isMemoryProposalId(value.proposal_id) ||
    typeof value.approved_at !== "string" ||
    Number.isNaN(Date.parse(value.approved_at)) ||
    value.approved_by !== "human" ||
    !Array.isArray(value.evidence_acknowledged) ||
    value.evidence_acknowledged.length !== 1 ||
    value.evidence_acknowledged[0] !== value.proposal_id ||
    typeof value.title !== "string" ||
    value.title.trim() === "" ||
    typeof value.lesson !== "string" ||
    value.lesson.trim() === "" ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.some((item) => typeof item !== "string" || item.trim() === "") ||
    (value.source_task_id !== null && typeof value.source_task_id !== "string") ||
    !routingPolicy.ok ||
    !valueQualityPolicy.ok ||
    !verificationPolicy.ok
  ) {
    return { ok: false, reason: "entry values do not match the canon schema" };
  }
  return {
    ok: true,
    value: {
      ...(value as unknown as Omit<CanonMemoryEntry, "routing_policy" | "value_quality_policy" | "verification_policy">),
      routing_policy: routingPolicy.ok ? routingPolicy.value : null,
      value_quality_policy: valueQualityPolicy.ok ? valueQualityPolicy.value : null,
      verification_policy: verificationPolicy.ok ? verificationPolicy.value : null
    }
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
