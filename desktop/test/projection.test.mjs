import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyEventMessage,
  applyOutputMessage,
  createBoardProjection,
  leaseRows,
  selectTask,
  taskRows
} from "../app/projection.mjs";

test("projection replays task, lease, patch, and integration events into display state", () => {
  const state = createBoardProjection();
  for (const item of [
    makeEvent("task.created", "T-001", { title: "Create ledger" }),
    makeEvent("lease.approved", "T-001", { granted: ["src/ledger.js", "test/ledger.test.js"] }),
    makeEvent("task.started", "T-001", { tool: "codex-worker", worktree: ".hivemind/worktrees/T-001" }),
    makeEvent("patch.submitted", "T-001", { changed_files: 2 }),
    makeEvent("patch.accepted", "T-001", { verdict: "accept", reason: "all changes within scope" }),
    makeEvent("integration.queued", "T-001", { queue: ["T-001"] }),
    makeEvent("integration.passed", null, { applied: ["T-001"], tests: "pass", report: "4/4" })
  ]) {
    applyEventMessage(state, { kind: "event", source: "history", event: item });
  }

  const rows = taskRows(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "integrated");
  assert.equal(rows[0].patch.submitted, true);
  assert.equal(rows[0].patch.verdict, "accept");
  assert.deepEqual(leaseRows(state), [
    { filePath: "src/ledger.js", taskId: "T-001" },
    { filePath: "test/ledger.test.js", taskId: "T-001" }
  ]);
  assert.equal(state.integration.status, "passed");
});

test("lease release events remove active lease display state", () => {
  const state = createBoardProjection();
  applyEventMessage(state, { kind: "event", source: "history", event: makeEvent("lease.approved", "T-001", { granted: ["src/ledger.js"] }) });
  applyEventMessage(state, { kind: "event", source: "live", event: makeEvent("lease.released", "T-001", { released: ["src/ledger.js"] }) });
  assert.deepEqual(leaseRows(state), []);
  assert.deepEqual(state.tasks["T-001"].lease_files, []);
});

test("task output projection only records the selected task stream", () => {
  const state = createBoardProjection();
  selectTask(state, "T-001");
  applyOutputMessage(state, { kind: "output", source: "live", record: output("T-002", "stdout", "other") });
  applyOutputMessage(state, { kind: "output", source: "live", record: output("T-001", "stdout", "hello") });
  assert.equal(state.selectedOutput.length, 1);
  assert.equal(state.selectedOutput[0].text, "hello");
});

test("desktop shell contains no Hivemind action controls", async () => {
  const html = await readFile(new URL("../app/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /approve|redirect|ratify|integrate|lease request|run worker/i);
});

test("desktop renderer keeps the Swarm Ledger grouped into four phases", async () => {
  const html = await readFile(new URL("../app/index.html", import.meta.url), "utf8");
  const main = await readFile(new URL("../app/main.mjs", import.meta.url), "utf8");
  assert.match(html, /Swarm Ledger/);
  for (const phase of ["Scoped", "Running", "Verified", "Integrated"]) {
    assert.match(main, new RegExp(`label: "${phase}"`));
  }
  assert.doesNotMatch(main, /contract.*lease.*intent.*run.*submit.*analyze.*queue.*integrate/s);
});

function makeEvent(type, task_id, data) {
  return {
    ts: "2026-06-18T00:00:00.000Z",
    type,
    task_id,
    data
  };
}

function output(task_id, stream, text) {
  return {
    ts: "2026-06-18T00:00:00.000Z",
    task_id,
    tool: "codex-worker",
    stream,
    text
  };
}
