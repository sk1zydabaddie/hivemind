import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  adapterRunLogPath,
  findDangerousAdapterArgs,
  formatAdapterProcessFailure,
  loadAdapterProfile,
  runAdapterProcess,
  type AdapterProfile
} from "./adapter.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic.js";
import { loadConfig } from "./config.js";
import { recordIdeationRound, startIdeationSession } from "./ideation.js";
import { trackedFilesAtBase, currentHead } from "./plan.js";
import { buildSpecDraftingPrompt, parseDraftedSpec, type DraftedSpecProposal } from "./spec-drafting.js";
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
  const drafted = await draftUntilReadable(repoRoot, profile.profile, tool, specId.value, drafting);
  if (!drafted.ok) return drafted;
  const proposal = drafted;

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

/**
 * How many times the drafter may be asked before the front door gives up.
 *
 * Three, because the failure this exists for is sampling variance from a cheap
 * model: the one observed case succeeded on the very next attempt with the same
 * prompt and the same model. Bounded because each attempt is a real call --
 * roughly 20K tokens on the first run measured -- and an unbounded retry on the
 * front door is a way to spend somebody's money without telling them.
 */
const DRAFT_ATTEMPTS = 3;

/**
 * Ask the drafter until its answer can be READ, and no further.
 *
 * The distinction that matters is what counts as retryable. Only a failure to
 * parse the model's output is:
 *
 * - An **adapter failure** -- a non-zero exit, a timeout, a quota wall -- is
 *   returned immediately. Retrying could spend money against a wall that is
 *   still there, and the reason is already accurate.
 * - A **blocking question** never reaches here at all. It is a SUCCESSFUL parse
 *   whose `open_questions` are non-empty, and it flows through to the spec to
 *   stop ratification later. Nothing in this loop can retry one away, which is
 *   the property that makes retrying safe: the drafter's judgement is in the
 *   parsed value, never in a parse error.
 *
 * A retry restates the same request to the same model at the same tier -- no
 * escalation -- with one line naming what was unreadable, because a model told
 * what it got wrong does better than one asked identically twice.
 */
async function draftUntilReadable(
  repoRoot: string,
  profile: AdapterProfile,
  tool: string,
  specId: string,
  drafting: string
): Promise<SpecResult<DraftedSpecProposal>> {
  let lastReason = "";
  for (let attempt = 1; attempt <= DRAFT_ATTEMPTS; attempt += 1) {
    const prompt =
      attempt === 1
        ? drafting
        : [
            drafting,
            "",
            `Your previous reply could not be read: ${lastReason}`,
            "Reply with the JSON object only. No prose before or after it, no code fence."
          ].join("\n");
    const process = await runAdapterProcess(repoRoot, profile, repoRoot, prompt, {
      /* Every attempt keeps its own log, so the trail shows what was actually
         returned each time rather than only the last one. */
      outputLogPath: adapterRunLogPath(repoRoot, `drafting-${specId}-${attempt}`),
      usageSessionId: specId,
      usageRunId: specId
    });
    if (!process.ok) return process;
    if (process.value.exitCode !== 0) {
      return { ok: false, reason: formatAdapterProcessFailure(tool, process.value, "spec drafter") };
    }
    const parsed = parseDraftedSpec(process.value.modelOutput);
    if (parsed.ok) return parsed;
    lastReason = parsed.reason;
  }
  return {
    ok: false,
    reason:
      `The agent that turns your request into a plan replied with something this build could not read, ` +
      `${DRAFT_ATTEMPTS} times in a row. The last attempt: ${lastReason}. ` +
      `This is almost always the agent rather than your request, so sending the same thing again often works. ` +
      `If it keeps happening, try describing what you want in a sentence or two more detail, or connect a stronger ` +
      `agent as your planner in Settings. Nothing has been written to your project.`
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
