import { extractJsonObject } from "./json.js";
import type { SpecResult } from "./spec-format.js";

/**
 * Drafting a spec from what somebody typed.
 *
 * The prompt is written around one hazard. A non-goal is a *constraint on what
 * gets built*, so a drafted non-goal is a generated constraint, and one nobody
 * reads narrows the work silently. The drafter is therefore told to write
 * non-goals only where the prompt genuinely leaves a tempting adjacent scope,
 * to say what it is declining rather than gesturing at "anything else", and to
 * raise an open question instead of guessing when the answer would change what
 * gets built.
 *
 * Open questions block ratification, and that is deliberate: a drafter that
 * cannot tell what was wanted should stop the run rather than pick.
 */

export interface DraftedSpecProposal {
  title: string;
  goal: string;
  non_goals: string[];
  acceptance: string[];
  open_questions: string[];
}

export function buildSpecDraftingPrompt(input: {
  prompt: string;
  trackedFiles: string[];
  testCommand: string | null;
}): string {
  const sample = input.trackedFiles.slice(0, 200);
  return [
    "You are drafting a short specification from one sentence a person typed into a build tool.",
    "You are not planning the work, choosing files, or writing code.",
    "",
    "Return exactly one JSON object and no markdown fences or commentary:",
    "{",
    '  "title": "short noun phrase naming the change",',
    '  "goal": "one or two sentences: what should be true when this is done",',
    '  "non_goals": ["what this deliberately will NOT do"],',
    '  "acceptance": ["how someone checks it is done, in plain language"],',
    '  "open_questions": ["a question whose answer would change what gets built"]',
    "}",
    "",
    "NON-GOALS — read this twice.",
    "A non-goal is a constraint. Whatever you write here narrows what gets built,",
    "and the person approving may not notice you added it. So:",
    "- Write a non-goal only where this request has an obvious adjacent scope a",
    "  reasonable builder might wander into. Name that specific thing.",
    "- Say what is being declined, not a category. \"Does not add authentication\"",
    "  is a non-goal. \"Anything not listed above\" is not.",
    "- Do not invent scope limits the request does not imply. Narrowing someone's",
    "  request without being asked is the failure this field is guarding against.",
    "- If the request genuinely has no tempting adjacent scope, return an empty",
    "  list. An empty list is an honest answer.",
    "",
    "OPEN QUESTIONS.",
    "Raise one only when the answer would change what gets built and the request",
    "does not settle it. Anything you raise stops the run until a person answers,",
    "so do not raise preferences, naming, or anything you can reasonably decide.",
    "If you would otherwise guess at something that changes the outcome, ask.",
    "",
    "ACCEPTANCE.",
    "Write checks a person could run or observe.",
    input.testCommand === null
      ? "This project records no test command."
      : `This project's test command is: ${input.testCommand}`,
    "",
    "What the person typed, verbatim:",
    input.prompt.trim(),
    "",
    `Files in this project (${input.trackedFiles.length} total${sample.length < input.trackedFiles.length ? ", first 200 shown" : ""}):`,
    ...sample.map((file) => `  ${file}`)
  ].join("\n");
}

export function parseDraftedSpec(modelOutput: string): SpecResult<DraftedSpecProposal> {
  const extracted = extractJsonObject(modelOutput, "spec drafter");
  if (!extracted.ok) return extracted;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(extracted.value) as Record<string, unknown>;
  } catch (error: unknown) {
    return { ok: false, reason: `spec drafter returned invalid JSON: ${String(error)}` };
  }
  const title = readText(value.title);
  const goal = readText(value.goal);
  if (title === null) return { ok: false, reason: "drafted spec is missing a title" };
  if (goal === null) return { ok: false, reason: "drafted spec is missing a goal" };
  const nonGoals = readTextList(value.non_goals);
  const acceptance = readTextList(value.acceptance);
  const openQuestions = readTextList(value.open_questions);
  if (nonGoals === null) return { ok: false, reason: "drafted spec non_goals must be a list of strings" };
  if (acceptance === null) return { ok: false, reason: "drafted spec acceptance must be a list of strings" };
  if (openQuestions === null) {
    return { ok: false, reason: "drafted spec open_questions must be a list of strings" };
  }
  if (acceptance.length === 0) {
    return { ok: false, reason: "drafted spec must state at least one acceptance check" };
  }
  return {
    ok: true,
    value: { title, goal, non_goals: nonGoals, acceptance, open_questions: openQuestions }
  };
}

/**
 * Is this a real constraint, or a shrug?
 *
 * An empty non-goals list is an honest answer for a request with no tempting
 * adjacent scope. A list whose only content is a placeholder is not: it passes
 * the Non-goals gate while telling the person nothing, which turns the gate
 * into theatre. Vacuity is reported rather than repaired, because the fix is to
 * the drafting prompt and pretending otherwise hides that.
 */
const VACUOUS = [
  /^none\b/iu,
  /^n\/?a\b/iu,
  /^nothing\b/iu,
  /^no\s+non-?goals?\b/iu,
  /^not\s+applicable\b/iu,
  /^anything\s+(not|else)\b/iu,
  /^everything\s+else\b/iu,
  /^out\s+of\s+scope\b/iu,
  /^tbd\b/iu,
  /^unspecified\b/iu
];

export interface NonGoalVacuity {
  /** No non-goals at all. Honest for some requests, suspicious across many. */
  empty: boolean;
  /** Entries that say nothing: "None recorded", "Anything else". */
  vacuous: string[];
  /** Entries that name a specific declined scope. */
  substantive: string[];
}

export function assessNonGoals(nonGoals: string[]): NonGoalVacuity {
  const vacuous: string[] = [];
  const substantive: string[] = [];
  for (const entry of nonGoals) {
    const text = entry.trim();
    if (text === "" || VACUOUS.some((pattern) => pattern.test(text))) vacuous.push(entry);
    else substantive.push(entry);
  }
  return { empty: nonGoals.length === 0, vacuous, substantive };
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readTextList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    if (entry.trim() !== "") items.push(entry.trim());
  }
  return items;
}
