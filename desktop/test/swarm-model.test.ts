import { describe, expect, test } from "vitest";

import { applyEventMessage, createBoardProjection } from "../src/lib/projection";
import { buildSwarmTree, defaultCollapsedGroups } from "../src/lib/swarm-model";
import type { WorkspaceInspection } from "../src/lib/workspace-actions";

describe("Swarm presentation model", () => {
  test("builds the real hierarchy with nine visible mixed-state tasks and supporting agents", () => {
    const projection = createBoardProjection();
    const inspection = fixtureInspection(9);
    for (let index = 1; index <= 9; index += 1) {
      const taskId = `T-${String(index).padStart(3, "0")}`;
      applyEventMessage(projection, {
        kind: "event",
        source: "history",
        event: event(index === 4 ? "task.failed" : index <= 2 ? "task.started" : "task.created", taskId, {
          title: `Task ${index}`,
          reason: index === 4 ? "worker stopped" : undefined
        })
      });
    }
    for (const item of [
      event("task.scouting_started", "T-001", { tool: "scout" }),
      event("quality.admission_decided", "T-002", { quality_run_id: "Q-T-002-demo", admitted: true }),
      event("quality.draft_started", "T-002", { quality_run_id: "Q-T-002-demo", draft_id: "D-001" })
    ]) {
      applyEventMessage(projection, { kind: "event", source: "history", event: item });
    }

    const tree = buildSwarmTree(projection, inspection);
    expect(tree.groups.map((group) => group.label)).toEqual(["3 at once", "6 in order"]);
    expect(tree.task_count).toBe(9);
    expect(tree.subagent_count).toBe(3);
    expect(tree.state).toBe("needs-you");
    expect(tree.groups.flatMap((group) => group.tasks).find((task) => task.task.task_id === "T-004")?.state).toBe("needs-you");
    expect(defaultCollapsedGroups(tree.groups)).toEqual(new Set());
  });

  test("collapses dense groups deterministically to keep the whole swarm in view", () => {
    const tree = buildSwarmTree(createBoardProjection(), fixtureInspection(20));
    expect(tree.task_count).toBe(20);
    expect([...defaultCollapsedGroups(tree.groups)]).toEqual(["G-2"]);
  });
});

function fixtureInspection(taskCount: number): WorkspaceInspection {
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const number = index + 1;
    return {
      task_id: `T-${String(number).padStart(3, "0")}`,
      title: `Task ${number}`,
      tier: "high" as const,
      task_type: "deterministic" as const,
      routing_task_type: "ui",
      mode: "write" as const,
      agent_role: "builder",
      scope: [`src/task-${number}.ts`],
      allowed_file_intents: {},
      read_only_scope: [],
      forbidden_scope: [],
      must_not_change: [],
      depends_on: number > 3 ? [`T-${String(number - 1).padStart(3, "0")}`] : [],
      parallel_safe: number <= 3,
      acceptance_criterion: "fixture",
      deterministic_validity_check: "npm test",
      required_tests: ["npm test"],
      patch_requirements: [],
      critical_path_approved: false
    };
  });
  const plan = {
    spec_id: "S-001",
    plan_hash: "a".repeat(64),
    plan_path: ".hivemind/plan/tentative.json",
    base_commit: "b".repeat(40),
    created_at: "2026-07-31T12:00:00.000Z",
    tasks,
    execution_groups: [
      { group_id: "G-1", mode: "parallel" as const, task_ids: tasks.slice(0, 3).map((task) => task.task_id) },
      { group_id: "G-2", mode: "sequence" as const, task_ids: tasks.slice(3).map((task) => task.task_id) }
    ]
  };
  return {
    active_spec_id: "S-001",
    manager_session: null,
    plan_review: plan,
    current_plan: plan,
    integration_failure: null,
    needs_you: [],
    later: [],
    spend: { session_id: null, calls: 0, effective_tokens: 0, run_ceiling_tokens: 150_000, session_ceiling_tokens: 500_000 },
    swarm: {
      characterizations: [{
        candidate_id: "C-001",
        task_id: "T-003",
        classification: "valid_characterization",
        reason: "existing behavior captured",
        check_id: "unit",
        artifact_path: ".hivemind/resource/oracle-candidates/C-001",
        patch: "diff --git a/test/example.test.ts b/test/example.test.ts\n",
        base_outcome: "pass",
        post_change_outcome: "pass"
      }],
      warnings: []
    },
    memory: {
      pending_lessons: [],
      routing_changes: [],
      draft_tests: [],
      canon: [],
      active_routing: { status: "absent", canon_id: null, reason: null, task_types: [] },
      warnings: []
    },
    history: { runs: [], run_ceiling_tokens: 150_000, session_ceiling_tokens: 500_000, warnings: [] }
  };
}

function event(type: string, task_id: string, data: Record<string, unknown>) {
  return { ts: "2026-07-31T12:00:00.000Z", type, task_id, data };
}
