import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent, readEvents, repairEventTrail } from "../src/events.js";
import { repairTrail } from "../src/jsonl-trail.js";
import { appendTaskOutput, readTaskOutput, repairTaskOutput } from "../src/output-stream.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);

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
    assert.equal(events.ok, false);
    if (events.ok) return;
    // The reason is no longer a bare sentence: a damaged trail is otherwise
    // terminal for 69 call sites, so the refusal has to carry where the damage
    // is, what is still intact, and the way out.
    assert.equal(events.damage?.kind, "incomplete_trailing_line");
    assert.equal(events.damage?.repairable, true);
    assert.equal(events.damage?.line, 2);
    assert.equal(events.damage?.intact_records, 1);
    assert.match(events.reason, /\.hivemind\/log\/events\.jsonl line 2/u);
    assert.match(events.reason, /1 record before it are intact/u);
    assert.match(events.reason, /hivemind events repair/u);
  });
});

test("appends from separate processes never interleave, at a size that provably tears without the lock", async () => {
  await withTempRepo(async (repo) => {
    // MEASURED, not assumed. The interleaving hazard is not PIPE_BUF -- that
    // governs pipes, not regular files, and a single write() to a regular file
    // is serialised by both the Linux inode lock and Windows FILE_APPEND_DATA.
    // The real hazard is Node chunking a large buffer into several write()
    // calls that another process can land between. Probed on this platform:
    //
    //   131072 B clean   262144 B clean   524288 B TORE   2097152 B TORE
    //
    // (12 processes x 20 appends; at 524288 the pre-fix path produced 128
    // unparseable lines of 240.) So the payload here is deliberately past that
    // threshold: a regression test that passes with and against the fix is
    // worthless, and at the sizes today's callers produce -- events capped
    // near 40KB, stdout chunks bounded by the pipe high-water mark -- nothing
    // tears, so a realistic payload would prove nothing.
    //
    // The lock is what makes that threshold irrelevant instead of load-bearing.
    const writers = 6;
    const perWriter = 4;
    const payloadBytes = 600_000;
    const eventsModule = pathToFileURL(path.resolve("dist/src/events.js")).href;
    const child = [
      `const { appendEvent } = await import(${JSON.stringify(eventsModule)});`,
      // `node -e` leaves argv as [execPath, ...args] with no script slot.
      "const [repo, writer, count, size] = process.argv.slice(1);",
      "for (let i = 0; i < Number(count); i += 1) {",
      "  const appended = await appendEvent(repo, {",
      "    type: 'human.guidance_recorded',",
      "    task_id: null,",
      "    data: { writer, index: i, message: `${writer}:${i}:`.padEnd(Number(size), 'x') }",
      "  });",
      "  if (!appended.ok) { console.error(appended.reason); process.exit(1); }",
      "}"
    ].join("\n");

    await Promise.all(
      Array.from({ length: writers }, (_, index) =>
        execFileAsync(
          process.execPath,
          ["--input-type=module", "-e", child, repo, `w${index}`, String(perWriter), String(payloadBytes)],
          { windowsHide: true, maxBuffer: 1024 * 1024 * 8 }
        )
      )
    );

    const raw = await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8");
    assert.equal(raw.endsWith("\n"), true);
    const lines = raw.split("\n").filter((line) => line !== "");
    assert.equal(lines.length, writers * perWriter, "an append was lost or split across lines");

    const seen = new Set<string>();
    for (const [index, line] of lines.entries()) {
      let parsed: { data: { writer: string; index: number; message: string } };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        assert.fail(`line ${index + 1} is not parseable JSON: ${line.slice(0, 120)}...`);
      }
      // A torn line sometimes still parses if two writes happened to nest, so
      // the payload is checked rather than just the JSON.
      assert.equal(parsed.data.message.length, payloadBytes);
      assert.equal(parsed.data.message.startsWith(`${parsed.data.writer}:${parsed.data.index}:`), true);
      seen.add(`${parsed.data.writer}:${parsed.data.index}`);
    }
    assert.equal(seen.size, writers * perWriter, "a duplicate or corrupted identity appeared");

    const events = await readEvents(repo);
    assert.equal(events.ok, true, events.ok ? undefined : events.reason);
  });
});

test("repair removes an interrupted trailing append, quarantines it, and records what it did", async () => {
  await withTempRepo(async (repo) => {
    const trail = path.join(repo, ".hivemind", "log", "events.jsonl");
    assert.equal((await appendEvent(repo, { type: "task.created", task_id: "T-R", data: { n: 1 } })).ok, true);
    assert.equal((await appendEvent(repo, { type: "task.started", task_id: "T-R", data: { n: 2 } })).ok, true);
    const intact = await readFile(trail, "utf8");
    await appendFile(trail, '{"ts":"2026-08-08T00:00:00.000Z","type":"task.compl', "utf8");

    const repaired = await repairEventTrail(repo);

    assert.equal(repaired.ok, true, repaired.ok ? undefined : repaired.reason);
    if (!repaired.ok || repaired.value === null) return;
    assert.equal(repaired.value.intact_records, 2);
    assert.equal(repaired.value.removed_bytes, 51);

    // The evidence of what went wrong survives the repair.
    const quarantined = await readFile(repaired.value.quarantine_path, "utf8");
    assert.equal(quarantined.startsWith(intact), true);
    assert.match(quarantined, /"type":"task\.compl$/u);

    // The trail reads again, and it can explain its own gap.
    const events = await readEvents(repo);
    assert.equal(events.ok, true, events.ok ? undefined : events.reason);
    if (!events.ok) return;
    assert.deepEqual(events.value.map((event) => event.type), [
      "task.created",
      "task.started",
      "trail.repaired"
    ]);
    const record = events.value.at(-1);
    assert.equal(record?.data.removed_bytes, 51);
    assert.equal(record?.data.intact_records, 2);
    assert.match(String(record?.data.quarantine_path), /^\.hivemind\/log\/events\.jsonl\.damaged-/u);
  });
});

test("repair refuses damage that is not an interrupted append, and changes nothing", async () => {
  await withTempRepo(async (repo) => {
    const trail = path.join(repo, ".hivemind", "log", "events.jsonl");
    assert.equal((await appendEvent(repo, { type: "task.created", task_id: "T-M", data: { n: 1 } })).ok, true);
    assert.equal((await appendEvent(repo, { type: "task.started", task_id: "T-M", data: { n: 2 } })).ok, true);
    // Damage in the MIDDLE. Its bytes may belong to two interleaved writes, so
    // discarding it could discard a record that really happened.
    const lines = (await readFile(trail, "utf8")).split("\n");
    await writeFile(trail, `${lines[0]}\n{"ts":"2026-08-08T00:00:00.000Z","type":"tas\n${lines[1]}\n`, "utf8");
    const before = await readFile(trail, "utf8");

    const read = await readEvents(repo);
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.equal(read.damage?.repairable, false);
    assert.equal(read.damage?.kind, "invalid_json");
    assert.equal(read.damage?.line, 2);
    assert.equal(read.damage?.intact_records, 1);
    assert.match(read.reason, /cannot be repaired automatically/u);
    assert.match(read.reason, /may belong to two interleaved records/u);

    const repaired = await repairEventTrail(repo);
    assert.equal(repaired.ok, false);
    if (!repaired.ok) {
      assert.match(repaired.reason, /refusing to repair/u);
    }
    assert.equal(await readFile(trail, "utf8"), before, "a refused repair modified the trail");
  });
});

test("repair is a no-op on an intact trail and never invents a quarantine file", async () => {
  await withTempRepo(async (repo) => {
    assert.equal((await appendEvent(repo, { type: "task.created", task_id: "T-OK", data: {} })).ok, true);
    const before = await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8");

    const repaired = await repairEventTrail(repo);

    assert.equal(repaired.ok, true, repaired.ok ? undefined : repaired.reason);
    if (repaired.ok) {
      assert.equal(repaired.value, null);
    }
    assert.equal(await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8"), before);
    assert.deepEqual(
      (await readdir(path.join(repo, ".hivemind", "log"))).filter((entry) => entry.includes("damaged")),
      []
    );
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
  await withTemplateRepo(
    "events",
    async (repo) => {

    },
    async (repo) => {
      await run(repo);
    },
    "hivemind-events-test-"
  );
}

test("a task output stream is protected and repaired the same way, and its repair stays out of the worker's mouth", async () => {
  await withTempRepo(async (repo) => {
    const taskId = "T-OUT";
    for (const text of ["first chunk\n", "second chunk\n"]) {
      const appended = await appendTaskOutput(repo, { task_id: taskId, tool: "fixture", stream: "stdout", text });
      assert.equal(appended.ok, true, appended.ok ? undefined : appended.reason);
    }
    const trail = path.join(repo, ".hivemind", "log", "tasks", `${taskId}.output.jsonl`);
    await appendFile(trail, '{"ts":"2026-08-08T00:00:00.000Z","task_id":"T-OUT","tool":"fix', "utf8");

    // Before the repair the whole stream is unreadable, not just the bad line.
    const damaged = await readTaskOutput(repo, taskId);
    assert.equal(damaged.ok, false);
    if (damaged.ok) return;
    assert.equal(damaged.damage?.repairable, true);
    assert.equal(damaged.damage?.intact_records, 2);
    assert.match(damaged.reason, /\.hivemind\/log\/tasks\/T-OUT\.output\.jsonl line 3/u);
    assert.match(damaged.reason, /hivemind events repair --task T-OUT/u);

    const repaired = await repairTaskOutput(repo, taskId);
    assert.equal(repaired.ok, true, repaired.ok ? undefined : repaired.reason);

    const read = await readTaskOutput(repo, taskId);
    assert.equal(read.ok, true, read.ok ? undefined : read.reason);
    if (!read.ok) return;
    // Exactly what the worker printed, and nothing Hivemind added to it. The
    // event trail is where a repair is recorded; a provider's stdout is not.
    assert.deepEqual(read.value.map((record) => record.text), ["first chunk\n", "second chunk\n"]);
  });
});

test("a repair refuses once the writer it raced has finished the line", async () => {
  await withTempRepo(async (repo) => {
    const trail = path.join(repo, ".hivemind", "log", "events.jsonl");
    assert.equal((await appendEvent(repo, { type: "task.created", task_id: "T-RACE", data: {} })).ok, true);
    const partial = JSON.stringify({
      ts: new Date().toISOString(),
      type: "task.started",
      task_id: "T-RACE",
      data: {}
    });
    await appendFile(trail, partial, "utf8");

    const read = await readEvents(repo);
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.equal(read.damage?.repairable, true);

    // The writer completes the line between the diagnosis and the repair --
    // exactly the race a reader cannot distinguish from crash residue. The
    // repair re-checks under the lock rather than truncating on a stale read.
    await appendFile(trail, "\n", "utf8");

    const repaired = await repairTrail(
      trail,
      ".hivemind/log/events.jsonl",
      read.damage!,
      "2026-08-08T00-00-00.000Z"
    );

    assert.equal(repaired.ok, false);
    if (!repaired.ok) {
      assert.match(repaired.reason, /is complete; nothing to repair/u);
    }
    const after = await readEvents(repo);
    assert.equal(after.ok, true, after.ok ? undefined : after.reason);
    if (after.ok) {
      assert.deepEqual(after.value.map((event) => event.type), ["task.created", "task.started"]);
    }
  });
});
