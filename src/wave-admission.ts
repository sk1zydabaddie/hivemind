import { readEvents } from "./events.js";
import { canonicalizeConcreteFileScope } from "./file-scope.js";
import { integratedTaskIdsFromEvents } from "./integration-state.js";
import { loadCurrentRatifiedPlan, type TentativePlanTask } from "./plan.js";
import { requireCurrentVerifiedDependencySet } from "./task-authoring-base.js";

export interface ExecutionWaveAdmission {
  spec_id: string;
  group_id: string;
  mode: "parallel" | "sequence";
  admitted_task_ids: string[];
  waiting_task_ids: string[];
}

type AdmissionResult =
  | { ok: true; value: ExecutionWaveAdmission }
  | { ok: false; reason: string };

export async function admitExecutionWave(
  repoRoot: string,
  specId: string,
  groupId: string
): Promise<AdmissionResult> {
  const plan = await loadCurrentRatifiedPlan(repoRoot, specId, "execution-wave admission");
  if (!plan.ok) return plan;
  const group = plan.value.execution_groups.find((entry) => entry.group_id === groupId);
  if (group === undefined) {
    return { ok: false, reason: `execution-wave admission refused: group ${groupId} is not in the active ratified plan` };
  }

  const tasksById = new Map(plan.value.tasks.map((task) => [task.task_id, task]));
  const tasks: TentativePlanTask[] = [];
  for (const taskId of group.task_ids) {
    const task = tasksById.get(taskId);
    if (task === undefined || task.grounded_scope === undefined) {
      return { ok: false, reason: `execution-wave admission refused: group ${groupId} task ${taskId} is missing grounded plan state` };
    }
    tasks.push(task);
  }

  if (group.mode === "parallel") {
    const unsafe = tasks.find((task) => !task.parallel_safe);
    if (unsafe !== undefined) {
      return { ok: false, reason: `execution-wave admission refused: group ${groupId} task ${unsafe.task_id} is not parallel_safe` };
    }
    const disjoint = await requireCanonicalWriteDisjointness(repoRoot, groupId, tasks);
    if (!disjoint.ok) return disjoint;
  }

  const events = await readEvents(repoRoot);
  if (!events.ok) return events;
  const verified = integratedTaskIdsFromEvents(events.value);
  const unfinished = tasks.filter((task) => !verified.has(task.task_id));
  const candidates = group.mode === "sequence" ? unfinished.slice(0, 1) : unfinished;
  const admitted: string[] = [];
  const waiting: string[] = [];
  for (const task of candidates) {
    const dependencies = await requireCurrentVerifiedDependencySet(repoRoot, plan.value, task.task_id, events.value);
    if (dependencies.ok) {
      admitted.push(task.task_id);
    } else {
      waiting.push(task.task_id);
    }
  }

  return {
    ok: true,
    value: {
      spec_id: specId,
      group_id: groupId,
      mode: group.mode,
      admitted_task_ids: admitted,
      waiting_task_ids: waiting
    }
  };
}

async function requireCanonicalWriteDisjointness(
  repoRoot: string,
  groupId: string,
  tasks: TentativePlanTask[]
): Promise<{ ok: true; value: undefined } | { ok: false; reason: string }> {
  const owners = new Map<string, string>();
  for (const task of tasks) {
    const scope = task.grounded_scope;
    if (scope === undefined) {
      return { ok: false, reason: `execution-wave admission refused: task ${task.task_id} has no grounded scope` };
    }
    const canonical = await canonicalizeConcreteFileScope(repoRoot, scope.allowed_files, `parallel task ${task.task_id} write`);
    if (!canonical.ok) {
      return { ok: false, reason: `execution-wave admission refused: ${canonical.reason}` };
    }
    for (const file of canonical.paths) {
      const owner = owners.get(file);
      if (owner !== undefined) {
        return {
          ok: false,
          reason: `execution-wave admission refused: canonical write conflict in group ${groupId}: tasks ${owner} and ${task.task_id} resolve to ${file}`
        };
      }
      owners.set(file, task.task_id);
    }
  }
  return { ok: true, value: undefined };
}
