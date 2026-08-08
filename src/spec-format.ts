import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FailureCode } from "./failure-code.js";
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

export type SpecSection = (typeof requiredSections)[number];

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
      return { ok: false, reason: `spec not found: .hivemind/spec/${specId}.md` };
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

  for (const section of requiredSections) {
    if (!hasSection(document.markdown, section)) {
      problems.push(`spec is missing required section: ${section}`);
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

export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
