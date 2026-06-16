import { stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "./atomic.js";
import { readJsonFile } from "./json.js";
import { findGitRoot } from "./repo.js";
import {
  activeSpecPath,
  buildSpecTemplate,
  isNodeError,
  loadSpecDocument,
  nonGoalsPresent,
  openQuestionsEmpty,
  replaceSectionBody,
  requiredSections,
  specFilePath,
  type SpecResult,
  type SpecSection,
  validateRequestedSpecId,
  validateSpecDocument
} from "./spec-format.js";

type IdeationStatus = "diverging" | "refining" | "awaiting_user_convergence" | "ratifiable";
type ConvergenceParty = "user" | "orchestrator";

interface IdeationAlternative {
  title: string;
  tradeoffs: string[];
}

interface IdeationSelfCritique {
  weakest_point: string;
  cut_or_change: string;
}

interface IdeationRoundInput {
  alternatives?: IdeationAlternative[];
  self_critique?: IdeationSelfCritique;
  spec_updates?: Partial<Record<SpecSection, string>>;
  substantive_change?: boolean;
  orchestrator_calls_convergence?: boolean;
}

interface IdeationRound {
  index: number;
  alternatives: IdeationAlternative[];
  self_critique: IdeationSelfCritique;
  substantive_change: boolean;
  orchestrator_calls_convergence: boolean;
}

interface IdeationState {
  version: 1;
  spec_id: string;
  goal: string;
  status: IdeationStatus;
  rounds: IdeationRound[];
  divergence_complete: boolean;
  convergence: Record<ConvergenceParty, boolean>;
  consecutive_non_substantive_rounds: number;
  diminishing_returns_signal: boolean;
}

const diminishingReturnsThreshold = 2;

export async function ideationCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseIdeationArgs(cwd, args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const action = parsed.value;
  const result =
    action.action === "start"
      ? await startIdeationSession(repoRoot, action.specId, action.title, action.goal)
      : action.action === "round"
        ? await recordIdeationRound(repoRoot, action.specId, await readRoundInput(action.roundPath))
        : action.action === "converge"
          ? await markIdeationConvergence(repoRoot, action.specId, action.party)
          : await getIdeationStatus(repoRoot, action.specId);

  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

export async function startIdeationSession(
  repoRoot: string,
  specId: string,
  title: string,
  goal: string
): Promise<SpecResult<IdeationState>> {
  const specIdResult = validateRequestedSpecId(specId);
  if (!specIdResult.ok) {
    return specIdResult;
  }
  if (title.trim() === "") {
    return { ok: false, reason: "spec title must not be empty" };
  }
  if (goal.trim() === "") {
    return { ok: false, reason: "ideation goal must not be empty" };
  }
  if (await exists(ideationPath(repoRoot, specId))) {
    return { ok: false, reason: `ideation session already exists: .hivemind/spec/${specId}.ideation.json` };
  }

  const existingSpec = await loadSpecDocument(repoRoot, specId);
  let markdown: string;
  if (existingSpec.ok) {
    if (existingSpec.value.status !== "draft") {
      return { ok: false, reason: "ideation can only start for a draft spec" };
    }
    const problems = validateSpecDocument(existingSpec.value);
    if (problems.length > 0) {
      return { ok: false, reason: problems.join("; ") };
    }
    markdown = existingSpec.value.markdown;
  } else if (existingSpec.reason.startsWith("spec not found:")) {
    markdown = buildSpecTemplate(title.trim());
  } else {
    return existingSpec;
  }

  const withGoal = replaceSectionBody(markdown, "Problem / goal", goal.trim());
  if (!withGoal.ok) {
    return withGoal;
  }
  await writeFileAtomic(specFilePath(repoRoot, specId), withGoal.value);
  await writeJsonAtomic(activeSpecPath(repoRoot), { version: 1, spec_id: specId });

  const state: IdeationState = {
    version: 1,
    spec_id: specId,
    goal: goal.trim(),
    status: "diverging",
    rounds: [],
    divergence_complete: false,
    convergence: { user: false, orchestrator: false },
    consecutive_non_substantive_rounds: 0,
    diminishing_returns_signal: false
  };
  await writeIdeationState(repoRoot, specId, state);
  return { ok: true, value: state };
}

export async function recordIdeationRound(
  repoRoot: string,
  specId: string,
  input: unknown
): Promise<SpecResult<IdeationState>> {
  const loaded = await loadIdeationState(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }

  const parsed = parseRoundInput(input, loaded.value.rounds.length === 0);
  if (!parsed.ok) {
    return parsed;
  }
  if (loaded.value.diminishing_returns_signal && !parsed.value.substantive_change) {
    return {
      ok: false,
      reason: "diminishing returns signal has fired; converge or submit a substantive round before continuing"
    };
  }

  let spec = await loadSpecDocument(repoRoot, specId);
  if (!spec.ok) {
    return spec;
  }
  let markdown = spec.value.markdown;
  for (const [section, body] of Object.entries(parsed.value.spec_updates ?? {}) as Array<[SpecSection, string]>) {
    const updated = replaceSectionBody(markdown, section, body);
    if (!updated.ok) {
      return updated;
    }
    markdown = updated.value;
  }
  if (markdown !== spec.value.markdown) {
    await writeFileAtomic(specFilePath(repoRoot, specId), markdown);
    spec = await loadSpecDocument(repoRoot, specId);
    if (!spec.ok) {
      return spec;
    }
  }

  const state = loaded.value;
  const round: IdeationRound = {
    index: state.rounds.length + 1,
    alternatives: parsed.value.alternatives ?? [],
    self_critique: parsed.value.self_critique,
    substantive_change: parsed.value.substantive_change,
    orchestrator_calls_convergence: parsed.value.orchestrator_calls_convergence ?? false
  };
  state.rounds.push(round);
  state.divergence_complete = state.divergence_complete || round.alternatives.length >= 2;
  state.consecutive_non_substantive_rounds = round.substantive_change ? 0 : state.consecutive_non_substantive_rounds + 1;
  if (round.substantive_change) {
    state.diminishing_returns_signal = false;
  }
  if (round.orchestrator_calls_convergence || state.consecutive_non_substantive_rounds >= diminishingReturnsThreshold) {
    state.convergence.orchestrator = true;
    state.diminishing_returns_signal = state.consecutive_non_substantive_rounds >= diminishingReturnsThreshold;
  }
  state.status = deriveStatus(state, spec.value.markdown);
  await writeIdeationState(repoRoot, specId, state);
  return { ok: true, value: state };
}

export async function markIdeationConvergence(
  repoRoot: string,
  specId: string,
  party: ConvergenceParty
): Promise<SpecResult<IdeationState>> {
  const loaded = await loadIdeationState(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }
  const spec = await loadSpecDocument(repoRoot, specId);
  if (!spec.ok) {
    return spec;
  }
  loaded.value.convergence[party] = true;
  loaded.value.status = deriveStatus(loaded.value, spec.value.markdown);
  await writeIdeationState(repoRoot, specId, loaded.value);
  return { ok: true, value: loaded.value };
}

export async function getIdeationStatus(repoRoot: string, specId: string): Promise<SpecResult<IdeationState>> {
  return loadIdeationState(repoRoot, specId);
}

export async function checkIdeationRatifiable(repoRoot: string, specId: string, markdown: string): Promise<SpecResult<null>> {
  const loaded = await loadIdeationState(repoRoot, specId);
  if (!loaded.ok) {
    return loaded;
  }
  const problems: string[] = [];
  if (!loaded.value.divergence_complete) {
    problems.push("ideation must include at least two alternatives with tradeoffs");
  }
  if (loaded.value.rounds.length === 0) {
    problems.push("ideation must include at least one self-critique round");
  }
  if (!loaded.value.rounds.every((round) => critiqueComplete(round.self_critique))) {
    problems.push("each ideation round must include self-critique");
  }
  if (!loaded.value.convergence.orchestrator) {
    problems.push("orchestrator convergence sign-off is required before ratification");
  }
  if (!loaded.value.convergence.user) {
    problems.push("user convergence sign-off is required before ratification");
  }
  if (!nonGoalsPresent(markdown)) {
    problems.push("Non-goals must be filled before ratification");
  }
  if (!openQuestionsEmpty(markdown)) {
    problems.push("Open questions must be empty before ratification");
  }
  return problems.length === 0 ? { ok: true, value: null } : { ok: false, reason: problems.join("; ") };
}

function parseIdeationArgs(
  cwd: string,
  args: string[]
): SpecResult<
  | { action: "start"; specId: string; title: string; goal: string }
  | { action: "round"; specId: string; roundPath: string }
  | { action: "converge"; specId: string; party: ConvergenceParty }
  | { action: "status"; specId: string }
> {
  const [specId, flag, ...rest] = args;
  if (!specId) {
    return { ok: false, reason: ideationUsage() };
  }
  if (flag === "--start") {
    const titleIndex = rest.indexOf("--title");
    const goalIndex = rest.indexOf("--goal");
    const title = titleIndex >= 0 ? rest[titleIndex + 1] : undefined;
    const goal = goalIndex >= 0 ? rest[goalIndex + 1] : undefined;
    if (title && goal && rest.length === 4) {
      return { ok: true, value: { action: "start", specId, title, goal } };
    }
  }
  if (flag === "--round" && typeof rest[0] === "string" && rest.length === 1) {
    return { ok: true, value: { action: "round", specId, roundPath: path.resolve(cwd, rest[0]) } };
  }
  if (flag === "--converge" && rest[0] === "--by" && (rest[1] === "user" || rest[1] === "orchestrator") && rest.length === 2) {
    return { ok: true, value: { action: "converge", specId, party: rest[1] } };
  }
  if (flag === "--status" && rest.length === 0) {
    return { ok: true, value: { action: "status", specId } };
  }
  return { ok: false, reason: ideationUsage() };
}

function ideationUsage(): string {
  return [
    "usage: hivemind ideate <id> --start --title <title> --goal <goal>",
    "   or: hivemind ideate <id> --round <round-json-file>",
    "   or: hivemind ideate <id> --converge --by user|orchestrator",
    "   or: hivemind ideate <id> --status"
  ].join("\n");
}

async function readRoundInput(roundPath: string): Promise<unknown> {
  return readJsonFile(roundPath);
}

function parseRoundInput(input: unknown, firstRound: boolean): SpecResult<Required<Pick<IdeationRoundInput, "self_critique" | "substantive_change">> & IdeationRoundInput> {
  if (!isRecord(input)) {
    return { ok: false, reason: "ideation round must be a JSON object" };
  }

  const selfCritique = parseSelfCritique(input.self_critique);
  if (!selfCritique.ok) {
    return selfCritique;
  }
  if (typeof input.substantive_change !== "boolean") {
    return { ok: false, reason: "ideation round substantive_change must be a boolean" };
  }

  const alternatives = input.alternatives === undefined ? undefined : parseAlternatives(input.alternatives);
  if (alternatives && !alternatives.ok) {
    return alternatives;
  }
  if (firstRound && (!alternatives || alternatives.value.length < 2)) {
    return { ok: false, reason: "first ideation round must include at least two alternatives" };
  }

  const updates = input.spec_updates === undefined ? undefined : parseSpecUpdates(input.spec_updates);
  if (updates && !updates.ok) {
    return updates;
  }
  if (input.orchestrator_calls_convergence !== undefined && typeof input.orchestrator_calls_convergence !== "boolean") {
    return { ok: false, reason: "orchestrator_calls_convergence must be a boolean when present" };
  }

  return {
    ok: true,
    value: {
      alternatives: alternatives?.value,
      self_critique: selfCritique.value,
      spec_updates: updates?.value,
      substantive_change: input.substantive_change,
      orchestrator_calls_convergence: input.orchestrator_calls_convergence === true
    }
  };
}

function parseAlternatives(value: unknown): SpecResult<IdeationAlternative[]> {
  if (!Array.isArray(value)) {
    return { ok: false, reason: "alternatives must be an array" };
  }
  const alternatives: IdeationAlternative[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.title !== "string" || item.title.trim() === "") {
      return { ok: false, reason: "each alternative must include a non-empty title" };
    }
    if (!Array.isArray(item.tradeoffs) || item.tradeoffs.length === 0 || !item.tradeoffs.every((tradeoff) => typeof tradeoff === "string" && tradeoff.trim() !== "")) {
      return { ok: false, reason: "each alternative must include non-empty tradeoffs" };
    }
    alternatives.push({ title: item.title.trim(), tradeoffs: item.tradeoffs.map((tradeoff) => tradeoff.trim()) });
  }
  return { ok: true, value: alternatives };
}

function parseSelfCritique(value: unknown): SpecResult<IdeationSelfCritique> {
  if (!isRecord(value)) {
    return { ok: false, reason: "self_critique is required for every ideation round" };
  }
  if (typeof value.weakest_point !== "string" || value.weakest_point.trim() === "") {
    return { ok: false, reason: "self_critique.weakest_point must be a non-empty string" };
  }
  if (typeof value.cut_or_change !== "string" || value.cut_or_change.trim() === "") {
    return { ok: false, reason: "self_critique.cut_or_change must be a non-empty string" };
  }
  return { ok: true, value: { weakest_point: value.weakest_point.trim(), cut_or_change: value.cut_or_change.trim() } };
}

function parseSpecUpdates(value: unknown): SpecResult<Partial<Record<SpecSection, string>>> {
  if (!isRecord(value)) {
    return { ok: false, reason: "spec_updates must be a JSON object" };
  }

  const updates: Partial<Record<SpecSection, string>> = {};
  for (const [section, body] of Object.entries(value)) {
    if (!isSpecSection(section)) {
      return { ok: false, reason: `unknown spec_updates section: ${section}` };
    }
    if (typeof body !== "string") {
      return { ok: false, reason: `spec_updates.${section} must be a string` };
    }
    updates[section] = body;
  }
  return { ok: true, value: updates };
}

async function loadIdeationState(repoRoot: string, specId: string): Promise<SpecResult<IdeationState>> {
  const specIdResult = validateRequestedSpecId(specId);
  if (!specIdResult.ok) {
    return specIdResult;
  }

  let raw: unknown;
  try {
    raw = await readJsonFile(ideationPath(repoRoot, specId));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `ideation session not found: .hivemind/spec/${specId}.ideation.json` };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in .hivemind/spec/${specId}.ideation.json` };
    }
    throw error;
  }
  return parseIdeationState(raw, specId);
}

function parseIdeationState(value: unknown, specId: string): SpecResult<IdeationState> {
  if (!isRecord(value)) {
    return { ok: false, reason: "ideation state must be a JSON object" };
  }
  if (value.version !== 1) {
    return { ok: false, reason: "ideation state version must be 1" };
  }
  if (value.spec_id !== specId) {
    return { ok: false, reason: `ideation state spec_id must be ${specId}` };
  }
  if (typeof value.goal !== "string" || value.goal.trim() === "") {
    return { ok: false, reason: "ideation state goal must be a non-empty string" };
  }
  if (!isIdeationStatus(value.status)) {
    return { ok: false, reason: "ideation state status is invalid" };
  }
  if (!Array.isArray(value.rounds)) {
    return { ok: false, reason: "ideation state rounds must be an array" };
  }
  if (!isRecord(value.convergence) || typeof value.convergence.user !== "boolean" || typeof value.convergence.orchestrator !== "boolean") {
    return { ok: false, reason: "ideation convergence must contain user and orchestrator booleans" };
  }
  if (typeof value.divergence_complete !== "boolean") {
    return { ok: false, reason: "ideation divergence_complete must be a boolean" };
  }
  if (typeof value.consecutive_non_substantive_rounds !== "number" || !Number.isInteger(value.consecutive_non_substantive_rounds) || value.consecutive_non_substantive_rounds < 0) {
    return { ok: false, reason: "ideation consecutive_non_substantive_rounds must be a non-negative integer" };
  }
  if (typeof value.diminishing_returns_signal !== "boolean") {
    return { ok: false, reason: "ideation diminishing_returns_signal must be a boolean" };
  }

  return {
    ok: true,
    value: {
      version: 1,
      spec_id: specId,
      goal: value.goal,
      status: value.status,
      rounds: value.rounds as IdeationRound[],
      divergence_complete: value.divergence_complete,
      convergence: { user: value.convergence.user, orchestrator: value.convergence.orchestrator },
      consecutive_non_substantive_rounds: value.consecutive_non_substantive_rounds,
      diminishing_returns_signal: value.diminishing_returns_signal
    }
  };
}

function deriveStatus(state: IdeationState, markdown: string): IdeationStatus {
  if (state.convergence.user && state.convergence.orchestrator && state.divergence_complete && nonGoalsPresent(markdown) && openQuestionsEmpty(markdown)) {
    return "ratifiable";
  }
  if (state.convergence.user || state.convergence.orchestrator) {
    return "awaiting_user_convergence";
  }
  return state.divergence_complete ? "refining" : "diverging";
}

async function writeIdeationState(repoRoot: string, specId: string, state: IdeationState): Promise<void> {
  await writeJsonAtomic(ideationPath(repoRoot, specId), state);
}

function ideationPath(repoRoot: string, specId: string): string {
  return path.join(repoRoot, ".hivemind", "spec", `${specId}.ideation.json`);
}

function critiqueComplete(value: IdeationSelfCritique): boolean {
  return value.weakest_point.trim() !== "" && value.cut_or_change.trim() !== "";
}

function isSpecSection(value: string): value is SpecSection {
  return (requiredSections as readonly string[]).includes(value);
}

function isIdeationStatus(value: unknown): value is IdeationStatus {
  return value === "diverging" || value === "refining" || value === "awaiting_user_convergence" || value === "ratifiable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
