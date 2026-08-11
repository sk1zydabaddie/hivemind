import { writeFileAtomic } from "./atomic.js";
import { markIdeationConvergence } from "./ideation.js";
import { ratifySpec } from "./spec.js";
import { requestUserConvergence } from "./spec-convergence.js";
import {
  loadSpecDocument,
  openQuestionsEmpty,
  replaceSectionBody,
  sectionBody,
  specAuthorship,
  specFilePath,
  specForm,
  type SpecResult
} from "./spec-format.js";

/**
 * What the one review shows, and what it does.
 *
 * The person makes one decision, but it carries two signatures: the spec is
 * adopted and then the plan is ratified, because `ratifyPlan` requires a
 * ratified spec. That is ordering, not a second decision.
 *
 * The important part is non-goals. A drafted non-goal is a constraint nobody
 * wrote, and the drafting experiment showed the drafter leaves the tempting
 * adjacent scope undeclared on exactly the prompts where it matters. So drafted
 * entries are a suggestion and the person is asked the question directly. The
 * answer they give is what gets written.
 */

export interface SpecReview {
  spec_id: string;
  title: string;
  /** `drafted` means a model wrote this and the person is adopting it. */
  authorship: "human" | "drafted";
  status: "draft" | "ratified";
  goal: string;
  /** Prefilled suggestions. An empty list is a normal, honest state. */
  drafted_non_goals: string[];
  acceptance: string[];
  /** Non-empty means ratification is refused until these are answered. */
  open_questions: string[];
  /** Choices the drafter made because the request did not say. */
  assumptions: string[];
  /** What the person typed, verbatim, when this spec was drafted from a prompt. */
  asked_for: string | null;
}

function bullets(body: string | null): string[] {
  if (body === null) return [];
  return body
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[-*]\s*/u, "").trim())
    .filter((line) => line !== "");
}

/** Read the spec for presentation. Never mutates. */
export async function readSpecForReview(repoRoot: string, specId: string): Promise<SpecResult<SpecReview>> {
  const spec = await loadSpecDocument(repoRoot, specId);
  if (!spec.ok) return spec;
  const markdown = spec.value.markdown;
  const form = specForm(markdown);
  const goalSection = form === "short" ? "Goal" : "Problem / goal";
  return {
    ok: true,
    value: {
      spec_id: specId,
      title: spec.value.title,
      authorship: specAuthorship(markdown),
      status: spec.value.status,
      goal: (sectionBody(markdown, goalSection) ?? "").trim(),
      drafted_non_goals: bullets(sectionBody(markdown, "Non-goals")),
      acceptance: bullets(sectionBody(markdown, "Acceptance criteria")),
      open_questions: bullets(sectionBody(markdown, "Open questions")),
      assumptions: bullets(sectionBody(markdown, "Assumptions")),
      asked_for: (sectionBody(markdown, "What was asked for") ?? "").trim() || null
    }
  };
}

/**
 * Adopt the spec: write the person's non-goals, sign, and ratify.
 *
 * The authorization is taken out against the document *after* their answer is
 * written, because that is the document they are adopting. Issuing it against
 * the drafted text and signing the edited one would sign something nobody read.
 */
export async function adoptSpec(
  repoRoot: string,
  specId: string,
  nonGoals: string[],
  nothingToDecline = false
): Promise<SpecResult<{ spec_id: string; non_goals: string[]; status: "ratified" }>> {
  const spec = await loadSpecDocument(repoRoot, specId);
  if (!spec.ok) return spec;

  /* Open questions block, and the refusal has to say which ones so a person can
     act on it rather than be stopped by a rule they cannot see. */
  if (!openQuestionsEmpty(spec.value.markdown)) {
    const questions = bullets(sectionBody(spec.value.markdown, "Open questions"));
    return {
      ok: false,
      reason: `This cannot start until these are answered: ${questions.join(" / ")}`
    };
  }

  /* "There is nothing to decline" is an answer, not an empty field. The gate is
     collecting a person's judgement about scope, and "I considered it and there
     is nothing" is a judgement. It has to be said explicitly -- it is never a
     default and is never prefilled -- but once said it satisfies the section. */
  const cleaned = nonGoals.map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (cleaned.length === 0 && !nothingToDecline) {
    return {
      ok: false,
      reason: "Say what this should not do before starting, or say there is nothing to decline."
    };
  }
  if (cleaned.length === 0) {
    cleaned.push("Nothing to decline. This was asked and answered before the work started.");
  }

  const written = replaceSectionBody(
    spec.value.markdown,
    "Non-goals",
    cleaned.map((entry) => `- ${entry}`).join("\n")
  );
  if (!written.ok) return written;
  await writeFileAtomic(specFilePath(repoRoot, specId), written.value);

  const authorization = await requestUserConvergence(repoRoot, specId, "desktop-review");
  if (!authorization.ok) return authorization;
  const converged = await markIdeationConvergence(repoRoot, specId, "user", authorization.value);
  if (!converged.ok) return converged;

  const ratified = await ratifySpec(repoRoot, specId);
  if (!ratified.ok) return ratified;
  return { ok: true, value: { spec_id: specId, non_goals: cleaned, status: "ratified" } };
}
