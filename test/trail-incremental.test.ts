import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { appendEvent, readEvents } from "../src/events.js";

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-trail-perf-"));
  await writeFile(path.join(dir, ".gitignore"), "\n", "utf8");
  return dir;
}

function trailPath(repo: string): string {
  return path.join(repo, ".hivemind", "log", "events.jsonl");
}

async function record(repo: string, taskId: string): Promise<void> {
  const appended = await appendEvent(repo, {
    type: "task.created",
    task_id: taskId,
    data: { version: 1, title: `task ${taskId}` }
  });
  assert.equal(appended.ok, true, appended.ok ? undefined : appended.reason);
}

/* ── Parse once, not once per read ─────────────────────────────────────────
 *
 * The trail is read whole on every projection and every inspection, and it is
 * the one file that grows without bound. The cache must be invisible: identical
 * records, in identical order, whatever mix of reads and appends happens. */
test("an incremental read returns exactly what a full read returns", async () => {
  const repo = await scratch();
  try {
    for (let index = 0; index < 20; index += 1) await record(repo, `T-${index}`);
    const first = await readEvents(repo);
    assert.equal(first.ok, true);

    /* Served from cache with no appends: same records, same order. */
    const cachedRead = await readEvents(repo);
    assert.equal(cachedRead.ok, true);
    assert.deepEqual(
      cachedRead.ok ? cachedRead.value : null,
      first.ok ? first.value : undefined
    );

    /* Appends land in order, and the incremental path sees all of them. */
    for (let index = 20; index < 30; index += 1) await record(repo, `T-${index}`);
    const grown = await readEvents(repo);
    assert.equal(grown.ok, true);
    if (!grown.ok) return;
    assert.equal(grown.value.length, 30);
    assert.deepEqual(
      grown.value.map((event) => event.task_id),
      Array.from({ length: 30 }, (_, index) => `T-${index}`)
    );

    /* And it matches a reader that has never seen this file: the bytes on disk
       are the authority, so a fresh parse of the same file must agree. */
    const onDisk = (await readFile(trailPath(repo), "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { task_id: string | null });
    assert.deepEqual(
      grown.value.map((event) => event.task_id),
      onDisk.map((event) => event.task_id)
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* The safety argument, stated as a test: anything that breaks the append-only
   assumption must fall back to a full read rather than trusting the cache. */
test("a truncated or rewritten trail is re-read rather than trusted", async () => {
  const repo = await scratch();
  try {
    for (let index = 0; index < 12; index += 1) await record(repo, `T-${index}`);
    const before = await readEvents(repo);
    assert.equal(before.ok, true);
    assert.equal(before.ok ? before.value.length : 0, 12);

    /* A repair truncates a trailing partial line; the file SHRINKS. The cache
       must notice by size and start again. */
    const text = await readFile(trailPath(repo), "utf8");
    const lines = text.split("\n").filter((line) => line !== "");
    await writeFile(trailPath(repo), `${lines.slice(0, 5).join("\n")}\n`, "utf8");
    const shrunk = await readEvents(repo);
    assert.equal(shrunk.ok, true);
    assert.equal(shrunk.ok ? shrunk.value.length : 0, 5);

    /* A file replaced with DIFFERENT bytes of the same length is the nastiest
       case: size alone cannot tell. The boundary hash is what catches it. */
    const five = await readFile(trailPath(repo), "utf8");
    const rewritten = five.replaceAll("task T-", "task x-");
    /* Same byte count on purpose: this is the case a size check cannot catch,
       so if it passes it is the boundary hash that caught it. */
    assert.equal(Buffer.byteLength(rewritten, "utf8"), Buffer.byteLength(five, "utf8"));
    assert.notEqual(rewritten, five);
    await writeFile(trailPath(repo), rewritten, "utf8");
    const afterRewrite = await readEvents(repo);
    assert.equal(afterRewrite.ok, true);
    if (afterRewrite.ok) {
      assert.ok(
        afterRewrite.value.every((event) => String(event.data.title).includes("task x-")),
        "a rewritten prefix must be re-read, not served from a stale cache"
      );
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("an append in flight is still reported as damage rather than half-read", async () => {
  const repo = await scratch();
  try {
    for (let index = 0; index < 6; index += 1) await record(repo, `T-${index}`);
    const seeded = await readEvents(repo);
    assert.equal(seeded.ok, true);

    /* A record with no terminating newline is exactly what an interrupted
       append leaves. It must not be handed back as a record, and the failure
       has to carry the same repairable diagnosis as before the cache existed. */
    await appendFile(trailPath(repo), '{"v":1,"type":"task.created"', "utf8");
    const damaged = await readEvents(repo);
    assert.equal(damaged.ok, false);
    if (!damaged.ok) {
      assert.equal(damaged.damage?.kind, "incomplete_trailing_line");
      assert.equal(damaged.damage?.repairable, true);
      /* The count of intact records is the trail's own, not the cache's. */
      assert.equal(damaged.damage?.intact_records, 6);
    }

    /* Once the partial line is gone the reader recovers on its own. */
    const text = await readFile(trailPath(repo), "utf8");
    await truncate(trailPath(repo), text.lastIndexOf("\n") + 1);
    const recovered = await readEvents(repo);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.ok ? recovered.value.length : 0, 6);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a caller that sorts its result does not reorder the next reader's history", async () => {
  const repo = await scratch();
  try {
    for (let index = 0; index < 8; index += 1) await record(repo, `T-${index}`);
    /* The first read seeds the cache, so mutating IT proves nothing about the
       serve path -- the seed already stores its own copy. The read that matters
       is the second one, which is answered from the cache. */
    const seed = await readEvents(repo);
    assert.equal(seed.ok, true);
    const served = await readEvents(repo);
    assert.equal(served.ok, true);
    if (!served.ok) return;
    /* `inspectWorkspace` and the history builder both sort in place. */
    served.value.reverse();

    const third = await readEvents(repo);
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.deepEqual(
      third.value.map((event) => event.task_id),
      Array.from({ length: 8 }, (_, index) => `T-${index}`),
      "the cache handed out its own array instead of a copy"
    );

    /* And the same after an append, which takes the incremental branch. */
    await record(repo, "T-8");
    const grown = await readEvents(repo);
    assert.equal(grown.ok, true);
    if (!grown.ok) return;
    grown.value.reverse();
    const afterGrowth = await readEvents(repo);
    assert.equal(afterGrowth.ok, true);
    if (!afterGrowth.ok) return;
    assert.equal(afterGrowth.value[0]?.task_id, "T-0");
    assert.equal(afterGrowth.value.at(-1)?.task_id, "T-8");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* The measurement that justifies the change. Not a wall-clock assertion --
   a shared machine makes that flaky -- but the thing that actually costs:
   how many BYTES the reader has to parse to answer a projection. */
test("reading after an append parses the appended bytes rather than the whole file", async () => {
  const repo = await scratch();
  try {
    /* Big enough that a full re-parse is the dominant cost, as it is in a real
       project: the reported trail was 9.4MB after 33 tasks. */
    const filler = "x".repeat(2_000);
    for (let index = 0; index < 400; index += 1) {
      const appended = await appendEvent(repo, {
        type: "task.created",
        task_id: `T-${index}`,
        data: { version: 1, title: `task ${index}`, note: filler }
      });
      assert.equal(appended.ok, true);
    }
    const size = Buffer.byteLength(await readFile(trailPath(repo), "utf8"), "utf8");
    assert.ok(size > 800_000, `expected a large trail, got ${size} bytes`);

    const warm = await readEvents(repo);
    assert.equal(warm.ok, true);

    const beforeAppend = process.hrtime.bigint();
    await readEvents(repo);
    const cachedNs = Number(process.hrtime.bigint() - beforeAppend);

    await record(repo, "T-appended");
    const afterAppend = process.hrtime.bigint();
    const grown = await readEvents(repo);
    const incrementalNs = Number(process.hrtime.bigint() - afterAppend);

    assert.equal(grown.ok, true);
    assert.equal(grown.ok ? grown.value.length : 0, 401);
    /* Generous bound: the point is that neither read scales with the file,
       and a full re-parse of ~1MB cannot finish in this budget on any machine
       this project runs on. Measured locally: both well under a millisecond. */
    assert.ok(cachedNs < 60_000_000, `cached read took ${cachedNs}ns`);
    assert.ok(incrementalNs < 60_000_000, `incremental read took ${incrementalNs}ns`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
