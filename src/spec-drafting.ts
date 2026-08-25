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

export interface DraftedAlternative {
  title: string;
  tradeoffs: string[];
}

/**
 * What the drafter answers when the message was not a build request.
 *
 * The composer looks like a chat, so people type into it what they would type
 * into a chat: greetings, questions, half-formed ideas. Routing all of that
 * into spec drafting produced a gate refusal ("first ideation round must
 * include at least two alternatives") for the word "hello", which is the
 * interface lying about what it is.
 *
 * The DRAFTER decides, in the call that was already being made, and it answers
 * with a typed kind. Nothing here reads the person's words to route them: the
 * client cannot see the text and Core branches on the code, which is the rule
 * this project has recorded four times.
 *
 * A reply carries no authority. It writes one conversation event, allocates no
 * spec, opens no ideation round, and cannot ratify, approve or start anything.
 * Talking is talking; approving is still a button.
 */
export interface DraftedReply {
  kind: "reply";
  reply: string;
}

export type DraftedAnswer = ({ kind: "spec" } & DraftedSpecProposal) | DraftedReply;

export interface DraftedSpecProposal {
  title: string;
  goal: string;
  non_goals: string[];
  acceptance: string[];
  open_questions: string[];
  /* Choices made because the request did not say. Recorded so the person can
     see and reject them: accepting a decision somebody else made is the same
     hazard as adopting a constraint somebody else wrote. */
  assumptions: string[];
  /* The ideation gate wants two real ways to do this, with what each costs.
     Asked for here rather than stubbed after the fact: a round assembled to
     satisfy a validator is the same theatre as a placeholder non-goal. */
  alternatives: DraftedAlternative[];
  self_critique: { weakest_point: string; cut_or_change: string };
}

export const draftedSpecJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    /* The discriminator. Constrained to the two words the parser switches on,
       so a provider that enforces the schema cannot answer with a third. */
    kind: { type: "string", enum: ["spec", "reply"] },
    reply: { type: "string" },
    title: { type: "string" },
    goal: { type: "string" },
    non_goals: { type: "array", items: { type: "string" } },
    acceptance: { type: "array", items: { type: "string" }, minItems: 1 },
    assumptions: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
    alternatives: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          tradeoffs: { type: "array", items: { type: "string" } }
        },
        required: ["title", "tradeoffs"],
        additionalProperties: false
      }
    },
    self_critique: {
      type: "object",
      properties: {
        weakest_point: { type: "string" },
        cut_or_change: { type: "string" }
      },
      required: ["weakest_point", "cut_or_change"],
      additionalProperties: false
    }
  },
  /* Only the discriminator is always required: a reply carries `reply` and a
     spec carries the rest, and the parser enforces which. Requiring the spec
     fields here would make the reply shape unrepresentable. */
  required: ["kind"],
  additionalProperties: false
};

export function buildSpecDraftingPrompt(input: {
  prompt: string;
  trackedFiles: string[];
  testCommand: string | null;
  /** A plan is already prepared and waiting, so answer rather than draft. */
  answerOnly?: boolean;
}): string {
  const sample = input.trackedFiles.slice(0, 200);
  return [
    ...(input.answerOnly === true
      ? [
          "A plan is ALREADY PREPARED for this project and is waiting for the person to look at it.",
          "",
          "So do not draft a specification, whatever the message says. Answer it.",
          "Use \"kind\": \"reply\" every time. If the message describes work, say that a plan",
          "is already waiting and that they can look at it or start over -- and do not",
          "describe the new work as though it were being planned, because it is not.",
          ""
        ]
      : []),
    "A person typed something into a build tool. Decide first what it is, then answer.",
    "You are not planning the work, choosing files, or writing code.",
    "",
    "TWO KINDS OF ANSWER. Choose one.",
    "",
    "1. The message asks for something to be BUILT or CHANGED in this project.",
    "   Draft a short specification for it, using \"kind\": \"spec\".",
    "",
    "2. Anything else -- a greeting, a question about this project or about how",
    "   this tool works, a remark, or a message too vague to build from. Answer",
    "   it in your own words, using \"kind\": \"reply\".",
    "",
    "   Reply plainly and briefly, the way a colleague would. You may answer",
    "   questions about this project from the file list below. If the message",
    "   seems to WANT something built but is too thin to draft from, say what",
    "   you would need to know -- do not draft from a guess, and do not refuse:",
    "   ask.",
    "",
    "   A reply starts no work, approves nothing, and changes no file. Never say",
    "   in a reply that you have started, approved, planned or built anything.",
    "",
    "Return exactly one JSON object and no markdown fences or commentary.",
    "",
    "For a reply:",
    '{ "kind": "reply", "reply": "what you want to say back" }',
    "",
    "For a specification:",
    "{",
    '  "kind": "spec",',
    '  "title": "short noun phrase naming the change",',
    '  "goal": "one or two sentences: what should be true when this is done",',
    '  "non_goals": ["what this deliberately will NOT do"],',
    '  "acceptance": ["how someone checks it is done, in plain language"],',
    '  "assumptions": ["a choice you made because the request did not say, stated plainly"],',
    '  "open_questions": ["only where NO reasonable default exists"],',
    '  "alternatives": [{ "title": "a way to do this", "tradeoffs": ["what it costs", "what it buys"] }],',
    '  "self_critique": { "weakest_point": "the weakest thing about this spec", "cut_or_change": "what to cut or change" }',
    "}",
    "",
    "ALTERNATIVES.",
    "Give at least two genuinely different ways to satisfy the request, each with",
    "real tradeoffs. Not one real option and one straw man. If the request is so",
    "thin that two honest alternatives do not exist, say so in an open question",
    "rather than inventing a second one.",
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
    "AMBIGUITY: assume, do not ask.",
    "Most requests are underspecified. That is the normal condition of software",
    "work, not a reason to stop. Where the request leaves a choice open and a",
    "reasonable implementer would just pick, PICK -- and record the choice in",
    "\"assumptions\" so the person can see it and say no.",
    "",
    "  \"Add a way to validate email addresses\" -> assume practical syntax",
    "  validation, not RFC-strict parsing and not checking deliverability.",
    "  State that assumption. Do not ask which one.",
    "",
    "OPEN QUESTIONS are rare and expensive.",
    "An open question STOPS THE RUN until a person answers it. Raise one only",
    "where no reasonable default exists and choosing wrong wastes the whole run --",
    "typically because the request does not say WHERE the work goes:",
    "",
    "  blocking:     \"Which of the three services should this live in?\"",
    "  NOT blocking: \"How strict should validation be?\" (assume, and say so)",
    "  NOT blocking: naming, formatting, library choice, error message wording",
    "",
    "If you can imagine a competent person just deciding and getting on with it,",
    "it is an assumption, not a question. When in doubt, assume and state it.",
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

/**
 * What the drafter answered: a specification, or a message back.
 *
 * Switches on `kind` and nothing else -- never on the person's words. An answer
 * that omits the field is read as a spec, so a provider that drops it behaves
 * exactly as it did before this existed: the old failure mode, not a new one.
 */
export function parseDraftedAnswer(modelOutput: string): SpecResult<DraftedAnswer> {
  const extracted = extractJsonObject(modelOutput, "spec drafter");
  if (!extracted.ok) return extracted;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(extracted.value) as Record<string, unknown>;
  } catch (error: unknown) {
    return { ok: false, reason: `spec drafter returned invalid JSON: ${String(error)}` };
  }
  if (value.kind === "reply") {
    const reply = readText(value.reply);
    if (reply === null) {
      return { ok: false, reason: "the drafter chose to reply but returned no message" };
    }
    return { ok: true, value: { kind: "reply", reply } };
  }
  const spec = parseDraftedSpec(modelOutput);
  return spec.ok ? { ok: true, value: { kind: "spec", ...spec.value } } : spec;
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
  const assumptions = readTextList(value.assumptions);
  if (nonGoals === null) return { ok: false, reason: "drafted spec non_goals must be a list of strings" };
  if (acceptance === null) return { ok: false, reason: "drafted spec acceptance must be a list of strings" };
  if (openQuestions === null) {
    return { ok: false, reason: "drafted spec open_questions must be a list of strings" };
  }
  if (assumptions === null) {
    return { ok: false, reason: "drafted spec assumptions must be a list of strings" };
  }
  if (acceptance.length === 0) {
    return { ok: false, reason: "drafted spec must state at least one acceptance check" };
  }
  const alternatives = readAlternatives(value.alternatives);
  if (alternatives === null) {
    return { ok: false, reason: "drafted alternatives must each have a title and tradeoffs" };
  }
  const critique = value.self_critique;
  const weakest = isRecord(critique) ? readText(critique.weakest_point) : null;
  const change = isRecord(critique) ? readText(critique.cut_or_change) : null;
  if (weakest === null || change === null) {
    return { ok: false, reason: "drafted spec must include a self-critique" };
  }
  return {
    ok: true,
    value: {
      title,
      goal,
      non_goals: nonGoals,
      acceptance,
      open_questions: openQuestions,
      assumptions,
      alternatives,
      self_critique: { weakest_point: weakest, cut_or_change: change }
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAlternatives(value: unknown): DraftedAlternative[] | null {
  if (!Array.isArray(value)) return null;
  const items: DraftedAlternative[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const title = readText(entry.title);
    const tradeoffs = readTextList(entry.tradeoffs);
    if (title === null || tradeoffs === null || tradeoffs.length === 0) return null;
    items.push({ title, tradeoffs });
  }
  return items;
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
