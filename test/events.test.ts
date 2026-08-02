import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";

test("appendEvent writes newline-delimited JSON and preserves existing events", async () => {
  await withTempRepo(async (repo) => {
    const first = await appendEvent(repo, {
      type: "task.created",
      task_id: "T-001",
      data: { title: "First task" }
    });
    const second = await appendEvent(repo, {
      type: "patch.accepted",
      task_id: "T-001",
      data: { verdict: "accept", reason: "all changes are within scope" }
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);

    const raw = await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, "task.created");
    assert.equal(JSON.parse(lines[1]).type, "patch.accepted");

    const parsed = await readEvents(repo);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.deepEqual(
      parsed.value.map((event) => event.type),
      ["task.created", "patch.accepted"]
    );
    assert.equal(Date.parse(parsed.value[0].ts) > 0, true);
  });
});

test("appendEvent creates the log file when missing", async () => {
  await withTempRepo(async (repo) => {
    const result = await appendEvent(repo, {
      type: "integration.passed",
      task_id: null,
      data: { applied: ["T-001"], tests: "pass" }
    });

    assert.equal(result.ok, true);
    assert.match(await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8"), /integration\.passed/);
  });
});

test("concurrent event writers produce complete parseable lines with no loss", async () => {
  await withTempRepo(async (repo) => {
    const writerCount = 128;
    const payload = "x".repeat(8_192);
    const results = await Promise.all(
      Array.from({ length: writerCount }, (_, index) =>
        appendEvent(repo, {
          type: "task.started",
          task_id: `T-EVENT-${String(index).padStart(3, "0")}`,
          data: { index, payload }
        })
      )
    );

    assert.equal(results.every((result) => result.ok), true);
    const raw = await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8");
    assert.equal(raw.endsWith("\n"), true);
    const lines = raw.split("\n").filter((line) => line !== "");
    assert.equal(lines.length, writerCount);
    const parsed = lines.map((line) => JSON.parse(line) as { data: { index: number; payload: string } });
    assert.deepEqual(
      parsed.map((event) => event.data.index).sort((left, right) => left - right),
      Array.from({ length: writerCount }, (_, index) => index)
    );
    assert.equal(parsed.every((event) => event.data.payload === payload), true);
  });
});

test("concurrent task subsequences retain their invocation order", async () => {
  await withTempRepo(async (repo) => {
    const taskCount = 8;
    const eventsPerTask = 20;
    await Promise.all(
      Array.from({ length: taskCount }, async (_, taskIndex) => {
        const taskId = `T-ORDER-${taskIndex}`;
        for (let sequence = 0; sequence < eventsPerTask; sequence += 1) {
          const appended = await appendEvent(repo, {
            type: "task.checkpointed",
            task_id: taskId,
            data: { sequence }
          });
          assert.equal(appended.ok, true);
        }
      })
    );

    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) return;
    for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
      const taskId = `T-ORDER-${taskIndex}`;
      assert.deepEqual(
        events.value.filter((event) => event.task_id === taskId).map((event) => event.data.sequence),
        Array.from({ length: eventsPerTask }, (_, sequence) => sequence)
      );
    }
  });
});

test("readEvents detects a torn trailing event line even when its JSON is otherwise complete", async () => {
  await withTempRepo(async (repo) => {
    const appended = await appendEvent(repo, {
      type: "task.created",
      task_id: "T-TORN",
      data: { complete: true }
    });
    assert.equal(appended.ok, true);
    await appendFile(
      path.join(repo, ".hivemind", "log", "events.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), type: "task.started", task_id: "T-TORN", data: {} }),
      "utf8"
    );

    const events = await readEvents(repo);
    assert.deepEqual(events, { ok: false, reason: "events.jsonl ends with an incomplete event line" });
  });
});

test("appendEvent rejects invalid event shape before writing", async () => {
  await withTempRepo(async (repo) => {
    await mkdir(path.join(repo, ".hivemind", "log"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "existing\n");

    const invalidType = await appendEvent(repo, {
      type: "not.an.event",
      task_id: "T-001",
      data: {}
    } as unknown as Parameters<typeof appendEvent>[1]);
    const invalidTask = await appendEvent(repo, {
      type: "task.created",
      task_id: "../evil",
      data: {}
    });
    const invalidData = await appendEvent(repo, {
      type: "task.created",
      task_id: "T-001",
      data: 7
    } as unknown as Parameters<typeof appendEvent>[1]);

    assert.equal(invalidType.ok, false);
    assert.equal(invalidTask.ok, false);
    assert.equal(invalidData.ok, false);
    assert.equal(await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8"), "existing\n");
  });
});

async function withTempRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-events-test-"));
  try {
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}
