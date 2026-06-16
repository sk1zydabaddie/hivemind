import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeTask } from "./analyze.js";
import { writeJsonAtomic } from "./atomic.js";
import { createTaskContract, type CreateTaskContractResult } from "./contract.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { enqueueIntegrationPatch, integrateShadow, type EnqueueIntegrationPatchResult, type IntegrationStatus } from "./integrate.js";
import { requestLeaseForContract, type LeaseGrantResult } from "./lease.js";
import { findGitRoot } from "./repo.js";
import { runTask, type RunResult } from "./run.js";
import { requireActiveSpecRatified, type SpecResult } from "./spec.js";
import { loadSpecDocument } from "./spec-format.js";
import { getStatus, type HivemindStatus } from "./status.js";
import { submitTask, type SubmitResult } from "./submit.js";
import { createTaskWorktree, type WorktreeResult } from "./worktree.js";

interface ManagerSession {
  version: 1;
  session_id: string;
  created_at: string;
  spec_id: string;
  working_set: ManagerWorkingSet;
  turns: ManagerTurn[];
  proposed_action: ManagerProposedAction;
  executed_actions: ManagerExecutedAction[];
}

interface ManagerWorkingSet {
  spec: {
    spec_id: string;
    title: string;
    status: "ratified";
    path: string;
  };
  status: {
    task_count: number;
    active_lease_count: number;
    integration_queue_count: number;
    integrated_task_count: number;
  };
}

interface ManagerTurn {
  role: "user" | "manager";
  content: string;
}

interface ManagerProposedAction {
  type: "await_planning_loop";
  reason: string;
  requires: "M5.4";
}

interface ManagerExecutedAction {
  id: string;
  ts: string;
  type: ManagerAction["type"];
  result: ManagerActionExecutionRecord;
}

type ManagerActionExecutionRecord =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

type ManagerAction =
  | { type: "await_planning_loop" }
  | { type: "get_status" }
  | { type: "create_task_contract"; contract: Record<string, unknown> }
  | { type: "request_lease"; task_id: string }
  | { type: "create_worktree"; task_id: string }
  | { type: "run_worker"; task_id: string; tool?: string; allow_dangerous_adapter?: boolean }
  | { type: "submit_patch"; task_id: string }
  | { type: "analyze_patch"; task_id: string }
  | { type: "enqueue_patch"; task_id: string }
  | { type: "integrate_shadow" };

export interface ManagerSessionResult {
  session_id: string;
  session_path: string;
  spec_id: string;
  proposed_action: ManagerProposedAction;
}

export interface ManagerActionResult {
  session_id: string;
  session_path: string;
  action_type: ManagerAction["type"];
  result: ManagerActionExecutionRecord;
}

export interface ManagerLoopResult {
  session_id: string;
  session_path: string;
  status: "passed" | "failed";
  steps: Array<{
    index: number;
    action_type: ManagerAction["type"];
    result: ManagerActionExecutionRecord;
  }>;
  final_status: HivemindStatus;
}

export async function managerCommand(cwd: string, args: string[]): Promise<number> {
  const parsed = parseManagerArgs(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.reason}`);
    return 1;
  }

  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    console.error("error: not a git repository");
    return 1;
  }

  const result = await runParsedManagerCommand(repoRoot, parsed.value);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }

  console.log(JSON.stringify(result.value, null, 2));
  if ("result" in result.value && !result.value.result.ok) {
    return 1;
  }
  if ("status" in result.value && result.value.status === "failed") {
    return 1;
  }
  return 0;
}

async function runParsedManagerCommand(
  repoRoot: string,
  parsed:
    | { mode: "message"; message: string }
    | { mode: "action"; sessionId: string; actionFile: string }
    | { mode: "fake-loop"; message: string; actionsFile: string }
): Promise<SpecResult<ManagerSessionResult | ManagerActionResult | ManagerLoopResult>> {
  if (parsed.mode === "message") {
    return startManagerSession(repoRoot, parsed.message);
  }
  if (parsed.mode === "action") {
    return executeManagerActionFromFile(repoRoot, parsed.sessionId, parsed.actionFile);
  }
  return runNoPaidManagerLoopFromFile(repoRoot, parsed.message, parsed.actionsFile);
}

export async function startManagerSession(repoRoot: string, message: string): Promise<SpecResult<ManagerSessionResult>> {
  if (message.trim() === "") {
    return { ok: false, reason: "manager message must not be empty" };
  }

  const spec = await requireActiveSpecRatified(repoRoot);
  if (!spec.ok) {
    return spec;
  }

  const loadedSpec = await loadSpecDocument(repoRoot, spec.value.spec_id);
  if (!loadedSpec.ok) {
    return loadedSpec;
  }
  if (loadedSpec.value.status !== "ratified") {
    return { ok: false, reason: `active spec ${spec.value.spec_id} is ${loadedSpec.value.status}; ratify it before starting manager chat` };
  }

  const status = await getStatus(repoRoot);
  if (!status.ok) {
    return status;
  }

  const proposedAction: ManagerProposedAction = {
    type: "await_planning_loop",
    reason: "M5.4 planning loop must produce tentative tasks before manager action execution can continue",
    requires: "M5.4"
  };
  const sessionId = randomUUID();
  const session: ManagerSession = {
    version: 1,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    spec_id: spec.value.spec_id,
    working_set: {
      spec: {
        spec_id: spec.value.spec_id,
        title: loadedSpec.value.title,
        status: "ratified",
        path: `.hivemind/spec/${spec.value.spec_id}.md`
      },
      status: {
        task_count: status.value.tasks.length,
        active_lease_count: Object.keys(status.value.leases).length,
        integration_queue_count: status.value.integration.queue.length,
        integrated_task_count: status.value.tasks.filter((task) => task.integrated).length
      }
    },
    turns: [
      { role: "user", content: message.trim() },
      { role: "manager", content: proposedAction.reason }
    ],
    proposed_action: proposedAction,
    executed_actions: []
  };

  const relativePath = `.hivemind/orchestrator/sessions/${sessionId}.json`;
  await writeJsonAtomic(path.join(repoRoot, relativePath), session);
  return {
    ok: true,
    value: {
      session_id: sessionId,
      session_path: relativePath,
      spec_id: spec.value.spec_id,
      proposed_action: proposedAction
    }
  };
}

export async function executeManagerActionFromFile(
  repoRoot: string,
  sessionId: string,
  actionFile: string
): Promise<SpecResult<ManagerActionResult>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(actionFile, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "manager action file must contain valid JSON" };
    }
    throw error;
  }

  const action = parseManagerAction(raw);
  if (!action.ok) {
    return action;
  }
  return executeManagerAction(repoRoot, sessionId, action.value);
}

export async function runNoPaidManagerLoopFromFile(
  repoRoot: string,
  message: string,
  actionsFile: string
): Promise<SpecResult<ManagerLoopResult>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(actionsFile, "utf8"));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: "fake-manager action file must contain valid JSON" };
    }
    throw error;
  }

  const actions = parseManagerActionList(raw);
  if (!actions.ok) {
    return actions;
  }
  return runNoPaidManagerLoop(repoRoot, message, actions.value);
}

export async function runNoPaidManagerLoop(
  repoRoot: string,
  message: string,
  actions: ManagerAction[]
): Promise<SpecResult<ManagerLoopResult>> {
  const session = await startManagerSession(repoRoot, message);
  if (!session.ok) {
    return session;
  }

  const steps: ManagerLoopResult["steps"] = [];
  for (const [index, action] of actions.entries()) {
    const result = await executeManagerAction(repoRoot, session.value.session_id, action);
    if (!result.ok) {
      return result;
    }
    steps.push({
      index,
      action_type: result.value.action_type,
      result: result.value.result
    });
    if (!result.value.result.ok) {
      const status = await getStatus(repoRoot);
      return status.ok
        ? {
            ok: true,
            value: {
              session_id: session.value.session_id,
              session_path: session.value.session_path,
              status: "failed",
              steps,
              final_status: status.value
            }
          }
        : status;
    }
  }

  const status = await getStatus(repoRoot);
  if (!status.ok) {
    return status;
  }
  return {
    ok: true,
    value: {
      session_id: session.value.session_id,
      session_path: session.value.session_path,
      status: "passed",
      steps,
      final_status: status.value
    }
  };
}

export async function executeManagerAction(
  repoRoot: string,
  sessionId: string,
  action: ManagerAction
): Promise<SpecResult<ManagerActionResult>> {
  const sessionResult = await loadManagerSession(repoRoot, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const specResult = await requireActiveSpecRatified(repoRoot);
  if (!specResult.ok) {
    return specResult;
  }
  if (specResult.value.spec_id !== sessionResult.value.spec_id) {
    return { ok: false, reason: `manager session ${sessionId} belongs to spec ${sessionResult.value.spec_id}, not active spec ${specResult.value.spec_id}` };
  }

  const result = await executeDeterministicAction(repoRoot, action);
  const nextSession = appendActionToSession(sessionResult.value, action, result);
  const sessionPath = managerSessionPath(repoRoot, sessionId);
  await writeJsonAtomic(sessionPath, nextSession);
  return {
    ok: true,
    value: {
      session_id: sessionId,
      session_path: managerSessionRelativePath(sessionId),
      action_type: action.type,
      result
    }
  };
}

async function executeDeterministicAction(repoRoot: string, action: ManagerAction): Promise<ManagerActionExecutionRecord> {
  if (action.type === "await_planning_loop") {
    return {
      ok: false,
      reason: "M5.4 planning loop must produce tentative tasks before manager action execution can continue"
    };
  }
  if (action.type === "get_status") {
    return recordResult(await getStatus(repoRoot));
  }
  if (action.type === "create_task_contract") {
    return recordResult(await routeMutatingAction<CreateTaskContractResult>(repoRoot, "/contract/create", { contract: action.contract }, () => createTaskContract(repoRoot, action.contract)));
  }
  if (action.type === "request_lease") {
    return recordResult(await routeMutatingAction<LeaseGrantResult>(repoRoot, "/lease/request-contract", { task_id: action.task_id }, () => requestLeaseForContract(repoRoot, action.task_id)));
  }
  if (action.type === "create_worktree") {
    return recordResult(await routeMutatingAction<WorktreeResult>(repoRoot, "/worktree/create", { task_id: action.task_id }, () => createTaskWorktree(repoRoot, action.task_id)));
  }
  if (action.type === "run_worker") {
    return recordResult(
      await routeMutatingAction<RunResult>(
        repoRoot,
        "/run",
        { task_id: action.task_id, ...(action.tool === undefined ? {} : { tool: action.tool }), allow_dangerous_adapter: action.allow_dangerous_adapter === true },
        () => runTask(repoRoot, action.task_id, action.tool, { allowDangerousAdapter: action.allow_dangerous_adapter === true })
      )
    );
  }
  if (action.type === "submit_patch") {
    return recordResult(await routeMutatingAction<SubmitResult>(repoRoot, "/submit", { task_id: action.task_id }, () => submitTask(repoRoot, action.task_id)));
  }
  if (action.type === "analyze_patch") {
    return recordResult(await routeMutatingAction<unknown>(repoRoot, "/analyze", { task_id: action.task_id }, () => analyzeTask(repoRoot, action.task_id)));
  }
  if (action.type === "enqueue_patch") {
    return recordResult(
      await routeMutatingAction<EnqueueIntegrationPatchResult>(
        repoRoot,
        "/integration/enqueue",
        { task_id: action.task_id },
        () => enqueueIntegrationPatch(repoRoot, action.task_id)
      )
    );
  }
  return recordResult(await routeMutatingAction<IntegrationStatus>(repoRoot, "/integrate/shadow", {}, () => integrateShadow(repoRoot)));
}

async function routeMutatingAction<T>(
  repoRoot: string,
  endpoint: string,
  body: Record<string, unknown>,
  direct: () => Promise<{ ok: true; value: T } | { ok: false; reason: string }>
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const daemonResult = await callDaemonIfConfigured<T>(repoRoot, endpoint, body);
  return daemonResult.routed ? daemonResult : direct();
}

function recordResult<T>(result: { ok: true; value: T } | { ok: false; reason: string }): ManagerActionExecutionRecord {
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
}

function appendActionToSession(session: ManagerSession, action: ManagerAction, result: ManagerActionExecutionRecord): ManagerSession {
  const actionRecord: ManagerExecutedAction = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: action.type,
    result
  };
  return {
    ...session,
    turns: [
      ...session.turns,
      {
        role: "manager",
        content: result.ok ? `executed ${action.type}: ok` : `executed ${action.type}: ${result.reason}`
      }
    ],
    executed_actions: [...session.executed_actions, actionRecord]
  };
}

async function loadManagerSession(repoRoot: string, sessionId: string): Promise<SpecResult<ManagerSession>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    return { ok: false, reason: "manager session id must be a UUID" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(managerSessionPath(repoRoot, sessionId), "utf8"));
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, reason: `manager session not found: ${managerSessionRelativePath(sessionId)}` };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON in ${managerSessionRelativePath(sessionId)}` };
    }
    throw error;
  }

  return validateManagerSession(parsed, sessionId);
}

function validateManagerSession(value: unknown, sessionId: string): SpecResult<ManagerSession> {
  if (!isRecord(value)) {
    return { ok: false, reason: "manager session must be a JSON object" };
  }
  if (value.version !== 1) {
    return { ok: false, reason: "manager session version must be 1" };
  }
  if (value.session_id !== sessionId) {
    return { ok: false, reason: "manager session id does not match requested session" };
  }
  if (typeof value.spec_id !== "string" || value.spec_id.trim() === "") {
    return { ok: false, reason: "manager session spec_id must be a string" };
  }
  if (!Array.isArray(value.turns)) {
    return { ok: false, reason: "manager session turns must be an array" };
  }
  if (!Array.isArray(value.executed_actions)) {
    return { ok: false, reason: "manager session executed_actions must be an array" };
  }
  return { ok: true, value: value as unknown as ManagerSession };
}

function parseManagerAction(raw: unknown): SpecResult<ManagerAction> {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return { ok: false, reason: "manager action must be a JSON object with a string type" };
  }
  if (raw.type === "await_planning_loop" || raw.type === "get_status" || raw.type === "integrate_shadow") {
    return Object.keys(raw).length === 1 ? { ok: true, value: { type: raw.type } } : { ok: false, reason: `${raw.type} action must not include extra fields` };
  }
  if (raw.type === "create_task_contract") {
    return isRecord(raw.contract) && Object.keys(raw).length === 2
      ? { ok: true, value: { type: "create_task_contract", contract: raw.contract } }
      : { ok: false, reason: "create_task_contract action requires only a contract object" };
  }
  if (isTaskActionType(raw.type)) {
    if (typeof raw.task_id !== "string") {
      return { ok: false, reason: `${raw.type} action requires task_id` };
    }
    if (raw.type === "run_worker") {
      if (!validOptionalString(raw.tool) || (raw.allow_dangerous_adapter !== undefined && typeof raw.allow_dangerous_adapter !== "boolean")) {
        return { ok: false, reason: "run_worker action accepts task_id, optional tool, and optional allow_dangerous_adapter" };
      }
      const allowedKeys = new Set(["type", "task_id", "tool", "allow_dangerous_adapter"]);
      return Object.keys(raw).every((key) => allowedKeys.has(key))
        ? { ok: true, value: { type: "run_worker", task_id: raw.task_id, ...(raw.tool === undefined ? {} : { tool: raw.tool }), allow_dangerous_adapter: raw.allow_dangerous_adapter === true } }
        : { ok: false, reason: "run_worker action contains an unsupported field" };
    }
    return Object.keys(raw).length === 2
      ? { ok: true, value: { type: raw.type, task_id: raw.task_id } }
      : { ok: false, reason: `${raw.type} action contains an unsupported field` };
  }
  return { ok: false, reason: `unknown manager action type: ${raw.type}` };
}

function parseManagerActionList(raw: unknown): SpecResult<ManagerAction[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "fake-manager action file must contain a JSON array" };
  }
  const actions: ManagerAction[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseManagerAction(entry);
    if (!parsed.ok) {
      return { ok: false, reason: `fake-manager action[${index}]: ${parsed.reason}` };
    }
    actions.push(parsed.value);
  }
  return { ok: true, value: actions };
}

function isTaskActionType(value: string): value is "request_lease" | "create_worktree" | "run_worker" | "submit_patch" | "analyze_patch" | "enqueue_patch" {
  return value === "request_lease" || value === "create_worktree" || value === "run_worker" || value === "submit_patch" || value === "analyze_patch" || value === "enqueue_patch";
}

function validOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function managerSessionPath(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, managerSessionRelativePath(sessionId));
}

function managerSessionRelativePath(sessionId: string): string {
  return `.hivemind/orchestrator/sessions/${sessionId}.json`;
}

function parseManagerArgs(
  args: string[]
): SpecResult<{ mode: "message"; message: string } | { mode: "action"; sessionId: string; actionFile: string } | { mode: "fake-loop"; message: string; actionsFile: string }> {
  if (args[0] === "--message" && typeof args[1] === "string" && args.length === 2) {
    return { ok: true, value: { mode: "message", message: args[1] } };
  }
  if (args[0] === "--message" && typeof args[1] === "string" && args[2] === "--fake-manager" && typeof args[3] === "string" && args.length === 4) {
    return { ok: true, value: { mode: "fake-loop", message: args[1], actionsFile: args[3] } };
  }
  if (args[0] === "--session" && typeof args[1] === "string" && args[2] === "--action" && typeof args[3] === "string" && args.length === 4) {
    return { ok: true, value: { mode: "action", sessionId: args[1], actionFile: args[3] } };
  }
  return { ok: false, reason: "usage: hivemind manager --message <message> [--fake-manager <actions-json-file>] | --session <session_id> --action <action-json-file>" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
