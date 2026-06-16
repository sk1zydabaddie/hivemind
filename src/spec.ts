import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "./atomic.js";
import { readJsonFile } from "./json.js";
import { findGitRoot } from "./repo.js";
import { validateTaskId } from "./task-id.js";

export type SpecStatus = "draft" | "ratified";

export interface SpecSummary {
  spec_id: string;
  spec_path: string;
  title: string;
  status: SpecStatus;
  active: boolean;
  sections: Record<string, boolean>;
  open_questions_empty: boolean;
}

export interface SpecRatificationResult {
  spec_id: string;
  spec_path: string;
  status: SpecStatus;
  active: boolean;
}

const requiredSections = [
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

type SpecResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function specCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseSpecArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result =
    parsed.value.action === "create"
      ? await createSpec(repoRoot, parsed.value.specId, parsed.value.title)
      : parsed.value.action === "validate"
        ? await validateSpecForCommand(repoRoot, parsed.value.specId)
        : await ratifySpec(repoRoot, parsed.value.specId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function planCommand(cwd: string, args: string[]): Promise<number> {
  const [specId, flag, ...rest] = args;
  if (!specId || flag !== "--check" || rest.length > 0) {
    console.error("error: usage: hivemind plan <spec-id> --check");
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await checkPlanningAllowed(repoRoot, specId);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function createSpec(repoRoot: string, specId: string, title: string): Promise<SpecResult<SpecSummary>> {
  const specIdResult = validateRequestedSpecId(specId);
  if (!specIdResult.ok) {
    return specIdResult;
  }
  if (title.trim() === "") {
    return { ok: false, reason: "spec title must not be empty" };
  }

  const specPath = specFilePath(repoRoot, specId);
  if (await exists(specPath)) {
    return { ok: false, reason: `spec already exists: .hivemind/spec/${specId}.md` };
  }

  await writeFileAtomic(specPath, buildSpecTemplate(title.trim()));
  await writeActiveSpec(repoRoot, specId);
  return loadSpecSummary(repoRoot, specId);
}

export async function ratifySpec(repoRoot: string, specId: string): Promise<SpecResult<SpecRatificationResult>> {
  const loaded = await loadSpecDocument(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }

  const problems = validateSpecDocument(loaded.value);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }
  if (!openQuestionsEmpty(loaded.value.markdown)) {
    return { ok: false, reason: "Open questions must be empty before ratification" };
  }

  const nextMarkdown = loaded.value.markdown.replace(/^status:\s*(draft|ratified)\s*$/m, "status: ratified");
  await writeFileAtomic(specFilePath(repoRoot, specId), nextMarkdown.endsWith("\n") ? nextMarkdown : `${nextMarkdown}\n`);
  await writeActiveSpec(repoRoot, specId);
  return {
    ok: true,
    value: {
      spec_id: specId,
      spec_path: `.hivemind/spec/${specId}.md`,
      status: "ratified",
      active: true
    }
  };
}

export async function requireActiveSpecRatified(repoRoot: string): Promise<SpecResult<{ spec_id: string; status: "ratified" }>> {
  const active = await readActiveSpec(repoRoot);
  if (!active.ok) {
    return active;
  }

  const loaded = await loadSpecDocument(repoRoot, active.value.spec_id);
  if (!loaded.ok) {
    return loaded;
  }

  const problems = validateSpecDocument(loaded.value);
  if (problems.length > 0) {
    return { ok: false, reason: `active spec ${active.value.spec_id} is invalid: ${problems.join("; ")}` };
  }
  if (loaded.value.status !== "ratified") {
    return { ok: false, reason: `active spec ${active.value.spec_id} is ${loaded.value.status}; ratify it before planning, leasing, or running workers` };
  }

  return { ok: true, value: { spec_id: active.value.spec_id, status: "ratified" } };
}

export async function checkPlanningAllowed(
  repoRoot: string,
  specId: string
): Promise<SpecResult<{ spec_id: string; status: "ratified"; planning: "allowed" }>> {
  const specIdResult = validateRequestedSpecId(specId);
  if (!specIdResult.ok) {
    return specIdResult;
  }

  const active = await readActiveSpec(repoRoot);
  if (!active.ok) {
    return active;
  }
  if (active.value.spec_id !== specId) {
    return { ok: false, reason: `spec ${specId} is not active; active spec is ${active.value.spec_id}` };
  }

  const ratified = await requireActiveSpecRatified(repoRoot);
  if (!ratified.ok) {
    return ratified;
  }

  return { ok: true, value: { spec_id: specId, status: "ratified", planning: "allowed" } };
}

function parseSpecArgs(
  args: string[]
): SpecResult<{ action: "create"; specId: string; title: string } | { action: "validate" | "ratify"; specId: string }> {
  const [specId, actionFlag, ...rest] = args;
  if (!specId) {
    return { ok: false, reason: specUsage() };
  }

  if (actionFlag === "--validate" && rest.length === 0) {
    return { ok: true, value: { action: "validate", specId } };
  }
  if (actionFlag === "--ratify" && rest.length === 0) {
    return { ok: true, value: { action: "ratify", specId } };
  }
  if (actionFlag === "--create" && rest[0] === "--title" && typeof rest[1] === "string" && rest.length === 2) {
    return { ok: true, value: { action: "create", specId, title: rest[1] } };
  }
  return { ok: false, reason: specUsage() };
}

function specUsage(): string {
  return "usage: hivemind spec <id> --create --title <title> | --validate | --ratify";
}

async function validateSpecForCommand(repoRoot: string, specId: string): Promise<SpecResult<SpecSummary>> {
  const loaded = await loadSpecDocument(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }
  const problems = validateSpecDocument(loaded.value);
  if (problems.length > 0) {
    return { ok: false, reason: problems.join("; ") };
  }

  const summary = await loadSpecSummary(repoRoot, specId);
  if (!summary.ok) {
    return summary;
  }
  return summary;
}

async function loadSpecSummary(repoRoot: string, specId: string): Promise<SpecResult<SpecSummary>> {
  const loaded = await loadSpecDocument(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }

  const active = await readActiveSpec(repoRoot);
  const activeSpecId = active.ok ? active.value.spec_id : null;
  return {
    ok: true,
    value: {
      spec_id: specId,
      spec_path: `.hivemind/spec/${specId}.md`,
      title: loaded.value.title,
      status: loaded.value.status,
      active: activeSpecId === specId,
      sections: Object.fromEntries(requiredSections.map((section) => [section, hasSection(loaded.value.markdown, section)])),
      open_questions_empty: openQuestionsEmpty(loaded.value.markdown)
    }
  };
}

async function loadSpecDocument(
  repoRoot: string,
  specId: string
): Promise<SpecResult<{ markdown: string; title: string; status: SpecStatus }>> {
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

function validateSpecDocument(document: { markdown: string; title: string }): string[] {
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

function buildSpecTemplate(title: string): string {
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

async function readActiveSpec(repoRoot: string): Promise<SpecResult<{ spec_id: string }>> {
  let raw: unknown;
  try {
    raw = await readJsonFile(activeSpecPath(repoRoot));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: "no active spec; create and ratify a spec before planning, leasing, or running workers" };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/spec/active.json" };
    }
    throw error;
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: "active spec file must be a JSON object" };
  }
  if (raw.version !== 1) {
    return { ok: false, reason: "active spec file version must be 1" };
  }
  if (typeof raw.spec_id !== "string") {
    return { ok: false, reason: "active spec file spec_id must be a string" };
  }
  const specIdResult = validateRequestedSpecId(raw.spec_id);
  if (!specIdResult.ok) {
    return specIdResult;
  }
  return { ok: true, value: { spec_id: raw.spec_id } };
}

async function writeActiveSpec(repoRoot: string, specId: string): Promise<void> {
  await writeJsonAtomic(activeSpecPath(repoRoot), { version: 1, spec_id: specId });
}

function validateRequestedSpecId(specId: string): SpecResult<null> {
  const problem = validateTaskId(specId);
  return problem === null ? { ok: true, value: null } : { ok: false, reason: `invalid spec id "${specId}": ${problem}` };
}

function hasSection(markdown: string, section: string): boolean {
  return sectionBody(markdown, section) !== null;
}

function openQuestionsEmpty(markdown: string): boolean {
  const body = sectionBody(markdown, "Open questions");
  return body !== null && body.trim() === "";
}

function sectionBody(markdown: string, section: string): string | null {
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

function specFilePath(repoRoot: string, specId: string): string {
  return path.join(repoRoot, ".hivemind", "spec", `${specId}.md`);
}

function activeSpecPath(repoRoot: string): string {
  return path.join(repoRoot, ".hivemind", "spec", "active.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}
