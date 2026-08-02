import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskContract } from "./contract.js";
import { readEvents, type HivemindEvent } from "./events.js";
import { loadCurrentRatifiedPlan, type TentativePlan } from "./plan.js";
import { requireActiveSpecRatified } from "./spec.js";
import { loadVerificationSet, verificationInputsStillMatch, type StoredVerificationSet } from "./verification-set.js";

const execFileAsync = promisify(execFile);

export interface TaskAuthoringBase {
  commit: string;
  tree: string;
  contract_base_commit: string;
  dependency_task_ids: string[];
  verification_id: string | null;
}

export interface CurrentVerifiedDependencySet {
  task_ids: string[];
  verification: StoredVerificationSet;
}

export async function resolveTaskAuthoringBase(
  repoRoot: string,
  contract: TaskContract
): Promise<{ ok: true; value: TaskAuthoringBase } | { ok: false; reason: string }> {
  const contractBase = await git(repoRoot, ["rev-parse", "--verify", `${contract.base_commit}^{commit}`]);
  if (!contractBase.ok) return { ok: false, reason: `task authoring base could not resolve contract base: ${contractBase.reason}` };
  const contractTree = await git(repoRoot, ["rev-parse", "--verify", `${contractBase.stdout}^{tree}`]);
  if (!contractTree.ok) return { ok: false, reason: `task authoring base could not resolve contract tree: ${contractTree.reason}` };

  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const hasAnyRatifiedPlan = events.value.some((event) => event.type === "plan.ratified");
  if (!hasAnyRatifiedPlan) {
    return {
      ok: true,
      value: {
        commit: contractBase.stdout,
        tree: contractTree.stdout,
        contract_base_commit: contractBase.stdout,
        dependency_task_ids: [],
        verification_id: null
      }
    };
  }
  const spec = await requireActiveSpecRatified(repoRoot);
  if (!spec.ok) return spec;
  const hasRatifiedPlan = events.value.some((event) => event.type === "plan.ratified" && event.data.spec_id === spec.value.spec_id);
  if (!hasRatifiedPlan) {
    return {
      ok: true,
      value: {
        commit: contractBase.stdout,
        tree: contractTree.stdout,
        contract_base_commit: contractBase.stdout,
        dependency_task_ids: [],
        verification_id: null
      }
    };
  }

  const plan = await loadCurrentRatifiedPlan(repoRoot, spec.value.spec_id, `task ${contract.task_id} authoring base`);
  if (!plan.ok) return plan;
  const dependencies = await requireCurrentVerifiedDependencySet(repoRoot, plan.value, contract.task_id, events.value);
  if (!dependencies.ok) return dependencies;
  if (dependencies.value === null) {
    return {
      ok: true,
      value: {
        commit: contractBase.stdout,
        tree: contractTree.stdout,
        contract_base_commit: contractBase.stdout,
        dependency_task_ids: [],
        verification_id: null
      }
    };
  }

  const manifest = dependencies.value.verification.manifest;
  const verificationId = manifest.verification_id;
  if (manifest.base_commit !== contractBase.stdout) {
    return { ok: false, reason: `task ${contract.task_id} authoring base refused: verification set does not match the contract base` };
  }

  const commit = await git(
    repoRoot,
    ["commit-tree", manifest.result_tree, "-p", contractBase.stdout, "-m", `Hivemind authoring base ${verificationId}`],
    deterministicCommitEnvironment()
  );
  if (!commit.ok) return { ok: false, reason: `task ${contract.task_id} authoring base could not bind verified tree: ${commit.reason}` };
  const [boundTree, boundParent] = await Promise.all([
    git(repoRoot, ["rev-parse", "--verify", `${commit.stdout}^{tree}`]),
    git(repoRoot, ["rev-parse", "--verify", `${commit.stdout}^1`])
  ]);
  if (!boundTree.ok || !boundParent.ok || boundTree.stdout !== manifest.result_tree || boundParent.stdout !== contractBase.stdout) {
    return { ok: false, reason: `task ${contract.task_id} authoring base identity could not be proven after creation` };
  }

  return {
    ok: true,
    value: {
      commit: commit.stdout,
      tree: manifest.result_tree,
      contract_base_commit: contractBase.stdout,
      dependency_task_ids: [...dependencies.value.task_ids],
      verification_id: verificationId
    }
  };
}

export async function requireCurrentVerifiedDependencySet(
  repoRoot: string,
  plan: TentativePlan,
  taskId: string,
  existingEvents?: HivemindEvent[]
): Promise<{ ok: true; value: CurrentVerifiedDependencySet | null } | { ok: false; reason: string }> {
  const dependencies = dependencyClosure(plan, taskId);
  if (!dependencies.ok) return dependencies;
  if (dependencies.value.length === 0) return { ok: true, value: null };
  const events = existingEvents === undefined ? await readEvents(repoRoot) : { ok: true as const, value: existingEvents };
  if (!events.ok) return events;
  const expected = new Set(dependencies.value);
  const verificationEvent = [...events.value].reverse().find((event) => {
    if (event.type !== "integration.passed" || typeof event.data.verification_id !== "string") return false;
    const applied = stringArray(event.data.applied);
    return applied !== null && sameSet(applied, expected);
  });
  if (verificationEvent === undefined) {
    return { ok: false, reason: `task ${taskId} requires one current verification set for exactly dependencies: ${dependencies.value.join(", ")}` };
  }
  const verificationId = String(verificationEvent.data.verification_id);
  const stored = await loadVerificationSet(repoRoot, verificationId);
  if (!stored.ok) return { ok: false, reason: `task ${taskId} dependency verification refused: ${stored.reason}` };
  if (
    verificationEvent.data.verification_manifest_path !== stored.value.manifest_path ||
    verificationEvent.data.verification_manifest_sha256 !== stored.value.manifest_sha256
  ) {
    return { ok: false, reason: `task ${taskId} dependency verification refused: manifest identity does not match the durable event` };
  }
  const manifest = stored.value.manifest;
  if (manifest.base_commit !== plan.base_commit || !sameSet(manifest.task_ids, expected)) {
    return { ok: false, reason: `task ${taskId} dependency verification refused: set does not match the plan base and exact dependency closure` };
  }
  const current = await verificationInputsStillMatch(repoRoot, manifest);
  if (!current.ok) return { ok: false, reason: `task ${taskId} dependency verification refused: ${current.reason}` };
  const tree = await git(repoRoot, ["rev-parse", "--verify", `${manifest.result_tree}^{tree}`]);
  if (!tree.ok || tree.stdout !== manifest.result_tree) {
    return { ok: false, reason: `task ${taskId} dependency verification refused: verified result tree is unavailable` };
  }
  return { ok: true, value: { task_ids: dependencies.value, verification: stored.value } };
}

function dependencyClosure(
  plan: TentativePlan,
  taskId: string
): { ok: true; value: string[] } | { ok: false; reason: string } {
  const byId = new Map(plan.tasks.map((task) => [task.task_id, task]));
  if (!byId.has(taskId)) return { ok: false, reason: `task ${taskId} is not present in the active ratified plan` };
  const closure = new Set<string>();
  const visit = (current: string): boolean => {
    const task = byId.get(current);
    if (task === undefined) return false;
    for (const dependency of task.depends_on) {
      if (!byId.has(dependency)) return false;
      if (!closure.has(dependency)) {
        closure.add(dependency);
        if (!visit(dependency)) return false;
      }
    }
    return true;
  };
  if (!visit(taskId)) return { ok: false, reason: `task ${taskId} dependency graph is unreadable` };
  return { ok: true, value: plan.tasks.map((task) => task.task_id).filter((candidate) => closure.has(candidate)) };
}

function sameSet(values: string[], expected: Set<string>): boolean {
  return values.length === expected.size && values.every((value) => expected.has(value));
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function deterministicCommitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Hivemind",
    GIT_AUTHOR_EMAIL: "hivemind@local.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Hivemind",
    GIT_COMMITTER_EMAIL: "hivemind@local.invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
  };
}

async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, env, maxBuffer: 1024 * 1024 * 32 });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error: unknown) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
    return { ok: false, reason: stderr || stdout || "git command failed" };
  }
}
