import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isMemoryProposalId, type MemoryResult } from "./memory-types.js";

export interface CanonMemoryEntry {
  version: 1;
  canon_id: string;
  proposal_id: string;
  approved_at: string;
  approved_by: "human";
  title: string;
  lesson: string;
  evidence: string[];
  source_task_id: string | null;
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
      `Evidence: ${entry.evidence.join(" | ")}`
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
    "lesson",
    "proposal_id",
    "source_task_id",
    "title",
    "version"
  ];
  if (JSON.stringify(Object.keys(value).sort(compareText)) !== JSON.stringify(expectedKeys)) {
    return { ok: false, reason: "entry fields do not match the canon schema" };
  }
  if (
    value.version !== 1 ||
    typeof value.canon_id !== "string" ||
    value.canon_id !== value.proposal_id ||
    typeof value.proposal_id !== "string" ||
    !isMemoryProposalId(value.proposal_id) ||
    typeof value.approved_at !== "string" ||
    Number.isNaN(Date.parse(value.approved_at)) ||
    value.approved_by !== "human" ||
    typeof value.title !== "string" ||
    value.title.trim() === "" ||
    typeof value.lesson !== "string" ||
    value.lesson.trim() === "" ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.some((item) => typeof item !== "string" || item.trim() === "") ||
    (value.source_task_id !== null && typeof value.source_task_id !== "string")
  ) {
    return { ok: false, reason: "entry values do not match the canon schema" };
  }
  return { ok: true, value: value as unknown as CanonMemoryEntry };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
