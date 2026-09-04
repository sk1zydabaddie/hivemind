import { isRecord } from "./json.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { consolidateMemory, type MemoryConsolidationResult } from "./memory-consolidation.js";
import { proposeMemoryLesson, type MemoryProposal, type MemoryProposalInput } from "./memory-log.js";
import { reviewMemoryProposalInteractively } from "./memory-review.js";
import type { MemoryResult } from "./memory-types.js";
import type { CanonMemoryEntry } from "./memory-canon.js";
import { findGitRoot } from "./repo.js";

type MemoryCommandInput =
  | { action: "propose"; inputFile: string }
  | { action: "review"; proposalId: string }
  | { action: "consolidate"; tool: string };

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

  let result: MemoryResult<MemoryProposal | CanonMemoryEntry | MemoryConsolidationResult>;
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
  } else if (parsed.value.action === "review") {
    const daemonProbe = await callDaemonIfConfigured<unknown>(repoRoot, "/status", {});
    result = daemonProbe.routed
      ? {
          ok: false,
          reason: daemonProbe.ok
            ? "interactive canon review is local-only; stop the Hivemind daemon before reviewing"
            : `interactive canon review refused because daemon ownership could not be ruled out: ${daemonProbe.reason}`
        }
      : await reviewMemoryProposalInteractively(repoRoot, parsed.value.proposalId);
  } else {
    const daemonProbe = await callDaemonIfConfigured<unknown>(repoRoot, "/status", {});
    result = daemonProbe.routed
      ? {
          ok: false,
          reason: daemonProbe.ok
            ? "on-demand memory consolidation is local-only; stop the Hivemind daemon before consolidating"
            : `memory consolidation refused because daemon ownership could not be ruled out: ${daemonProbe.reason}`
        }
      : await consolidateMemory(repoRoot, parsed.value.tool);
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
    args.length === 3 &&
    args[0] === "review" &&
    args[1].trim() !== "" &&
    args[2] === "--approve"
  ) {
    return {
      ok: true,
      value: {
        action: "review",
        proposalId: args[1]
      }
    };
  }
  if (
    args.length === 3 &&
    args[0] === "consolidate" &&
    args[1] === "--tool" &&
    args[2].trim() !== ""
  ) {
    return { ok: true, value: { action: "consolidate", tool: args[2].trim() } };
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
  const allowedKeys = ["evidence", "lesson", "routing_policy", "task_id", "title", "value_quality_policy", "verification_policy"];
  if (keys.some((key) => !allowedKeys.includes(key))) {
    return { ok: false, reason: `unsupported memory proposal field: ${keys.find((key) => !allowedKeys.includes(key))}` };
  }
  return {
    ok: true,
    value: {
      title: parsed.title as string,
      lesson: parsed.lesson as string,
      evidence: parsed.evidence as string[],
      ...(parsed.task_id === undefined ? {} : { task_id: parsed.task_id as string }),
      ...(parsed.routing_policy === undefined ? {} : { routing_policy: parsed.routing_policy as MemoryProposalInput["routing_policy"] }),
      ...(parsed.value_quality_policy === undefined ? {} : { value_quality_policy: parsed.value_quality_policy as MemoryProposalInput["value_quality_policy"] }),
      ...(parsed.verification_policy === undefined ? {} : { verification_policy: parsed.verification_policy as MemoryProposalInput["verification_policy"] })
    }
  };
}

function memoryUsage(): string {
  return "usage: hivemind memory propose <proposal-json-file> | review <proposal-id> --approve | consolidate --tool <tool>";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
