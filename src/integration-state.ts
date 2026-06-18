import type { HivemindEvent } from "./events.js";

interface PatchTrail {
  submittedIndex: number;
  acceptedIndex: number;
  rejectedIndex: number;
}

export function integratedTaskIdsFromEvents(events: HivemindEvent[]): Set<string> {
  const patches = new Map<string, PatchTrail>();
  const integrated = new Set<string>();

  for (const [index, event] of events.entries()) {
    if (event.type === "patch.submitted" && event.task_id !== null) {
      patches.set(event.task_id, {
        submittedIndex: index,
        acceptedIndex: -1,
        rejectedIndex: -1
      });
      integrated.delete(event.task_id);
      continue;
    }

    if (event.type === "patch.accepted" && event.task_id !== null && event.data.verdict === "accept") {
      const trail = patches.get(event.task_id);
      if (trail !== undefined) {
        trail.acceptedIndex = index;
      }
      continue;
    }

    if (event.type === "patch.rejected" && event.task_id !== null) {
      const trail = patches.get(event.task_id);
      if (trail !== undefined) {
        trail.rejectedIndex = index;
      }
      integrated.delete(event.task_id);
      continue;
    }

    if (event.type === "integration.passed") {
      for (const taskId of eventAppliedTaskIds(event)) {
        if (hasAcceptedCurrentPatch(patches.get(taskId))) {
          integrated.add(taskId);
        }
      }
      continue;
    }

    if (event.type === "integration.failed") {
      for (const taskId of eventAppliedTaskIds(event)) {
        integrated.delete(taskId);
      }
    }
  }

  return integrated;
}

function hasAcceptedCurrentPatch(trail: PatchTrail | undefined): boolean {
  return trail !== undefined && trail.submittedIndex >= 0 && trail.acceptedIndex > trail.submittedIndex && trail.acceptedIndex > trail.rejectedIndex;
}

function eventAppliedTaskIds(event: HivemindEvent): string[] {
  const applied = event.data.applied;
  return Array.isArray(applied) ? applied.filter((entry): entry is string => typeof entry === "string") : [];
}
