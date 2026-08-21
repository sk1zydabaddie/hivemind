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

  test("names an unnameable task without showing its identifier", () => {
    /* Real trails carry events for tasks the projection cannot name. This used
       to fall back to the identifier so two failing tasks stayed distinct;
       `taskId` on the entry does that job, and the identifier was only ever
       leaking to the screen. */
    const thread = buildRunThread(
      newestFirst([event("task.failed", "T-209", {}), event("patch.rejected", "T-107", {})]),
      {}
    );

    expect(thread).toMatchObject([
      { kind: "milestone", text: "One of the tasks stopped unexpectedly", taskId: "T-209" },
      { kind: "milestone", text: "One of the tasks has to revise its change", taskId: "T-107" }
    ]);
    // Two entries, not one collapsed pair: the grouping key is the task id.
    expect(thread).toHaveLength(2);
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

  test("projects first-message drafting as a durable conversation without duplicating the request", () => {
    const thread = buildRunThread(
      newestFirst([
        event("conversation.message_recorded", null, {
          message_id: "S-001",
          text: "Hello, can you respond?"
        }, "2026-08-06T14:00:00.000Z"),
        event("spec.draft_started", null, { spec_id: "S-001", tool: "planner" }, "2026-08-06T14:00:01.000Z"),
        event("spec.draft_completed", null, {
          spec_id: "S-001",
          title: "Respond to the user",
          goal: "Acknowledge the message and ask what they want to build.",
          open_questions: ["What would you like Hivemind to build?"]
        }, "2026-08-06T14:00:04.000Z"),
        event("plan.prepared", null, {
          spec_id: "S-001",
          prompt: "Hello, can you respond?"
        }, "2026-08-06T14:00:05.000Z")
      ]),
      TITLES
    );

    expect(thread.map((entry) => entry.kind)).toEqual(["request", "draft", "assistant", "plan"]);
    expect(thread[1]).toMatchObject({ kind: "draft", state: "done", durationMs: 3000 });
    expect(thread[2]).toMatchObject({
      kind: "assistant",
      text: "Acknowledge the message and ask what they want to build.",
      questions: ["What would you like Hivemind to build?"]
    });
  });
});

/* The shipped card is the last thing a person reads, and it was wrong on the
 * first real run: `adoption.completed` did not carry `changed_files`, so it
 * reported "0 files changed" over a commit that changed eight. Core writes the
 * field now. Both shapes are pinned here because the pre-fix shape still exists
 * in `docs/evidence/e2e-2026-08-11-textkit`, and that trail is only useful as a
 * regression artefact for as long as it keeps reproducing the defect.
 */
describe("what the shipped card can say about a ship", () => {
  const shipped = (data: Record<string, unknown>) =>
    buildRunThread([event("adoption.completed", null, data)], TITLES).find(
      (entry) => entry.kind === "shipped"
    );

  test("reports every file when Core recorded them", () => {
    const entry = shipped({
      task_ids: ["T-001", "T-002"],
      changed_files: ["README.md", "src/slugify.js", "test/slugify.test.js"],
      base_branch: "master",
      adopted_ref: "6b024f5c11938085e07389ace42796a74231a878"
    });
    expect(entry).toMatchObject({
      kind: "shipped",
      taskIds: ["T-001", "T-002"],
      changedFiles: ["README.md", "src/slugify.js", "test/slugify.test.js"],
      branch: "master"
    });
  });

  /* Absent and empty are different facts, and collapsing them is how the card
     came to read "0 files changed" over a commit that changed eight. The
     captured 2026-08-11 trail is exactly the absent shape. */
  test("says the record is silent when the event predates the field", () => {
    const entry = shipped({
      task_ids: ["T-001"],
      base_branch: "master",
      adopted_ref: "6b024f5c11938085e07389ace42796a74231a878"
    });
    expect(entry).toMatchObject({ kind: "shipped", changedFiles: null });
  });

  test("reports a genuinely empty set as empty, not as silence", () => {
    const entry = shipped({
      task_ids: ["T-001"],
      changed_files: [],
      base_branch: "master"
    });
    expect(entry).toMatchObject({ kind: "shipped", changedFiles: [] });
  });
});

describe("how long a run has been going", () => {
  /* The buffer is not a run. The textkit trail opens with a settings change
     twenty-six minutes before anybody typed anything, and measuring the whole
     buffer reported a six-minute run as "took 30m 43s". */
  test("measures from the request, not from the first event in the buffer", () => {
    const events = newestFirst([
      event("autonomy.level_changed", null, {}, "2026-08-11T05:21:29.169Z"),
      event("plan.prepared", null, {}, "2026-08-11T05:46:16.000Z"),
      event("task.started", "T-001", {}, "2026-08-11T05:47:55.981Z"),
      event("adoption.completed", null, {}, "2026-08-11T05:52:12.136Z")
    ]);
    expect(runSpanMs(events)).toBe(
      Date.parse("2026-08-11T05:52:12.136Z") - Date.parse("2026-08-11T05:46:16.000Z")
    );
  });

  test("keeps the whole window when the trail records no request", () => {
    const events = newestFirst([
      event("task.started", "T-001", {}, "2026-08-11T05:47:55.981Z"),
      event("task.completed", "T-001", {}, "2026-08-11T05:49:03.000Z")
    ]);
    expect(runSpanMs(events)).toBe(
      Date.parse("2026-08-11T05:49:03.000Z") - Date.parse("2026-08-11T05:47:55.981Z")
    );
  });

  test("takes the newest request when a trail carries more than one run", () => {
    const events = newestFirst([
      event("plan.prepared", null, {}, "2026-08-11T05:00:00.000Z"),
      event("adoption.completed", null, {}, "2026-08-11T05:10:00.000Z"),
      event("plan.prepared", null, {}, "2026-08-11T06:00:00.000Z"),
      event("adoption.completed", null, {}, "2026-08-11T06:02:30.000Z")
    ]);
    expect(runSpanMs(events)).toBe(150_000);
  });
});

/* The projection keeps events newest-first; the thread reads oldest-first. */
function newestFirst(oldestFirst: HivemindEvent[]): HivemindEvent[] {
  return [...oldestFirst].reverse();
}

function event(
  type: string,
  taskId: string | null,
  data: Record<string, unknown>,
  ts = "2026-08-06T14:00:00.000Z"
): HivemindEvent {
  return { ts, type, task_id: taskId, data };
}

function at(ts: string, type: string, taskId: string | null): HivemindEvent {
  return { ts, type, task_id: taskId, data: {} };
}
