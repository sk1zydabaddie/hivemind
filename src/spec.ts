import { isNodeError } from "./error-detail.js";
import { stat } from "node:fs/promises";
import { writeFileAtomic, writeJsonAtomic } from "./atomic.js";
import { checkIdeationRatifiable } from "./ideation.js";
import { isRecord, readJsonFile } from "./json.js";
import { findGitRoot } from "./repo.js";
import { checkFormatVersion, formatVersions } from "./format-version.js";
import { codedFailure } from "./failure-code.js";
import {
  activeSpecPath,
  buildSpecTemplate,
  hasSection,
  loadSpecDocument,
  nonGoalsPresent,
  openQuestionsEmpty,
  requiredSections,
  specFilePath,
  type SpecResult,
  type SpecStatus,
  validateRequestedSpecId,
  validateSpecDocument
} from "./spec-format.js";

export type { SpecResult, SpecStatus } from "./spec-format.js";

export interface SpecSummary {
  spec_id: string;
  spec_path: string;
  title: string;
  status: SpecStatus;
  active: boolean;
  sections: Record<string, boolean>;
  non_goals_present: boolean;
  open_questions_empty: boolean;
}

export interface SpecRatificationResult {
  spec_id: string;
  spec_path: string;
  status: SpecStatus;
  active: boolean;
}

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
  if (!nonGoalsPresent(loaded.value.markdown)) {
    return { ok: false, reason: "Non-goals must be filled before ratification" };
  }
  const ideation = await checkIdeationRatifiable(repoRoot, specId, loaded.value.markdown);
  if (!ideation.ok) {
    return ideation;
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
): Promise<SpecResult<{ spec_id: string; status: SpecStatus; planning: "allowed" }>> {
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

  /* Planning does not require ratification; running does.
   *
   * These were the same check, which forced a person to ratify a spec before
   * they could see what it would produce -- and made the first run demand a
   * document before it would show a plan. Planning reads the repository and
   * writes a tentative plan; it touches no code and starts no worker.
   *
   * Every gate that matters is unchanged: `requireActiveSpecRatified` still
   * guards contract creation, leases, workers, integration and checkpoints, so
   * nothing can RUN against an unratified spec. What moved is only the point at
   * which a person has to commit, from before they can look to before anything
   * happens. */
  const loaded = await loadSpecDocument(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }
  const problems = validateSpecDocument(loaded.value);
  if (problems.length > 0) {
    return { ok: false, reason: `active spec ${specId} is invalid: ${problems.join("; ")}` };
  }

  return { ok: true, value: { spec_id: specId, status: loaded.value.status, planning: "allowed" } };
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
      non_goals_present: nonGoalsPresent(loaded.value.markdown),
      open_questions_empty: openQuestionsEmpty(loaded.value.markdown)
    }
  };
}

export async function readActiveSpec(repoRoot: string): Promise<SpecResult<{ spec_id: string }>> {
  let raw: unknown;
  try {
    raw = await readJsonFile(activeSpecPath(repoRoot));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return codedFailure(
        "no_active_spec",
        "no active spec; create and ratify a spec before planning, leasing, or running workers"
      );
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "invalid JSON in .hivemind/spec/active.json" };
    }
    throw error;
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: "active spec file must be a JSON object" };
  }
  const gated = checkFormatVersion(raw, formatVersions.spec, "the active spec file");
  if (!gated.ok) {
    return { ok: false, reason: gated.reason };
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
