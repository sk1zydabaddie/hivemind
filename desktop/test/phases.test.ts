import { describe, expect, test } from "vitest";

import { TASK_STATES, type TaskProjection, type TaskState } from "../src/lib/projection";
import { PHASES, clearedPhases, filesInFlight, runStanding, taskPhase } from "../src/lib/phases";

function task(state: TaskState, over: Partial<TaskProjection> = {}): TaskProjection {
  return {
    task_id: "T-001",
    title: "Initialize CLI package metadata and usage docs",
    state,
    agent: null,
    worktree: null,
    lease_files: [],
    patch: {
      submitted: false,
      analyzed: false,
      verdict: null,
      reason: null,
      changed_files: null
    },
    integration: "idle",
    issue: null,
    stalled: false,
    last_event: null,
    last_event_at: null,
    execution_group: null,
    group_mode: null,
    depends_on: [],
    started_at: null,
    worker_finished_at: null,
    ...over
  };
}

describe("the four phases", () => {
  test("every state Core can publish has a phase, and none invents one", () => {
    for (const state of TASK_STATES) {
      const phase = taskPhase(task(state));
      expect(phase.reached).toBeGreaterThanOrEqual(0);
      expect(phase.reached).toBeLessThanOrEqual(PHASES.length);
      expect(phase.summary).not.toBe("");
    }
  });

  test("a change moves forward and never backward through the run", () => {
    const order: TaskState[] = ["planned", "running", "submitted", "verified", "merged"];
    const reached = order.map((state) => taskPhase(task(state)).reached);
    expect(reached).toEqual([...reached].sort((left, right) => left - right));
    expect(reached.at(-1)).toBe(PHASES.length);
  });

  test("a stalled task keeps its published phase but stops reading as progress", () => {
    const moving = taskPhase(task("running"));
    const stuck = taskPhase(task("running", { stalled: true }));
    expect(moving.standing).toBe("working");
    // Core flags the stall; the client only stops calling it progress.
    expect(stuck.standing).toBe("attention");
    expect(stuck.reached).toBe(moving.reached);
  });

  test("a stalled task that already finished is not re-opened by the client", () => {
    // `stalled` must never drag a done task backwards -- Core owns that verdict.
    expect(taskPhase(task("verified", { stalled: true })).standing).toBe("done");
    expect(taskPhase(task("merged", { stalled: true })).standing).toBe("done");
  });

  test("a phase in progress is not counted as cleared", () => {
    expect(clearedPhases(taskPhase(task("running")))).toBe(0);
    expect(clearedPhases(taskPhase(task("merged")))).toBe(PHASES.length);
  });

  test("the run tally separates what is moving from what needs a person", () => {
    const standing = runStanding([
      task("running", { task_id: "T-1" }),
      task("planned", { task_id: "T-2" }),
      task("rejected", { task_id: "T-3" }),
      task("merged", { task_id: "T-4" }),
      task("verified", { task_id: "T-5" })
    ]);
    expect(standing).toEqual({
      working: 1,
      waiting: 1,
      attention: 1,
      done: 2,
      shipped: 1,
      total: 5
    });
  });

  test("files in flight counts what the run has actually spoken for", () => {
    expect(
      filesInFlight([
        task("running", { task_id: "T-1", lease_files: ["a.ts", "b.ts"] }),
        task("planned", { task_id: "T-2" })
      ])
    ).toBe(2);
  });
});
