import {
  taskRows,
  type AgentDisplayState,
  type BoardProjection,
  type SubagentProjection,
  type TaskProjection
} from "./projection";
import type { WorkspaceInspection, WorkspacePlanReview } from "./workspace-actions";

export interface SwarmSubagentNode {
  id: string;
  task_id: string;
  kind: "scout" | "quality-draft" | "characterization";
  label: string;
  state: AgentDisplayState;
  status: string;
  tool: string | null;
  quality_run_id: string | null;
  files: string[];
  detail: string | null;
  selected: boolean;
  evidence_path: string | null;
}

export interface SwarmTaskNode {
  id: string;
  task: TaskProjection;
  state: AgentDisplayState;
  subagents: SwarmSubagentNode[];
}

export interface SwarmGroupNode {
  id: string;
  label: string;
  mode: "parallel" | "sequence";
  state: AgentDisplayState;
  tasks: SwarmTaskNode[];
}

export interface SwarmTree {
  id: "orchestrator";
  state: AgentDisplayState;
  groups: SwarmGroupNode[];
  task_count: number;
  subagent_count: number;
}

export function buildSwarmTree(
  projection: BoardProjection,
  inspection: WorkspaceInspection | null
): SwarmTree {
  const plan = inspection?.current_plan ?? inspection?.plan_review ?? null;
  const tasks = taskMap(projection, plan);
  const subagents = subagentMap(projection, inspection);
  const groups = groupDefinitions(plan, tasks).map((definition) => {
    const groupTasks = definition.task_ids
      .map((taskId) => tasks.get(taskId))
      .filter((task): task is TaskProjection => task !== undefined)
      .map((task) => ({
        id: `task:${task.task_id}`,
        task,
        state: displayStateForTask(task),
        subagents: subagents.get(task.task_id) ?? []
      }));
    return {
      id: definition.group_id,
      label: definition.mode === "parallel"
        ? `${groupTasks.length} at once`
        : `${groupTasks.length} in order`,
      mode: definition.mode,
      state: aggregateState(groupTasks.map((task) => task.state)),
      tasks: groupTasks
    };
  });
  const taskCount = groups.reduce((count, group) => count + group.tasks.length, 0);
  const subagentCount = groups.reduce(
    (count, group) => count + group.tasks.reduce((sum, task) => sum + task.subagents.length, 0),
    0
  );
  return {
    id: "orchestrator",
    state: aggregateState(groups.map((group) => group.state)),
    groups,
    task_count: taskCount,
    subagent_count: subagentCount
  };
}

export function defaultCollapsedGroups(
  groups: SwarmGroupNode[],
  visibleTaskBudget = 12
): Set<string> {
  let visibleTasks = groups.reduce((count, group) => count + group.tasks.length, 0);
  const collapsed = new Set<string>();
  for (const group of [...groups].sort((left, right) =>
    right.tasks.length - left.tasks.length || left.id.localeCompare(right.id)
  )) {
    if (visibleTasks <= visibleTaskBudget) break;
    collapsed.add(group.id);
    visibleTasks -= group.tasks.length;
  }
  return collapsed;
}

export function displayStateForTask(task: TaskProjection): AgentDisplayState {
  if (["failed", "blocked", "rejected"].includes(task.state)) return "needs-you";
  if (task.state === "verified") return "done";
  if (["planned", "paused", "cancelled"].includes(task.state)) return "waiting";
  return "healthy";
}

export function aggregateState(states: AgentDisplayState[]): AgentDisplayState {
  if (states.includes("needs-you")) return "needs-you";
  if (states.includes("healthy")) return "healthy";
  if (states.includes("waiting")) return "waiting";
  return "done";
}

function taskMap(
  projection: BoardProjection,
  plan: WorkspacePlanReview | null
): Map<string, TaskProjection> {
  const tasks = new Map(taskRows(projection).map((task) => [task.task_id, task]));
  for (const planned of plan?.tasks ?? []) {
    const observed = tasks.get(planned.task_id);
    if (observed) {
      tasks.set(planned.task_id, {
        ...observed,
        title: observed.title === observed.task_id ? planned.title : observed.title
      });
      continue;
    }
    const group = plan?.execution_groups.find((candidate) => candidate.task_ids.includes(planned.task_id));
    tasks.set(planned.task_id, {
      task_id: planned.task_id,
      title: planned.title,
      state: "planned",
      agent: null,
      worktree: null,
      lease_files: [],
      patch: { submitted: false, analyzed: false, verdict: null, reason: null, changed_files: null },
      integration: "not queued",
      issue: null,
      last_event: null,
      last_event_at: null,
      execution_group: group?.group_id ?? null,
      group_mode: group?.mode ?? null,
      depends_on: [...planned.depends_on],
      started_at: null,
      worker_finished_at: null
    });
  }
  return tasks;
}

function subagentMap(
  projection: BoardProjection,
  inspection: WorkspaceInspection | null
): Map<string, SwarmSubagentNode[]> {
  const byTask = new Map<string, SwarmSubagentNode[]>();
  const add = (node: SwarmSubagentNode): void => {
    const siblings = byTask.get(node.task_id) ?? [];
    siblings.push(node);
    byTask.set(node.task_id, siblings);
  };
  for (const agent of Object.values(projection.subagents).sort(compareSubagents)) {
    add(presentObservedSubagent(agent));
  }
  for (const candidate of inspection?.swarm.characterizations ?? []) {
    add({
      id: `characterization:${candidate.candidate_id}`,
      task_id: candidate.task_id,
      kind: "characterization",
      label: "Test writer",
      state: candidate.classification === "valid_characterization" ? "done" : "needs-you",
      status: characterizationStatus(candidate.classification),
      tool: null,
      quality_run_id: null,
      files: [],
      detail: candidate.reason,
      selected: false,
      evidence_path: candidate.artifact_path
    });
  }
  return byTask;
}

function presentObservedSubagent(agent: SubagentProjection): SwarmSubagentNode {
  return {
    id: `subagent:${agent.id}`,
    task_id: agent.task_id,
    kind: agent.kind,
    label: agent.label,
    state: agent.state,
    status: agent.status,
    tool: agent.tool,
    quality_run_id: agent.quality_run_id,
    files: [...agent.changed_files],
    detail: agent.detail,
    selected: agent.selected,
    evidence_path: null
  };
}

function groupDefinitions(
  plan: WorkspacePlanReview | null,
  tasks: Map<string, TaskProjection>
): Array<{ group_id: string; mode: "parallel" | "sequence"; task_ids: string[] }> {
  const definitions = (plan?.execution_groups ?? []).map((group) => ({
    group_id: group.group_id,
    mode: group.mode,
    task_ids: [...group.task_ids]
  }));
  const assigned = new Set(definitions.flatMap((group) => group.task_ids));
  const observedGroups = new Map<string, { mode: "parallel" | "sequence"; task_ids: string[] }>();
  for (const task of tasks.values()) {
    if (assigned.has(task.task_id)) continue;
    const groupId = task.execution_group ?? "current-work";
    const mode = task.group_mode === "parallel" ? "parallel" : "sequence";
    const group = observedGroups.get(groupId) ?? { mode, task_ids: [] };
    group.task_ids.push(task.task_id);
    observedGroups.set(groupId, group);
  }
  for (const [groupId, group] of [...observedGroups].sort(([left], [right]) => left.localeCompare(right))) {
    definitions.push({ group_id: groupId, mode: group.mode, task_ids: group.task_ids.sort() });
  }
  return definitions;
}

function compareSubagents(left: SubagentProjection, right: SubagentProjection): number {
  return left.task_id.localeCompare(right.task_id) || left.id.localeCompare(right.id);
}

function characterizationStatus(classification: string): string {
  if (classification === "valid_characterization") return "Existing behavior captured";
  if (classification === "regression_signal") return "Behavior changed under test";
  if (classification === "rejected") return "Candidate rejected";
  return "Could not verify candidate";
}
