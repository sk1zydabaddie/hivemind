import { describe, expect, test } from "vitest";

import type { HivemindEvent } from "../src/lib/projection";
import { buildRunThread, runSpanMs } from "../src/lib/work-thread";

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

  test("never renders an unnamed task as an indefinite article", () => {
    // Real trails carry events for tasks the projection cannot name.
    const thread = buildRunThread(
      newestFirst([event("task.failed", "T-209", {}), event("patch.rejected", "T-107", {})]),
      {}
    );

    expect(thread).toMatchObject([
      { kind: "milestone", text: "T-209 stopped unexpectedly", taskId: "T-209" },
      { kind: "milestone", text: "T-107 has to revise its change", taskId: "T-107" }
    ]);
    for (const entry of thread) {
      expect(entry.kind === "milestone" ? entry.text : "").not.toMatch(/^A task/u);
    }
  });

  test("never merges different tasks into one count", () => {
    // Same wording, three different tasks: on a real trail this collapsed into
    // "A task has to revise its change x3", which reads as one task retrying.
    const thread = buildRunThread(
      newestFirst([
        event("patch.rejected", "T-101", {}),
        event("patch.rejected", "T-107", {}),
        event("patch.rejected", "T-112", {})
      ]),
      {}
    );

    expect(thread).toHaveLength(3);
    expect(thread.map((entry) => (entry.kind === "milestone" ? entry.taskId : null))).toEqual([
      "T-101",
      "T-107",
      "T-112"
    ]);
  });

  test("measures how long work took from the durable timestamps", () => {
    const thread = buildRunThread(
      newestFirst([
        at("2026-06-18T22:38:46.826Z", "task.started", "T-001"),
        at("2026-06-18T22:44:41.119Z", "task.completed", "T-001")
      ]),
      { "T-001": "Implement strict JSON ledger storage helpers" }
    );

    const finished = thread.find(
      (entry) => entry.kind === "milestone" && /finished its work/u.test(entry.text)
    );
    // The real M6.2 worker ran 5m54s; the thread showed two adjacent lines.
    expect(finished).toMatchObject({ durationMs: 354_293 });
    expect(runSpanMs(newestFirst([
      at("2026-06-18T22:37:55.736Z", "task.created", "T-001"),
      at("2026-06-18T22:46:17.680Z", "integration.passed", null)
    ]))).toBe(501_944);
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

function at(ts: string, type: string, taskId: string | null): HivemindEvent {
  return { ts, type, task_id: taskId, data: {} };
}
