import { stat } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import type { CanonMemoryEntry } from "./memory-canon.js";
import { readMemoryProposal } from "./memory-log.js";
import type { MemoryResult } from "./memory-types.js";

export interface HumanMemoryReview {
  decision: "approve" | "reject";
  evidence_reviewed: boolean;
  reviewer: "human";
}

export async function reviewMemoryProposal(
  repoRoot: string,
  proposalId: string,
  review: unknown
): Promise<MemoryResult<CanonMemoryEntry>> {
  if (
    !isRecord(review) ||
    review.decision !== "approve" ||
    review.evidence_reviewed !== true ||
    review.reviewer !== "human"
  ) {
    return {
      ok: false,
      reason: "canon promotion requires explicit human approval after reviewing the cited evidence"
    };
  }

  const proposal = await readMemoryProposal(repoRoot, proposalId);
  if (!proposal.ok) {
    return proposal;
  }

  const canonPath = canonEntryPath(repoRoot, proposalId);
  if (await exists(canonPath)) {
    return { ok: false, reason: `memory proposal is already in canon: ${proposalId}` };
  }

  const entry: CanonMemoryEntry = {
    version: 1,
    canon_id: proposal.value.proposal_id,
    proposal_id: proposal.value.proposal_id,
    approved_at: new Date().toISOString(),
    approved_by: "human",
    title: proposal.value.title,
    lesson: proposal.value.lesson,
    evidence: proposal.value.evidence,
    source_task_id: proposal.value.task_id
  };
  await writeJsonAtomic(canonPath, entry);
  return { ok: true, value: entry };
}

function canonEntryPath(repoRoot: string, proposalId: string): string {
  return path.join(repoRoot, ".hivemind", "canon", `${proposalId}.memory.json`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
