import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ACTIVITY_STREAM_ID,
  appendTaskOutput,
  setTaskOutputPublisher,
  type TaskOutputRecord
} from "../src/output-stream.js";

const run = promisify(execFile);

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-publish-"));
  await run("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/* ── The break this closes ─────────────────────────────────────────────────
 *
 * The publisher was threaded through one action: the daemon handed `onOutput` to
 * the RUN path, which called it after appending. So worker output reached
 * subscribers and every other writer -- drafting, and anything added later --
 * wrote to disk and told nobody. The records were on disk, so the file looked
 * right; they only reached a client on the NEXT subscribe, as history. A live
 * surface stayed empty for the whole call.
 *
 * Attaching it to the write is the fix, and this is the test that makes the old
 * shape impossible: it asserts that appending REACHES a subscriber, for a writer
 * that is not the run path.
 *
 * Proven to bite: remove the `publisher?.(record)` call and both cases fail.
 */
test("appending task output reaches a subscriber, whoever appended it", async () => {
  const dir = await project();
  const seen: TaskOutputRecord[] = [];
  setTaskOutputPublisher((record) => seen.push(record));
  try {
    const appended = await appendTaskOutput(dir, {
      task_id: ACTIVITY_STREAM_ID,
      tool: "planner",
      stream: "stdout",
      text: '{"type":"turn.started"}\n'
    });
    assert.equal(appended.ok, true, appended.ok ? undefined : appended.reason);
    assert.equal(seen.length, 1, "the write did not reach a subscriber");
    assert.equal(seen[0]?.task_id, ACTIVITY_STREAM_ID);
    /* And it carries the readable account, which is what a surface renders. */
    assert.equal(seen[0]?.activity, "Thinking");
  } finally {
    setTaskOutputPublisher(null);
    await rm(dir, { recursive: true, force: true });
  }
});

/* One line, one delivery. The run path used to publish as well, so registering
   at the write without removing that would have delivered every worker line
   twice -- and a doubled transcript is a different lie about what happened. */
test("a line is delivered once, not once per publisher", async () => {
  const dir = await project();
  const seen: TaskOutputRecord[] = [];
  setTaskOutputPublisher((record) => seen.push(record));
  try {
    await appendTaskOutput(dir, {
      task_id: "T-001",
      tool: "worker",
      stream: "stdout",
      text: '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}\n'
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.activity, "Running npm test");
  } finally {
    setTaskOutputPublisher(null);
    await rm(dir, { recursive: true, force: true });
  }
});

/* With nobody registered, appending still works. A daemon-less path (the CLI)
   writes the same records and must not depend on a subscriber existing. */
test("appending works with no publisher registered", async () => {
  const dir = await project();
  setTaskOutputPublisher(null);
  try {
    const appended = await appendTaskOutput(dir, {
      task_id: "T-002",
      tool: "worker",
      stream: "stdout",
      text: "plain text\n"
    });
    assert.equal(appended.ok, true, appended.ok ? undefined : appended.reason);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
