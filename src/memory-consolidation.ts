import {
  adapterRunLogPath,
  findDangerousAdapterArgs,
  formatAdapterProcessFailure,
  loadAdapterProfile,
  recordAdapterUsage,
  runAdapterProcess
} from "./adapter.js";
import { readEvents, type HivemindEvent } from "./events.js";
import { extractJsonObject } from "./json.js";
import { proposeMemoryLesson, type MemoryProposal, type MemoryProposalInput } from "./memory-log.js";
import type { MemoryResult } from "./memory-types.js";
import { withProjectTempDirectory } from "./project-temp.js";

const maximumProposalCount = 8;

interface ConsolidationEvidence {
  ref: string;
  event: HivemindEvent;
}

export interface MemoryConsolidationResult {
  tool: string;
  source_event_count: number;
  proposal_count: number;
  proposals: MemoryProposal[];
}

export async function consolidateMemory(
  repoRoot: string,
  tool: string
): Promise<MemoryResult<MemoryConsolidationResult>> {
  const events = await readEvents(repoRoot);
  if (!events.ok) {
    return events;
  }
  const evidence = consolidatableEvidence(events.value);
  if (evidence.length === 0) {
    return { ok: false, reason: "no consolidatable Tier-1 evidence found" };
  }

  const profile = await loadAdapterProfile(repoRoot, tool);
  if (!profile.ok) {
    return profile;
  }
  const dangerousArgs = findDangerousAdapterArgs(profile.profile.invoke);
  if (dangerousArgs.length > 0) {
    return {
      ok: false,
      reason: `consolidation adapter profile "${tool}" contains dangerous invocation flags (${dangerousArgs.join(", ")}); proposal generation must use a non-dangerous profile`
    };
  }

  const prompt = buildConsolidationPrompt(evidence);
  const outputLogPath = adapterRunLogPath(repoRoot, "memory-consolidation");
  const startedAt = Date.now();
  return withProjectTempDirectory(repoRoot, "consolidation", async ({ path: isolatedCwd }) => {
    const processResult = await runAdapterProcess(repoRoot, profile.profile, isolatedCwd, prompt, { outputLogPath });
    if (!processResult.ok) {
      return processResult;
    }
    const wallTimeMs = Date.now() - startedAt;
    const ledger = await recordAdapterUsage(repoRoot, profile.profile, prompt, processResult.value, wallTimeMs);
    if (!ledger.ok) {
      return ledger;
    }
    if (processResult.value.exitCode !== 0) {
      return { ok: false, reason: formatAdapterProcessFailure(tool, processResult.value, "consolidation adapter") };
    }

    const parsed = parseConsolidationOutput(processResult.value.stdout, new Set(evidence.map((item) => item.ref)));
    if (!parsed.ok) {
      return parsed;
    }

    const proposals: MemoryProposal[] = [];
    for (const proposal of parsed.value) {
      const appended = await proposeMemoryLesson(repoRoot, proposal);
      if (!appended.ok) {
        return appended;
      }
      proposals.push(appended.value);
    }
    return {
      ok: true,
      value: {
        tool: profile.profile.tool,
        source_event_count: evidence.length,
        proposal_count: proposals.length,
        proposals
      }
    };
  });
}

function consolidatableEvidence(events: HivemindEvent[]): ConsolidationEvidence[] {
  return events.flatMap((event, index) =>
    event.type === "memory.proposed" || event.type === "memory.accepted"
      ? []
      : [{ ref: `events.jsonl#L${index + 1}`, event }]
  );
}

function buildConsolidationPrompt(evidence: ConsolidationEvidence[]): string {
  return [
    "You are Hivemind's Dreaming / Consolidation Worker.",
    "Distill substantive review proposals from the supplied Tier-1 event history.",
    "You PROPOSE only. Never claim approval, promotion, ratification, or canon writes.",
    "Do not write files. Return exactly one JSON object and no commentary.",
    "",
    "Required schema:",
    '{"proposals":[{"title":"specific review title","lesson":"substantive proposed decision, routing policy, or playbook","evidence":["events.jsonl#L1"]}]}',
    "",
    `Rules:
- Return zero to ${maximumProposalCount} proposals.
- Use only exact evidence refs supplied below; never invent evidence.
- Prefer repeated, concrete patterns over generic advice.
- State whether each lesson is a proposed project decision, routing policy, or playbook in its title or lesson.
- Do not include reviewer, approval, canon, promotion, confidence, or action fields.
- Similar events should be distilled into one useful proposal rather than repeated individually.`,
    "",
    "Tier-1 evidence:",
    ...evidence.map((item) => JSON.stringify(item))
  ].join("\n");
}

function parseConsolidationOutput(
  stdout: string,
  availableEvidence: Set<string>
): MemoryResult<MemoryProposalInput[]> {
  const extracted = extractJsonObject(stdout, "consolidation worker");
  if (!extracted.ok) {
    return extracted;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(extracted.value);
  } catch {
    return { ok: false, reason: "consolidation worker did not return valid JSON" };
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: "consolidation worker output must be a JSON object" };
  }
  const rootKeys = Object.keys(raw);
  if (rootKeys.length !== 1 || rootKeys[0] !== "proposals") {
    return { ok: false, reason: "consolidation worker output may contain only the proposals field" };
  }
  if (!Array.isArray(raw.proposals) || raw.proposals.length > maximumProposalCount) {
    return {
      ok: false,
      reason: `consolidation worker proposals must be an array with at most ${maximumProposalCount} entries`
    };
  }

  const proposals: MemoryProposalInput[] = [];
  for (const [index, value] of raw.proposals.entries()) {
    if (!isRecord(value)) {
      return { ok: false, reason: `consolidation proposal[${index}] must be a JSON object` };
    }
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "evidence,lesson,title") {
      return {
        ok: false,
        reason: `consolidation proposal[${index}] may contain only title, lesson, and evidence`
      };
    }
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const lesson = typeof value.lesson === "string" ? value.lesson.trim() : "";
    if (title === "" || lesson === "") {
      return {
        ok: false,
        reason: `consolidation proposal[${index}] title and lesson must be non-empty strings`
      };
    }
    if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
      return { ok: false, reason: `consolidation proposal[${index}] must cite Tier-1 evidence` };
    }
    const evidenceRefs: string[] = [];
    for (const [evidenceIndex, evidenceRef] of value.evidence.entries()) {
      if (typeof evidenceRef !== "string" || !availableEvidence.has(evidenceRef)) {
        return {
          ok: false,
          reason: `consolidation proposal[${index}] evidence[${evidenceIndex}] must be an exact supplied Tier-1 ref`
        };
      }
      if (!evidenceRefs.includes(evidenceRef)) {
        evidenceRefs.push(evidenceRef);
      }
    }
    proposals.push({ title, lesson, evidence: evidenceRefs });
  }
  return { ok: true, value: proposals };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
