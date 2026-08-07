import { describe, expect, test } from "vitest";

import type { HivemindEvent } from "../src/lib/projection";
import { buildRunThread } from "../src/lib/work-thread";

const TITLES = { "T-001": "Dark mode toggle", "T-002": "Theme tokens" };

describe("run thread", () => {
  test("reads as a narrative: plan, work, checks, shipped", () => {
    const thread = buildRunThread(
      newestFirst([
        event("plan.prepared", null, { spec_id: "S-1", plan_hash: "abc" }),
        event("plan.ratified", null, { spec_id: "S-1", plan_hash: "abc" }),
        event("task.created", "T-001", {}),
        event("lease.approved", "T-001", {}),
        event("task.started", "T-001", {}),
        event("patch.submitted", "T-001", {}),
        event("patch.accepted", "T-001", {}),
        event("task.completed", "T-001", {}),
        event("integration.passed", null, {}),
        event("adoption.completed", null, {
          task_ids: ["T-001"],
          changed_files: ["src/theme.ts"],
          base_branch: "main",
          adopted_ref: "9c1de44"
        })
      ]),
      TITLES
    );

    expect(thread.map((entry) => entry.kind)).toEqual([
      "plan",
      "milestone",
      "milestone",
      "milestone",
      "shipped"
    ]);
    expect(thread[0]).toMatchObject({ kind: "plan", approved: true, planHash: "abc" });
    expect(thread.at(-1)).toMatchObject({
      kind: "shipped",
      taskIds: ["T-001"],
      changedFiles: ["src/theme.ts"],
      branch: "main"
    });
  });

  test("keeps the mechanical pipeline out of the narrative", () => {
    const thread = buildRunThread(
      newestFirst([
        event("task.created", "T-001", {}),
        event("lease.approved", "T-001", {}),
        event("patch.submitted", "T-001", {}),
        event("patch.accepted", "T-001", {}),
        event("routing.observed", "T-001", {}),
        event("quality.draft_started", "T-001", {}),
        event("integration.queued", "T-001", {})
      ]),
      TITLES
    );

    expect(thread).toEqual([]);
  });

  test("shows guidance text back to the person and whether it was applied", () => {
    const thread = buildRunThread(
      newestFirst([
        event("human.guidance_recorded", null, {
          guidance_id: "H-1",
          message: "Keep the toggle out of the top bar"
        }),
        event("human.guidance_recorded", null, {
          guidance_id: "H-2",
          message: "Prefer system default on first launch"
        }),
        event("human.guidance_consumed", null, { guidance_ids: ["H-1"] })
      ]),
      TITLES
    );

    expect(thread).toEqual([
      {
        kind: "guidance",
        id: "H-1",
        at: "2026-08-06T14:00:00.000Z",
        text: "Keep the toggle out of the top bar",
        applied: true
      },
      {
        kind: "guidance",
        id: "H-2",
        at: "2026-08-06T14:00:00.000Z",
        text: "Prefer system default on first launch",
        applied: false
      }
    ]);
  });

  test("collapses consecutive identical milestones", () => {
    const thread = buildRunThread(
      newestFirst([
        event("task.started", "T-001", {}),
        event("task.started", "T-001", {}),
        event("task.started", "T-002", {})
      ]),
      TITLES
    );

    expect(thread).toMatchObject([
      { kind: "milestone", text: "Dark mode toggle started working", count: 2 },
      { kind: "milestone", text: "Theme tokens started working", count: 1 }
    ]);
  });

  test("renders the request only when Core records its text", () => {
    const withoutText = buildRunThread(
      newestFirst([event("plan.prepared", null, { prompt_hash: "9f".repeat(32) })]),
      TITLES
    );
    expect(withoutText.map((entry) => entry.kind)).toEqual(["plan"]);

    const withText = buildRunThread(
      newestFirst([
        event("plan.prepared", null, {
          prompt_hash: "9f".repeat(32),
          prompt: "Add a dark mode toggle to the settings page"
        })
      ]),
      TITLES
    );
    expect(withText.map((entry) => entry.kind)).toEqual(["request", "plan"]);
    expect(withText[0]).toMatchObject({
      kind: "request",
      text: "Add a dark mode toggle to the settings page"
    });
  });
});

/* The projection keeps events newest-first; the thread reads oldest-first. */
function newestFirst(oldestFirst: HivemindEvent[]): HivemindEvent[] {
  return [...oldestFirst].reverse();
}

function event(
  type: string,
  taskId: string | null,
  data: Record<string, unknown>
): HivemindEvent {
  return { ts: "2026-08-06T14:00:00.000Z", type, task_id: taskId, data };
}
