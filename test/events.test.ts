import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
