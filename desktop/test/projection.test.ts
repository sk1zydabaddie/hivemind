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
    expect(rows[0].state).toBe("verified");
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
    expect(state.tasks["T-ADOPT"].state).toBe("verified");
    applyEventMessage(state, {
      kind: "event",
      source: "history",
      event: makeEvent("adoption.completed", null, {
        task_ids: ["T-ADOPT"],
        pre_adoption_ref: "a".repeat(40),
        adopted_ref: "b".repeat(40)
      })
    });
    expect(state.tasks["T-ADOPT"].state).toBe("merged");
    expect(state.integration.status).toBe("merged");
    expect(state.integration.lastEvent?.type).toBe("adoption.completed");
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
      makeEvent("task.scouting_started", "T-005", { tool: "codex-scout" }),
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

  test("adoption failure and indeterminacy retract the verified claim and are never silent", () => {
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
    expect(replay(verified).tasks["T-001"].state).toBe("verified");

    for (const [type, status] of [
      ["adoption.failed", "adoption failed"],
      ["adoption.indeterminate", "adoption indeterminate"],
      ["verification.rerun_failed", "recheck failed"]
    ] as const) {
      const state = replay([...verified, makeEvent(type, null, { task_ids: ["T-001"], reason: "fixture" })]);
      expect(state.tasks["T-001"].state).not.toBe("verified");
      expect(state.tasks["T-001"].state).not.toBe("merged");
      expect(state.tasks["T-001"].integration).toBe(status);
      expect(state.tasks["T-001"].issue).toBe("fixture");
      expect(state.integration.status).toBe(status);
    }

    // A successful adoption still reads merged.
    const merged = replay([
      ...verified,
      makeEvent("adoption.completed", null, { task_ids: ["T-001"], pre_adoption_ref: "a".repeat(40), adopted_ref: "b".repeat(40) })
    ]);
    expect(merged.tasks["T-001"].state).toBe("merged");
  });

  test("a verified task is retracted when the durable trail stops backing it", () => {
    // Mirrors Core's integratedTaskIdsFromEvents. The Work tab used to latch on
    // verified and never let go, disagreeing with `hivemind status`.
    const replay = (events: ReturnType<typeof makeEvent>[]) => {
      const state = createBoardProjection();
      for (const event of events) {
        applyEventMessage(state, { kind: "event", source: "history", event });
      }
      return state;
    };
    const submitted = makeEvent("patch.submitted", "T-001", { changed_files: 2 });
    const accepted = makeEvent("patch.accepted", "T-001", { verdict: "accept", reason: "in scope" });
    const passed = makeEvent("integration.passed", null, { applied: ["T-001"], tests: "pass" });

    const bare = replay([makeEvent("task.created", "T-001", { title: "Ledger" }), passed]);
    expect(bare.tasks["T-001"].state).not.toBe("verified");

    const verified = replay([submitted, accepted, passed]);
    expect(verified.tasks["T-001"].state).toBe("verified");

    const failed = replay([
      submitted,
      accepted,
      passed,
      makeEvent("integration.failed", null, { applied: ["T-001"], tests: "fail" })
    ]);
    expect(failed.tasks["T-001"].state).not.toBe("verified");
    expect(failed.tasks["T-001"].integration).toBe("failed");

    const blocked = replay([
      submitted,
      accepted,
      passed,
      makeEvent("integration.blocked", null, { applied: ["T-001"], tests: "blocked" })
    ]);
    expect(blocked.tasks["T-001"].state).not.toBe("verified");

    const superseded = replay([submitted, accepted, passed, submitted]);
    expect(superseded.tasks["T-001"].state).not.toBe("verified");
    expect(superseded.tasks["T-001"].patch.verdict).toBeNull();

    const rejected = replay([
      submitted,
      accepted,
      passed,
      submitted,
      makeEvent("patch.rejected", "T-001", { verdict: "reject", reason: "out of scope" }),
      passed
    ]);
    expect(rejected.tasks["T-001"].state).not.toBe("verified");
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
