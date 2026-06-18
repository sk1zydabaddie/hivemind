import type { HivemindEvent } from "./events.js";

export type TaskRunState =
  | { state: "not_started" }
  | { state: "running"; started: HivemindEvent }
  | { state: "completed"; started: HivemindEvent; completed: HivemindEvent }
  | { state: "failed"; started: HivemindEvent | null; failed: HivemindEvent };

export function latestTaskRunState(events: HivemindEvent[], taskId: string): TaskRunState {
  let started: HivemindEvent | null = null;
  let terminal: HivemindEvent | null = null;

  for (const event of events) {
    if (event.task_id !== taskId) {
      continue;
    }
    if (event.type === "task.started") {
      started = event;
      terminal = null;
      continue;
    }
    if (event.type === "task.completed" || event.type === "task.failed") {
      terminal = event;
    }
  }

  if (terminal?.type === "task.completed") {
    return started === null ? { state: "not_started" } : { state: "completed", started, completed: terminal };
  }
  if (terminal?.type === "task.failed") {
    return { state: "failed", started, failed: terminal };
  }
  if (started !== null) {
    return { state: "running", started };
  }
  return { state: "not_started" };
}
