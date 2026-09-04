import { isNodeError } from "./error-detail.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { codedFailure, type FailureCode } from "./failure-code.js";
import { validateTaskId } from "./task-id.js";

export type SpecStatus = "draft" | "ratified";

export interface LoadedSpecDocument {
  markdown: string;
  title: string;
  status: SpecStatus;
}

/**
 * `code` is how a caller asks which failure this is. Branching on `reason` is
 * a bug: rewording a sentence would change behaviour. Optional because most
 * failures are only ever read by a person and need no code; absence means no
 * caller distinguishes it, and must be treated as no match rather than as a
 * wildcard. See src/failure-code.ts.
 */
export type SpecResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; code?: FailureCode };

export const requiredSections = [
  "Problem / goal",
  "Context",
  "Users / stakeholders",
  "In scope",
  "Non-goals",
  "Constraints",
  "Acceptance criteria",
  "Risks / unknowns",
  "Open questions"
] as const;

/**
 * The short form.
 *
 * Nothing parses the long form's nine sections: the markdown is handed to the
 * planner whole, and scope and conformance derive from the plan rather than
 * from the spec. Only two sections are checked for content anywhere -- Non-goals
 * must say something and Open questions must say nothing -- and both are here.
 *
 * So this is not a relaxation of the gate. It is the same gate over a document
 * that states its intent without nine headings, which is what a first run
 * actually has. The long form stays supported for deliberate work; it simply
 * stops being the only shape a spec may take.
 */
export const shortFormSections = [
  "Goal",
  "Non-goals",
  "Acceptance criteria",
  "Open questions"
] as const;

export type SpecSection = (typeof requiredSections)[number] | (typeof shortFormSections)[number];

export type SpecForm = "long" | "short";

/** Which shape this document is, or null when it is neither. */
export function specForm(markdown: string): SpecForm | null {
  if (requiredSections.every((section) => hasSection(markdown, section))) return "long";
  if (shortFormSections.every((section) => hasSection(markdown, section))) return "short";
  return null;
}

/**
 * Who wrote this document.
 *
 * `drafted` means a model produced it from a prompt and a person adopted it;
 * `human` means a person wrote it. Recorded on the artifact because the
 * constraints in a spec -- the non-goals especially -- bind the work, and a
 * project should never be silent about where its own constraints came from.
 * Absent means `human`: every spec written before this existed was.
 */
export type SpecAuthorship = "human" | "drafted";

export function specAuthorship(markdown: string): SpecAuthorship {
  return /^authored:\s*drafted\s*$/mu.test(markdown) ? "drafted" : "human";
}

export async function loadSpecDocument(repoRoot: string, specId: string): Promise<SpecResult<LoadedSpecDocument>> {
  const specIdResult = validateRequestedSpecId(specId);
  if (!specIdResult.ok) {
    return specIdResult;
  }

  let markdown: string;
  try {
    markdown = await readFile(specFilePath(repoRoot, specId), "utf8");
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return codedFailure("spec_not_found", `spec not found: .hivemind/spec/${specId}.md`);
    }
    throw error;
  }

  const titleMatch = /^# Spec:\s*(.+?)\s*$/m.exec(markdown);
  const statusMatch = /^status:\s*(\S+)\s*$/m.exec(markdown);
  const status = statusMatch?.[1];
  return {
    ok: true,
    value: {
      markdown,
      title: titleMatch?.[1] ?? "",
      status: status === "draft" || status === "ratified" ? status : "draft"
    }
  };
}

export function validateSpecDocument(document: { markdown: string; title: string }): string[] {
  const problems: string[] = [];
  if (document.title.trim() === "") {
    problems.push("spec title is required");
  }

  const statusMatches = [...document.markdown.matchAll(/^status:\s*(\S+)\s*$/gm)];
  if (statusMatches.length !== 1) {
    problems.push("spec must contain exactly one status line");
  } else {
    const status = statusMatches[0][1];
    if (status !== "draft" && status !== "ratified") {
      problems.push("spec status must be draft or ratified");
    }
  }

  /* Either shape is valid. Reported against whichever the document is closer
     to, so the message names the sections actually missing rather than nine
     that were never intended. */
  if (specForm(document.markdown) === null) {
    const longMissing = requiredSections.filter((section) => !hasSection(document.markdown, section));
    const shortMissing = shortFormSections.filter((section) => !hasSection(document.markdown, section));
    const missing = shortMissing.length <= longMissing.length ? shortMissing : longMissing;
    const shape = shortMissing.length <= longMissing.length ? "short-form" : "long-form";
    for (const section of missing) {
      problems.push(`${shape} spec is missing required section: ${section}`);
    }
  }
  return problems;
}

export function buildSpecTemplate(title: string): string {
  return [
    `# Spec: ${title}`,
    "status: draft",
    "",
    "## Problem / goal",
    "",
    "## Context",
    "",
    "## Users / stakeholders",
    "",
    "## In scope",
    "",
    "## Non-goals",
    "",
    "## Constraints",
    "",
    "## Acceptance criteria",
    "",
    "## Risks / unknowns",
    "",
    "## Open questions",
    ""
  ].join("\n");
}

/**
 * A short-form spec drafted from a prompt.
 *
 * The prompt is recorded verbatim beside the sections drawn from it, so the
 * document can always be read back against what was actually asked for. A
 * drafted spec that cannot be compared to its prompt is the same defect as a
 * durable event that cannot rebuild its own state.
 */
export function buildDraftedSpec(input: {
  title: string;
  prompt: string;
  goal: string;
  nonGoals: string[];
  acceptance: string[];
  openQuestions: string[];
  assumptions?: string[];
}): string {
  const bullets = (items: string[]): string[] =>
    items.length === 0 ? [""] : items.map((item) => `- ${item.trim()}`);
  return [
    `# Spec: ${input.title}`,
    "status: draft",
    "authored: drafted",
    "",
    "## Goal",
    "",
    input.goal.trim(),
    "",
    "## Non-goals",
    "",
    ...bullets(input.nonGoals),
    "",
    "## Acceptance criteria",
    "",
    ...bullets(input.acceptance),
    "",
    "## Assumptions",
    "",
    ...bullets(input.assumptions ?? []),
    "",
    "## Open questions",
    "",
    ...bullets(input.openQuestions),
    "",
    "## What was asked for",
    "",
    input.prompt.trim(),
    ""
  ].join("\n").replace(/\n{3,}/gu, "\n\n");
}

export function validateRequestedSpecId(specId: string): SpecResult<null> {
  const problem = validateTaskId(specId);
  return problem === null ? { ok: true, value: null } : { ok: false, reason: `invalid spec id "${specId}": ${problem}` };
}

export function hasSection(markdown: string, section: string): boolean {
  return sectionBody(markdown, section) !== null;
}

export function openQuestionsEmpty(markdown: string): boolean {
  const body = sectionBody(markdown, "Open questions");
  return body !== null && body.trim() === "";
}

export function nonGoalsPresent(markdown: string): boolean {
  const body = sectionBody(markdown, "Non-goals");
  return body !== null && body.trim() !== "";
}

export function sectionBody(markdown: string, section: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const heading = `## ${section}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return null;
  }

  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      break;
    }
    body.push(lines[index]);
  }
  return body.join("\n");
}

export function replaceSectionBody(markdown: string, section: SpecSection, body: string): SpecResult<string> {
  const lines = markdown.split(/\r?\n/);
  const heading = `## ${section}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return { ok: false, reason: `spec is missing required section: ${section}` };
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }

  const nextBody = body.trim() === "" ? [""] : ["", ...body.trim().split(/\r?\n/), ""];
  const nextLines = [...lines.slice(0, start + 1), ...nextBody, ...lines.slice(end)];
  return { ok: true, value: `${nextLines.join("\n").replace(/\n+$/u, "")}\n` };
}

export function specFilePath(repoRoot: string, specId: string): string {
  return path.join(repoRoot, ".hivemind", "spec", `${specId}.md`);
}

export function activeSpecPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "spec", "active.json");
}
