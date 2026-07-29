import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { writeJsonAtomic } from "./atomic.js";
import type { CanonMemoryEntry } from "./memory-canon.js";
import { readMemoryProposal } from "./memory-log.js";
import type { MemoryResult } from "./memory-types.js";

export async function reviewMemoryProposalInteractively(
  repoRoot: string,
  proposalId: string
): Promise<MemoryResult<CanonMemoryEntry>> {
  const proposal = await readMemoryProposal(repoRoot, proposalId);
  if (!proposal.ok) {
    return proposal;
  }
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) {
    return {
      ok: false,
      reason: "canon promotion requires an interactive TTY human review"
    };
  }

  process.stderr.write([
    `Tier-1 proposal: ${proposal.value.proposal_id}`,
    `Title: ${proposal.value.title}`,
    `Lesson: ${proposal.value.lesson}`,
    "Evidence:",
    ...proposal.value.evidence.map((item, index) => `  ${index + 1}. ${item}`),
    ...(proposal.value.routing_policy === null
      ? []
      : ["Structured routing policy:", JSON.stringify(proposal.value.routing_policy, null, 2)]),
    ...(proposal.value.verification_policy === null
      ? []
      : ["Structured verification policy:", JSON.stringify(proposal.value.verification_policy, null, 2)])
  ].join("\n") + "\n");

  const expected = `approve ${proposal.value.proposal_id}`;
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let confirmation: string;
  try {
    confirmation = await terminal.question(`Type "${expected}" to confirm review of this proposal and its evidence: `);
  } finally {
    terminal.close();
  }
  if (confirmation.trim() !== expected) {
    return { ok: false, reason: "canon promotion was not explicitly confirmed" };
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
    evidence_acknowledged: [proposal.value.proposal_id],
    title: proposal.value.title,
    lesson: proposal.value.lesson,
    evidence: proposal.value.evidence,
    source_task_id: proposal.value.task_id,
    routing_policy: proposal.value.routing_policy,
    verification_policy: proposal.value.verification_policy
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
