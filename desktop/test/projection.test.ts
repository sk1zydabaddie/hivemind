import { describe, expect, test } from "vitest";

import {
  applyEventMessage,
  applyOutputMessage,
  createBoardProjection,
  leaseRows,
  qualityRunRows,
  selectTask,
  taskRows
} from "../src/lib/projection";

describe("read-only event projection", () => {
  test("replays task, file-scope, patch, and shadow-verification events", () => {
    const state = createBoardProjection();
    for (const item of [
      makeEvent("task.created", "T-001", { title: "Create ledger" }),
      makeEvent("lease.approved", "T-001", {
        granted: ["src/ledger.js", "test/ledger.test.js"]
      }),
      makeEvent("task.started", "T-001", {
        tool: "codex-worker",
        worktree: ".hivemind/worktrees/T-001"
      }),
      makeEvent("patch.submitted", "T-001", { changed_files: 2 }),
      makeEvent("patch.accepted", "T-001", {
        verdict: "accept",
        reason: "all changes within scope"
      }),
      makeEvent("integration.queued", "T-001", { queue: ["T-001"] }),
      makeEvent("integration.passed", null, {
        applied: ["T-001"],
        tests: "pass",
        report: "4/4"
      })
    ]) {
      applyEventMessage(state, {
        kind: "event",
        source: "history",
        event: item
      });
    }

    const rows = taskRows(state);
    expect(rows).toHaveLength(1);
    // Verification is Core's answer, read from the inspection payload. The
    // projection stops at what the live stream itself observed.
    expect(rows[0].state).toBe("accepted");
    expect(rows[0].patch.submitted).toBe(true);
    expect(rows[0].patch.verdict).toBe("accept");
    expect(leaseRows(state)).toEqual([
      { filePath: "src/ledger.js", taskId: "T-001" },
      { filePath: "test/ledger.test.js", taskId: "T-001" }
    ]);
    expect(state.integration.status).toBe("passed");
  });

  test("projects paused and bare failed events as distinct task states", () => {
    const state = createBoardProjection();
    applyEventMessage(state, {
      kind: "event",
      source: "history",
      event: makeEvent("task.paused", "T-PAUSE", {
        reason: "quota_exhausted"
      })
    });
    applyEventMessage(state, {
      kind: "event",
      source: "live",
      event: makeEvent("task.failed", "T-FAIL", {
        reason: "worker process exited 1"
      })
    });

    expect(state.tasks["T-PAUSE"].state).toBe("paused");
    expect(state.tasks["T-FAIL"].state).toBe("failed");
    expect(state.tasks["T-FAIL"].issue).toBe("worker process exited 1");
  });

  test("worker completion no longer projects as an active worker", () => {
    const state = createBoardProjection();
    applyEventMessage(state, { kind: "event", source: "history", event: makeEvent("task.started", "T-DONE", {}) });
    applyEventMessage(state, { kind: "event", source: "live", event: makeEvent("task.completed", "T-DONE", {}) });
    expect(state.tasks["T-DONE"].state).toBe("submitted");
    expect(state.tasks["T-DONE"].worker_finished_at).not.toBeNull();
  });

  test("projects Merged only from adoption.completed, never from verification", () => {
    const state = createBoardProjection();
    // Verification only stands on an accepted current patch, so give this
    // fixture the trail a real run produces.
    for (const event of [
      makeEvent("patch.submitted", "T-ADOPT", { changed_files: 1 }),
      makeEvent("patch.accepted", "T-ADOPT", { verdict: "accept", reason: "in scope" }),
      makeEvent("integration.passed", null, { applied: ["T-ADOPT"], tests: "pass" })
    ]) {
      applyEventMessage(state, { kind: "event", source: "history", event });
    }
    selectTask(state, "T-ADOPT");
    applyOutputMessage(state, {
      kind: "output",
      source: "live",
      record: { task_id: "T-ADOPT", tool: "fixture", ts: new Date().toISOString(), stream: "stdout", text: "done" }
    });
    expect(state.integration.status).toBe("passed");
    applyEventMessage(state, {
      kind: "event",
      source: "history",
      event: makeEvent("adoption.completed", null, {
        task_ids: ["T-ADOPT"],
        pre_adoption_ref: "a".repeat(40),
        adopted_ref: "b".repeat(40)
      })
    });
    expect(state.integration.status).toBe("merged");
    expect(state.integration.lastEvent?.type).toBe("adoption.completed");
    expect(state.selectedTaskId).toBeNull();
    expect(state.selectedOutput).toEqual([]);
  });

  test("surfaces blocked and low-confidence project-check evidence", () => {
    const blocked = createBoardProjection();
    applyEventMessage(blocked, {
      kind: "event",
      source: "live",
      event: makeEvent("integration.blocked", null, {
        tests: "blocked",
        report: "configured coverage is weak"
      })
    });
    expect(blocked.integration.status).toBe("blocked");
    expect(blocked.integration.tests).toBe("blocked");

    const lowConfidence = createBoardProjection();
    applyEventMessage(lowConfidence, {
      kind: "event",
      source: "live",
      event: makeEvent("integration.low_confidence", null, {
        report: "low-tier coverage is unknown"
      })
    });
    expect(lowConfidence.integration.status).toBe("low-confidence");
  });

  test("projects routing observations and quality runs outside recent events", () => {
    const state = createBoardProjection();
    applyEventMessage(state, {
      kind: "event",
      source: "history",
      event: makeEvent("routing.observed", "T-002", {
        provider: "codex",
        routing_task_type: "integration",
        effective_tokens: 19_160,
        accounting_source: "provider_reported",
        wall_time_ms: 2_100
      })
    });
    for (const event of [
      makeEvent("quality.admission_decided", "T-003", {
        quality_run_id: "Q-T-003-demo",
        strategy: "best_of_n",
        admitted: true,
        reason: "High task"
      }),
      makeEvent("quality.draft_started", "T-003", {
        quality_run_id: "Q-T-003-demo",
        draft_id: "D-001"
      }),
      makeEvent("quality.draft_verified", "T-003", {
        quality_run_id: "Q-T-003-demo",
        draft_id: "D-001",
        tests: "pass"
      }),
      makeEvent("quality.draft_disposed", "T-003", {
        quality_run_id: "Q-T-003-demo",
        draft_id: "D-001",
        eligible_for_selection: true,
        changed_files: ["src/scheduler.ts"]
      }),
      makeEvent("quality.selection_decided", "T-003", {
        quality_run_id: "Q-T-003-demo",
        selected_draft_id: "D-001"
      })
    ]) {
      applyEventMessage(state, {
        kind: "event",
        source: "history",
        event
      });
    }

    expect(state.routingObservations).toEqual([
      expect.objectContaining({
        task_id: "T-002",
        provider: "codex",
        routing_task_type: "integration",
        effective_tokens: 19_160
      })
    ]);
    expect(qualityRunRows(state)).toEqual([
      expect.objectContaining({
        quality_run_id: "Q-T-003-demo",
        drafts_started: 1,
        drafts_verified: 1,
        drafts_disposed: 1,
        selected_draft_id: "D-001",
        status: "candidate selected"
      })
    ]);
    expect(state.subagents["Q-T-003-demo:D-001"]).toEqual(
      expect.objectContaining({
        task_id: "T-003",
        kind: "quality-draft",
        state: "done",
        selected: true,
        changed_files: ["src/scheduler.ts"]
      })
    );
  });

  test("projects Scouts and records artifact motion only for live durable events", () => {
    const state = createBoardProjection();
    for (const event of [
      makeEvent("scout.completed", "T-005", { tool: "codex-scout", cited_files: 4 }),
      makeEvent("patch.accepted", "T-005", { reason: "scope matched" })
    ]) {
      applyEventMessage(state, { kind: "event", source: "history", event });
    }
    expect(state.subagents["T-005:scout"]).toEqual(expect.objectContaining({
      task_id: "T-005",
      kind: "scout",
      state: "done",
      detail: "4 files cited"
    }));
    expect(state.artifactMovements).toEqual([]);

    applyEventMessage(state, {
      kind: "event",
      source: "live",
      seq: 42,
      event: makeEvent("verification.completed", "T-005", { tests: "pass" })
    });
    applyEventMessage(state, {
      kind: "event",
      source: "live",
      seq: 43,
      event: makeEvent("integration.passed", null, { applied: ["T-005"] })
    });
    expect(state.artifactMovements.map((movement) => [movement.task_id, movement.stage])).toEqual([
      ["T-005", "tests"],
      ["T-005", "verified"]
    ]);
  });

  test("keeps execution groups and selected-task output presentation-only", () => {
    const state = createBoardProjection();
    applyEventMessage(state, {
      kind: "event",
      source: "history",
      event: makeEvent("task.created", "T-004", {
        title: "Wire people commands",
        depends_on: ["T-001", "T-002"],
        execution_group: "G-2",
        group_mode: "sequence"
      })
    });
    selectTask(state, "T-004");
    applyOutputMessage(state, {
      kind: "output",
      source: "live",
      record: output("T-003", "stdout", "other")
    });
    applyOutputMessage(state, {
      kind: "output",
      source: "live",
      record: output("T-004", "stdout", "hello")
    });

    const [row] = taskRows(state);
    expect(row.execution_group).toBe("G-2");
    expect(row.group_mode).toBe("sequence");
    expect(row.depends_on).toEqual(["T-001", "T-002"]);
    expect(state.selectedOutput).toHaveLength(1);
    expect(state.selectedOutput[0].text).toBe("hello");
  });

  test("adoption and re-check outcomes are never silent on the board", () => {
    const replay = (events: ReturnType<typeof makeEvent>[]) => {
      const state = createBoardProjection();
      for (const event of events) {
        applyEventMessage(state, { kind: "event", source: "history", event });
      }
      return state;
    };
    const verified = [
      makeEvent("patch.submitted", "T-001", { changed_files: 1 }),
      makeEvent("patch.accepted", "T-001", { verdict: "accept", reason: "in scope" }),
      makeEvent("integration.passed", null, { applied: ["T-001"], tests: "pass" })
    ];
    expect(replay(verified).integration.status).toBe("passed");

    // The thread previously said "merging" and then fell silent whichever way
    // adoption went, and a re-check the user asked for reported nothing.
    for (const [type, status] of [
      ["adoption.failed", "adoption failed"],
      ["adoption.indeterminate", "adoption indeterminate"],
      ["verification.rerun_failed", "recheck failed"]
    ] as const) {
      const state = replay([...verified, makeEvent(type, null, { task_ids: ["T-001"], reason: "fixture" })]);
      expect(state.integration.status).toBe(status);
      expect(state.integration.lastEvent?.type).toBe(type);
    }
  });

  test("the projection never answers whether a task is verified or merged", () => {
    // Core derives verification once and the desktop reads it from the
    // inspection payload. A second answer here is what made every retraction
    // need writing twice, so reintroducing one must fail loudly.
    const state = createBoardProjection();
    for (const event of [
      makeEvent("patch.submitted", "T-001", { changed_files: 1 }),
      makeEvent("patch.accepted", "T-001", { verdict: "accept", reason: "in scope" }),
      makeEvent("integration.passed", null, { applied: ["T-001"], tests: "pass" }),
      makeEvent("adoption.completed", null, { task_ids: ["T-001"], adopted_ref: "b".repeat(40) })
    ]) {
      applyEventMessage(state, { kind: "event", source: "history", event });
    }
    for (const task of taskRows(state)) {
      expect(task.state).not.toBe("verified");
      expect(task.state).not.toBe("merged");
    }
  });
});

function makeEvent(
  type: string,
  task_id: string | null,
  data: Record<string, unknown>
) {
  return {
    ts: "2026-07-30T12:34:56.000Z",
    type,
    task_id,
    data
  };
}

function output(task_id: string, stream: string, text: string) {
  return {
    ts: "2026-07-30T12:34:56.000Z",
    task_id,
    tool: "codex-worker",
    stream,
    text
  };
}
