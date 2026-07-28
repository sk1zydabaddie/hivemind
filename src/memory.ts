import { readFile } from "node:fs/promises";
import path from "node:path";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { proposeMemoryLesson, type MemoryProposal, type MemoryProposalInput } from "./memory-log.js";
import { reviewMemoryProposal, type HumanMemoryReview } from "./memory-review.js";
import type { MemoryResult } from "./memory-types.js";
import type { CanonMemoryEntry } from "./memory-canon.js";
import { findGitRoot } from "./repo.js";

type MemoryCommandInput =
  | { action: "propose"; inputFile: string }
  | { action: "review"; proposalId: string; review: HumanMemoryReview };

export async function memoryCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseMemoryArgs(cwd, args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  let result: MemoryResult<MemoryProposal | CanonMemoryEntry>;
  if (parsed.value.action === "propose") {
    const input = await readProposalInput(parsed.value.inputFile);
    if (!input.ok) {
      console.error(`error: ${input.reason}`);
      return 1;
    }
    const routed = await callDaemonIfConfigured<MemoryProposal>(repoRoot, "/memory/propose", { proposal: input.value });
    result = routed.routed
      ? routed.ok
        ? { ok: true, value: routed.value }
        : { ok: false, reason: routed.reason }
      : await proposeMemoryLesson(repoRoot, input.value);
  } else {
    const routed = await callDaemonIfConfigured<CanonMemoryEntry>(repoRoot, "/memory/review", {
      proposal_id: parsed.value.proposalId,
      review: parsed.value.review
    });
    result = routed.routed
      ? routed.ok
        ? { ok: true, value: routed.value }
        : { ok: false, reason: routed.reason }
      : await reviewMemoryProposal(repoRoot, parsed.value.proposalId, parsed.value.review);
  }

  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

function parseMemoryArgs(cwd: string, args: string[]): MemoryResult<MemoryCommandInput> {
  if (args.length === 2 && args[0] === "propose" && args[1].trim() !== "") {
    return { ok: true, value: { action: "propose", inputFile: path.resolve(cwd, args[1]) } };
  }
  if (
    args.length === 4 &&
    args[0] === "review" &&
    args[1].trim() !== "" &&
    args[2] === "--approve" &&
    args[3] === "--evidence-reviewed"
  ) {
    return {
      ok: true,
      value: {
        action: "review",
        proposalId: args[1],
        review: { decision: "approve", evidence_reviewed: true, reviewer: "human" }
      }
    };
  }
  return { ok: false, reason: memoryUsage() };
}

async function readProposalInput(filePath: string): Promise<MemoryResult<MemoryProposalInput>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof SyntaxError
        ? "memory proposal file must contain valid JSON"
        : `could not read memory proposal file: ${errorMessage(error)}`
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "memory proposal file must contain a JSON object" };
  }
  const keys = Object.keys(parsed).sort();
  if (keys.some((key) => !["evidence", "lesson", "task_id", "title"].includes(key))) {
    return { ok: false, reason: `unsupported memory proposal field: ${keys.find((key) => !["evidence", "lesson", "task_id", "title"].includes(key))}` };
  }
  return {
    ok: true,
    value: {
      title: parsed.title as string,
      lesson: parsed.lesson as string,
      evidence: parsed.evidence as string[],
      ...(parsed.task_id === undefined ? {} : { task_id: parsed.task_id as string })
    }
  };
}

function memoryUsage(): string {
  return "usage: hivemind memory propose <proposal-json-file> | review <proposal-id> --approve --evidence-reviewed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
