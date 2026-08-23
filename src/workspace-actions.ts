import { readFile } from "node:fs/promises";
import path from "node:path";
import { trackedMachineFiles, untrackMachineFiles } from "./project-sharing.js";
import { generateBestOfN } from "./best-of-n.js";
import { adoptVerifiedSet, reviewVerifiedSetAdoption } from "./adoption.js";
import { isAutonomyLevel } from "./autonomy-level.js";
import { setProjectAutonomyLevel } from "./autonomy.js";
import { callDaemonIfConfigured } from "./daemon-client.js";
import { generateCharacterizationCandidate } from "./characterization-generator.js";
import { generateDraftRefine } from "./draft-refine.js";
import { recordHumanGuidance } from "./human-guidance.js";
import { approvePendingManagerAction, cancelManagerRun, continueAutonomousManagerLoop, retryBlockedManagerAction, startWorkspaceManagerSession } from "./manager.js";
import { authorizeManualTask, prepareWorkspaceTentativePlan, queuePlanAmendment, ratifyPreparedWorkspacePlan, reviewManualTaskForAuthorization, reviewPlanForRatification } from "./plan.js";
import { cancelQualityRun } from "./quality-control.js";
import { reverifyQueuedPatchSet } from "./reverify.js";
import { readCheckOutput } from "./check-output.js";
import { addAccount, selectAccount } from "./provider-accounts.js";
import { listProjectFiles, readProjectFile } from "./project-files.js";
import { findGitRoot } from "./repo.js";
import { readEvents } from "./events.js";
import { requestTaskRedirect } from "./supervision.js";
import { requestTaskStop } from "./task-control.js";
import { inspectWorkspace } from "./workspace-inspection.js";

import { resumeTask } from "./task-resume.js";
import { draftSpecFromPrompt } from "./spec-draft-action.js";
import { adapterRoleNames, isAdapterRoleName } from "./agent-catalogue.js";
import { discoverProviderModels } from "./model-discovery.js";
import {
  connectAdapter,
  connectDiscoveredAdapter,
  initProjectForDesktop,
  inspectProjectConfig,
  inspectProviderAccounts,
  invalidateVerificationForHarness,
  startProviderAuthentication,
  setProjectConfig
} from "./config-actions.js";
import { inspectProviderAuthentication } from "./provider-auth-status.js";
import { adoptSpec, readSpecForReview } from "./spec-review.js";

export const workspaceActionTypes = [
  "autonomy.set",
  "manager.start",
  "manager.continue",
  "manager.retry_blocked",
  "guidance.record",
  "plan.prepare",
  "plan.review",
  "plan.ratify",
  "spec.draft",
  "spec.review",
  "spec.adopt",
  "manual_task.review",
  "manual_task.authorize",
  "plan.amend",
  "manager.approve_pending",
  "task.redirect",
  "task.stop",
  "task.resume",
  "run.stop",
  "status.inspect",
  "trail.inspect",
  "change.inspect",
  "verify.characterize",
  "quality.best_of_n",
  "quality.draft_refine",
  "quality.cancel",
  "memory.review_handoff",
  "verification.rerun",
  "adoption.review",
  "adoption.execute",
  /* The settings surface. `config.inspect` is read-only; `config.set` accepts a
     fixed key list and cannot reach a gate; `project.init` sets a folder up;
     `adapter.connect` writes a profile only after a probe has confirmed the
     capabilities it claims. `provider.auth.start` launches one fixed CLI-owned
     sign-in flow and receives no credential. `provider.auth.inspect` asks only
     the CLI's own no-cost status command and returns a tri-state. `models.discover`
     asks those CLIs for a no-cost list; `adapter.connect_model` repeats that
     check before a listed slug can reach a paid capability probe. */
  "config.inspect",
  "config.set",
  "project.init",
  "provider.auth.inspect",
  "provider.auth.start",
  "models.discover",
  "adapter.connect",
  "adapter.connect_model",
  /* The file tree and the file viewer. Read-only, confined to the resolved
     project root, and refusing `.hivemind/` and `.git/` outright -- see
     src/project-files.ts for why a reader is still an authorization surface. */
  "files.list",
  "files.read",
  /* What the project's checks printed. Read-only, and the thing an embedded
     terminal was actually being asked for -- see src/check-output.ts. */
  "checks.inspect",
  /* Which account each provider runs as. Hivemind never holds a credential:
     an account is a directory the harness itself owns, and selecting one sets
     a single allowlisted variable -- see src/provider-accounts.ts. */
  "accounts.inspect",
  "accounts.add",
  "accounts.select",
  /* What of this project's machine evidence is still tracked by git, and
     stopping it. A read and a narrow index-only write; neither can reach a
     gate, and the untrack stages a removal rather than committing one. */
  "sharing.inspect",
  "sharing.untrack"
] as const;

export type WorkspaceActionType = (typeof workspaceActionTypes)[number];
type ActionResult = { ok: true; value: unknown } | { ok: false; reason: string };

export async function executeWorkspaceAction(repoRoot: string, raw: unknown): Promise<ActionResult> {
  if (!isRecord(raw) || typeof raw.type !== "string" || !workspaceActionTypes.includes(raw.type as WorkspaceActionType)) {
    return { ok: false, reason: "workspace action must have a supported typed action" };
  }
  const authorityFields = ["approved", "approval", "human", "force", "tier", "verdict", "gate_passed", "authorized"];
  const claimed = Object.keys(raw).find((key) => authorityFields.includes(key));
  if (claimed !== undefined) return { ok: false, reason: `workspace action cannot supply authority field: ${claimed}` };
  const payload = raw.payload;
  if (!isRecord(payload)) return { ok: false, reason: "workspace action payload must be an object" };

  if (raw.type === "autonomy.set") {
    const parsed = exactStrings(payload, ["level"]);
    return parsed.ok && isAutonomyLevel(parsed.value.level)
      ? setProjectAutonomyLevel(repoRoot, parsed.value.level)
      : { ok: false, reason: parsed.ok ? "autonomy level must be auto, review_plan, or review_everything" : parsed.reason };
  }
  if (raw.type === "guidance.record") return recordHumanGuidance(repoRoot, payload);
  if (raw.type === "plan.prepare") {
    const parsed = exactStrings(payload, ["prompt", "tool"]);
    return parsed.ok ? prepareWorkspaceTentativePlan(repoRoot, parsed.value.prompt, parsed.value.tool) : parsed;
  }
  if (raw.type === "plan.review") {
    const parsed = exactStrings(payload, ["spec_id"]);
    return parsed.ok ? reviewPlanForRatification(repoRoot, parsed.value.spec_id) : parsed;
  }
  /* Drafts a spec from a prompt and signs only the orchestrator's half. */
  if (raw.type === "spec.draft") {
    const parsed = exactStrings(payload, ["prompt", "tool"]);
    return parsed.ok ? draftSpecFromPrompt(repoRoot, parsed.value.prompt, parsed.value.tool) : parsed;
  }
  if (raw.type === "spec.review") {
    const parsed = exactStrings(payload, ["spec_id"]);
    return parsed.ok ? readSpecForReview(repoRoot, parsed.value.spec_id) : parsed;
  }
  /* The human signature. The orchestrator cannot propose this action, and
     `markIdeationConvergence` refuses a user signature without an authorization
     regardless of who calls it -- see src/spec-convergence.ts. */
  if (raw.type === "spec.adopt") {
    const nonGoals = payload.non_goals;
    const parsed = exactStrings({ spec_id: payload.spec_id }, ["spec_id"]);
    if (!parsed.ok) return parsed;
    const allowed = new Set(["spec_id", "non_goals", "nothing_to_decline"]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      return { ok: false, reason: "workspace action payload contains an unsupported field" };
    }
    if (!Array.isArray(nonGoals) || !nonGoals.every((entry) => typeof entry === "string")) {
      return { ok: false, reason: "spec.adopt requires non_goals as a list of strings" };
    }
    if (payload.nothing_to_decline !== undefined && typeof payload.nothing_to_decline !== "boolean") {
      return { ok: false, reason: "nothing_to_decline must be a boolean when present" };
    }
    /* "There is nothing to decline" is an answer to the question, so it travels
       as its own field rather than as a magic string in the list. */
    return adoptSpec(
      repoRoot,
      parsed.value.spec_id,
      nonGoals as string[],
      payload.nothing_to_decline === true
    );
  }
  /* Continue a run that stopped for capacity, reusing the contract, lease and
     worktree that survived the pause. Refuses if any of them went stale. */
  if (raw.type === "task.resume") {
    const parsed = exactStrings(payload, ["task_id"]);
    return parsed.ok ? resumeTask(repoRoot, parsed.value.task_id) : parsed;
  }
  if (raw.type === "plan.ratify") {
    const parsed = exactStrings(payload, ["spec_id", "expected_plan_hash"]);
    return parsed.ok ? ratifyPreparedWorkspacePlan(repoRoot, parsed.value.spec_id, parsed.value.expected_plan_hash) : parsed;
  }
  if (raw.type === "manual_task.review") {
    const parsed = exactStrings(payload, ["spec_id", "task_id"]);
    return parsed.ok ? reviewManualTaskForAuthorization(repoRoot, parsed.value.spec_id, parsed.value.task_id) : parsed;
  }
  if (raw.type === "manual_task.authorize") {
    const parsed = exactStrings(payload, ["spec_id", "task_id", "expected_contract_hash"]);
    return parsed.ok
      ? authorizeManualTask(repoRoot, parsed.value.spec_id, parsed.value.task_id, parsed.value.expected_contract_hash)
      : parsed;
  }
  if (raw.type === "plan.amend") {
    if (typeof payload.spec_id !== "string" || !isRecord(payload.amendment) || Object.keys(payload).some((key) => key !== "spec_id" && key !== "amendment")) {
      return { ok: false, reason: "plan.amend requires only spec_id and amendment" };
    }
    return queuePlanAmendment(repoRoot, payload.spec_id, payload.amendment);
  }
  if (raw.type === "manager.approve_pending") return approvePendingManagerAction(repoRoot, payload);
  if (raw.type === "task.redirect") {
    const parsed = exactStrings(payload, ["task_id", "correction"]);
    return parsed.ok
      ? requestTaskRedirect(repoRoot, { task_id: parsed.value.task_id, correction: parsed.value.correction, source: "human" })
      : parsed;
  }
  if (raw.type === "task.stop") return requestTaskStop(repoRoot, payload);
  if (raw.type === "run.stop") return cancelManagerRun(repoRoot, payload);
  if (raw.type === "quality.cancel") return cancelQualityRun(repoRoot, payload);
  if (raw.type === "status.inspect") {
    if (Object.keys(payload).length > 0) return { ok: false, reason: "status.inspect takes no fields" };
    return inspectWorkspace(repoRoot);
  }
  if (raw.type === "trail.inspect") {
    if (Object.keys(payload).length > 0) return { ok: false, reason: "trail.inspect takes no fields" };
    return readEvents(repoRoot);
  }
  if (raw.type === "change.inspect") {
    const parsed = exactStrings(payload, ["task_id"]);
    if (!parsed.ok) return parsed;
    try {
      return { ok: true, value: { task_id: parsed.value.task_id, diff: await readFile(path.join(repoRoot, ".hivemind", "patches", parsed.value.task_id, "diff.patch"), "utf8") } };
    } catch {
      return { ok: false, reason: `change not found for ${parsed.value.task_id}` };
    }
  }
  /* `path` is optional on a listing and means the project root, so a tree can
     open without knowing anything. It is required on a read: there is no
     sensible default file, and defaulting one would be a surprise. */
  if (raw.type === "files.list") {
    const parsed = exactStrings(payload, ["path"], ["path"]);
    return parsed.ok ? listProjectFiles(repoRoot, parsed.value.path ?? ".") : parsed;
  }
  if (raw.type === "files.read") {
    const parsed = exactStrings(payload, ["path"]);
    return parsed.ok ? readProjectFile(repoRoot, parsed.value.path) : parsed;
  }
  /* No payload: the question a person has is "why did THIS fail", and the
     answer is the most recent recorded run. Naming one would make the caller
     carry an identifier it has no other use for, and every caller would find
     the latest anyway. */
  if (raw.type === "checks.inspect") {
    if (Object.keys(payload).length > 0) {
      return { ok: false, reason: "checks.inspect takes no fields; Core serves the most recent run" };
    }
    return latestCheckOutput(repoRoot);
  }
  if (raw.type === "sharing.inspect") {
    if (Object.keys(payload).length > 0) {
      return { ok: false, reason: "sharing.inspect takes no fields" };
    }
    return { ok: true, value: { tracked: await trackedMachineFiles(repoRoot) } };
  }
  if (raw.type === "sharing.untrack") {
    if (Object.keys(payload).length > 0) {
      return { ok: false, reason: "sharing.untrack takes no fields" };
    }
    const result = await untrackMachineFiles(repoRoot);
    /* Staged, not committed. The commit is the person's to make, and the files
       stay on disk because they are live state this project is using. */
    return result.ok ? { ok: true, value: { removed: result.removed } } : result;
  }
  if (raw.type === "accounts.inspect") {
    if (Object.keys(payload).length > 0) {
      return { ok: false, reason: "accounts.inspect takes no fields" };
    }
    return inspectProviderAccounts(repoRoot);
  }
  if (raw.type === "accounts.add") {
    const parsed = exactStrings(payload, ["label", "harness", "home_dir"]);
    if (!parsed.ok) return parsed;
    const added = await addAccount(repoRoot, {
      label: parsed.value.label,
      harness: parsed.value.harness,
      home_dir: parsed.value.home_dir
    });
    return added.ok ? inspectProviderAccounts(repoRoot) : added;
  }
  if (raw.type === "accounts.select") {
    const parsed = exactStrings(payload, ["account_id"]);
    if (!parsed.ok) return parsed;
    const selected = await selectAccount(repoRoot, parsed.value.account_id);
    if (!selected.ok) return selected;
    /* The switch invalidates the capability verification for that role.
       A probe result is evidence about the tool, the profile AND the account
       it ran under: a different plan can change which models can be pinned and
       whether usage is reported at all. Carrying the verification across would
       assert something nobody measured. */
    if (selected.value.invalidated) {
      /* Every role running on that harness, not just one: the verification
         belonged to the account, and they all just changed account. */
      await invalidateVerificationForHarness(repoRoot, selected.value.account.harness, "account_changed");
    }
    return inspectProviderAccounts(repoRoot);
  }
  if (raw.type === "manager.start") {
    const parsed = exactStrings(payload, ["message", "tool"]);
    return parsed.ok ? startWorkspaceManagerSession(repoRoot, parsed.value.message, parsed.value.tool) : parsed;
  }
  if (raw.type === "manager.continue") {
    const parsed = parseManagerContinue(payload);
    return parsed.ok
      ? continueAutonomousManagerLoop(repoRoot, parsed.value.session_id, {
          tool: parsed.value.tool,
          maxSteps: parsed.value.max_steps
        })
      : parsed;
  }
  if (raw.type === "manager.retry_blocked") {
    const parsed = exactStrings(payload, ["session_id"]);
    return parsed.ok ? retryBlockedManagerAction(repoRoot, parsed.value.session_id) : parsed;
  }
  if (raw.type === "verify.characterize") {
    const parsed = exactStrings(payload, ["task_id", "tool", "check_id"], ["check_id"]);
    return parsed.ok ? generateCharacterizationCandidate(repoRoot, parsed.value.task_id, parsed.value.tool, parsed.value.check_id) : parsed;
  }
  if (raw.type === "quality.best_of_n") return generateBestOfN(repoRoot, payload);
  if (raw.type === "quality.draft_refine") return generateDraftRefine(repoRoot, payload);
  if (raw.type === "memory.review_handoff") {
    const parsed = exactStrings(payload, ["proposal_id"]);
    return parsed.ok
      ? { ok: true, value: { proposal_id: parsed.value.proposal_id, command: `hivemind memory review ${parsed.value.proposal_id} --approve`, local_interactive_tty_required: true, promotion_performed: false } }
      : parsed;
  }
  if (raw.type === "verification.rerun") {
    return Object.keys(payload).length === 0
      ? reverifyQueuedPatchSet(repoRoot)
      : { ok: false, reason: "verification.rerun takes no fields; Core derives the queued patch set" };
  }
  if (raw.type === "adoption.review") {
    const parsed = exactStrings(payload, ["verification_id"]);
    return parsed.ok ? reviewVerifiedSetAdoption(repoRoot, parsed.value.verification_id) : parsed;
  }
  if (raw.type === "adoption.execute") {
    const parsed = exactStrings(payload, ["pending_adoption_id", "verification_id", "expected_base_head", "expected_state_hash"]);
    return parsed.ok ? adoptVerifiedSet(repoRoot, {
      pending_adoption_id: parsed.value.pending_adoption_id,
      verification_id: parsed.value.verification_id,
      expected_base_head: parsed.value.expected_base_head,
      expected_state_hash: parsed.value.expected_state_hash
    }) : parsed;
  }
  if (raw.type === "config.inspect") {
    if (Object.keys(payload).length > 0) return { ok: false, reason: "config.inspect takes no fields" };
    return inspectProjectConfig(repoRoot);
  }
  if (raw.type === "config.set") return setProjectConfig(repoRoot, payload);
  if (raw.type === "project.init") {
    if (Object.keys(payload).length > 0) return { ok: false, reason: "project.init takes no fields" };
    return initProjectForDesktop(repoRoot);
  }
  if (raw.type === "provider.auth.start") {
    /* `inner_provider_id` preselects which provider a MULTIPLIER harness logs
       into. It is validated against the sanction registry inside Core —
       prohibited refuses by name, unknown refuses as unknown — and composes
       only a fixed `-p <registry id>`; it can never carry an argument. */
    const parsed = exactStrings(payload, ["provider_id", "inner_provider_id"], ["inner_provider_id"]);
    return parsed.ok
      ? startProviderAuthentication(repoRoot, parsed.value.provider_id, {
          innerProviderId: parsed.value.inner_provider_id
        })
      : parsed;
  }
  if (raw.type === "provider.auth.inspect") {
    return Object.keys(payload).length === 0
      ? { ok: true, value: await inspectProviderAuthentication(repoRoot) }
      : { ok: false, reason: "provider.auth.inspect takes no fields" };
  }
  if (raw.type === "models.discover") {
    if (Object.keys(payload).length > 0) return { ok: false, reason: "models.discover takes no fields" };
    return { ok: true, value: await discoverProviderModels(repoRoot) };
  }
  if (raw.type === "adapter.connect") {
    const parsed = exactStrings(payload, ["role", "agent_id"]);
    if (!parsed.ok) return parsed;
    if (!isAdapterRoleName(parsed.value.role)) {
      return { ok: false, reason: `role must be one of ${adapterRoleNames.join(", ")}` };
    }
    return connectAdapter(repoRoot, parsed.value.role, parsed.value.agent_id);
  }
  if (raw.type === "adapter.connect_model") {
    const parsed = exactStrings(payload, ["role", "provider_id", "model_slug"]);
    if (!parsed.ok) return parsed;
    if (!isAdapterRoleName(parsed.value.role)) {
      return { ok: false, reason: `role must be one of ${adapterRoleNames.join(", ")}` };
    }
    return connectDiscoveredAdapter(
      repoRoot,
      parsed.value.role,
      parsed.value.provider_id,
      parsed.value.model_slug
    );
  }
  return { ok: false, reason: "unsupported workspace action" };
}

/**
 * The most recently recorded check output, found through the trail.
 *
 * The trail is the index: the `checks_run_id` lives on `verification.completed`
 * (and on `quality.draft_verified`), so nothing here scans a directory to guess
 * which run was last. A directory listing sorted by name would answer a
 * different question, and answer it wrong the moment a run is retried.
 */
async function latestCheckOutput(repoRoot: string): Promise<ActionResult> {
  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const recorded = [...events.value]
    .reverse()
    .find(
      (event) =>
        (event.type === "verification.completed" || event.type === "quality.draft_verified") &&
        typeof event.data.checks_run_id === "string"
    );
  if (recorded === undefined) {
    return {
      ok: false,
      reason: "no checks have been run and recorded in this project yet"
    };
  }
  const output = await readCheckOutput(repoRoot, String(recorded.data.checks_run_id));
  if (!output.ok) return output;
  return {
    ok: true,
    value: {
      ...output.value,
      ran_at: recorded.ts,
      task_ids: Array.isArray(recorded.data.task_ids) ? recorded.data.task_ids : [],
      tests: typeof recorded.data.tests === "string" ? recorded.data.tests : null,
      /* What the result was standing on. Null for a run recorded before
         provenance existed, which is a different fact from "nothing to say"
         and the surface says so. */
      provenance: isRecord(recorded.data.provenance) ? recorded.data.provenance : null
    }
  };
}

function parseManagerContinue(
  value: Record<string, unknown>
): { ok: true; value: { session_id: string; tool: string; max_steps: number } } | { ok: false; reason: string } {
  if (Object.keys(value).some((key) => !["session_id", "tool", "max_steps"].includes(key))) {
    return { ok: false, reason: "manager.continue payload contains an unsupported field" };
  }
  if (typeof value.session_id !== "string" || value.session_id.trim() === "") {
    return { ok: false, reason: "session_id must be a non-empty string" };
  }
  if (typeof value.tool !== "string" || value.tool.trim() === "") {
    return { ok: false, reason: "tool must be a non-empty string" };
  }
  if (!Number.isSafeInteger(value.max_steps) || Number(value.max_steps) < 1 || Number(value.max_steps) > 100) {
    return { ok: false, reason: "max_steps must be an integer between 1 and 100" };
  }
  return { ok: true, value: { session_id: value.session_id, tool: value.tool, max_steps: Number(value.max_steps) } };
}

export async function workspaceActionCommand(cwd: string, args: string[]): Promise<number> {
  if (args.length !== 1) {
    console.error("error: usage: hivemind workspace <typed-action-json-file>");
    return 1;
  }
  const repoRoot = await findGitRoot(cwd);
  if (repoRoot === null) {
    console.error("error: not a git repository");
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.resolve(cwd, args[0]), "utf8"));
  } catch {
    console.error("error: workspace action file must contain valid JSON");
    return 1;
  }
  const daemon = await callDaemonIfConfigured<unknown>(repoRoot, "/workspace/action", raw as Record<string, unknown>);
  const result = daemon.routed ? daemon : await executeWorkspaceAction(repoRoot, raw);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

function exactStrings(
  value: Record<string, unknown>,
  fields: string[],
  optional: string[] = []
): { ok: true; value: Record<string, string> } | { ok: false; reason: string } {
  if (Object.keys(value).some((key) => !fields.includes(key))) return { ok: false, reason: "workspace action payload contains an unsupported field" };
  const output: Record<string, string> = {};
  for (const field of fields) {
    if (value[field] === undefined && optional.includes(field)) continue;
    if (typeof value[field] !== "string" || value[field].trim() === "") return { ok: false, reason: `${field} must be a non-empty string` };
    output[field] = value[field];
  }
  return { ok: true, value: output };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
