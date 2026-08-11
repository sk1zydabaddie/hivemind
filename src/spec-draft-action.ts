import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  adapterRunLogPath,
  findDangerousAdapterArgs,
  formatAdapterProcessFailure,
  loadAdapterProfile,
  runAdapterProcess
} from "./adapter.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic.js";
import { loadConfig } from "./config.js";
import { recordIdeationRound, startIdeationSession } from "./ideation.js";
import { trackedFilesAtBase, currentHead } from "./plan.js";
import { buildSpecDraftingPrompt, parseDraftedSpec } from "./spec-drafting.js";
import {
  activeSpecPath,
  buildDraftedSpec,
  isNodeError,
  specFilePath,
  type SpecResult
} from "./spec-format.js";

/**
 * The action that closes the front door.
 *
 * One adapter call turns what somebody typed into a short-form spec, opens its
 * ideation session, and records the drafter's own alternatives and self-critique
 * as the orchestrator's round. What comes out is a drafted, orchestrator-signed
 * spec that `plan.prepare` can plan from — and nothing more. The person's
 * signature is not here and cannot be: `convergence.user` is reachable only
 * through the challenge-bound human act in src/spec-convergence.ts, and this
 * module never touches it.
 *
 * The round is the drafter's real material rather than a stub assembled to pass
 * the gate. If a prompt is too thin for two honest alternatives, the drafter is
 * told to say so in an open question — which blocks ratification — instead of
 * inventing a second one.
 */

export interface DraftSpecResult {
  spec_id: string;
  title: string;
  status: "draft";
  open_questions: string[];
  non_goals: string[];
  assumptions: string[];
  alternatives: number;
}

export async function draftSpecFromPrompt(
  repoRoot: string,
  prompt: string,
  tool: string
): Promise<SpecResult<DraftSpecResult>> {
  if (prompt.trim() === "") {
    return { ok: false, reason: "describe what you want built before drafting a spec" };
  }

  const profile = await loadAdapterProfile(repoRoot, tool);
  if (!profile.ok) return profile;
  const dangerous = findDangerousAdapterArgs(profile.profile.invoke);
  if (dangerous.length > 0) {
    return {
      ok: false,
      reason: `drafting adapter profile "${tool}" contains dangerous invocation flags (${dangerous.join(", ")})`
    };
  }

  const config = await loadConfig(repoRoot);
  if (!config.ok) return config;
  const head = await currentHead(repoRoot);
  if (!head.ok) return head;
  const tracked = await trackedFilesAtBase(repoRoot, head.value);
  if (!tracked.ok) return tracked;

  const specId = await nextSpecId(repoRoot);
  if (!specId.ok) return specId;

  const drafting = buildSpecDraftingPrompt({
    prompt,
    trackedFiles: tracked.value,
    testCommand: config.config.test_command ?? null
  });
  const process = await runAdapterProcess(repoRoot, profile.profile, repoRoot, drafting, {
    outputLogPath: adapterRunLogPath(repoRoot, `drafting-${specId.value}`),
    usageSessionId: specId.value,
    usageRunId: specId.value
  });
  if (!process.ok) return process;
  if (process.value.exitCode !== 0) {
    return { ok: false, reason: formatAdapterProcessFailure(tool, process.value, "spec drafter") };
  }

  const proposal = parseDraftedSpec(process.value.modelOutput);
  if (!proposal.ok) return proposal;

  /* Written before the ideation session opens, because the session reads the
     document it is about. */
  await writeFileAtomic(
    specFilePath(repoRoot, specId.value),
    buildDraftedSpec({
      title: proposal.value.title,
      prompt,
      goal: proposal.value.goal,
      nonGoals: proposal.value.non_goals,
      acceptance: proposal.value.acceptance,
      openQuestions: proposal.value.open_questions,
      assumptions: proposal.value.assumptions
    })
  );
  await writeJsonAtomic(activeSpecPath(repoRoot), { version: 1, spec_id: specId.value });

  const session = await startIdeationSession(
    repoRoot,
    specId.value,
    proposal.value.title,
    proposal.value.goal
  );
  if (!session.ok) return session;

  /* The drafter's own alternatives and self-critique, recorded as the
     orchestrator's round. `orchestrator_calls_convergence` signs the half a
     model is allowed to sign. The other half stays unsigned. */
  const round = await recordIdeationRound(repoRoot, specId.value, {
    alternatives: proposal.value.alternatives,
    self_critique: proposal.value.self_critique,
    substantive_change: true,
    orchestrator_calls_convergence: true
  });
  if (!round.ok) return round;

  return {
    ok: true,
    value: {
      spec_id: specId.value,
      title: proposal.value.title,
      status: "draft",
      open_questions: proposal.value.open_questions,
      non_goals: proposal.value.non_goals,
      assumptions: proposal.value.assumptions,
      alternatives: proposal.value.alternatives.length
    }
  };
}

/** S-001, then S-002, and so on. Never reuses an id a document already has. */
async function nextSpecId(repoRoot: string): Promise<SpecResult<string>> {
  let entries: string[] = [];
  try {
    entries = await readdir(path.join(repoRoot, ".hivemind", "spec"));
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const used = new Set(
    entries
      .map((name) => /^S-(\d{3,})\.md$/u.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => Number.parseInt(value, 10))
  );
  for (let index = 1; index < 1000; index += 1) {
    if (!used.has(index)) return { ok: true, value: `S-${String(index).padStart(3, "0")}` };
  }
  return { ok: false, reason: "this project already has 999 specs" };
}
