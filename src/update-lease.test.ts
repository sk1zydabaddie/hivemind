import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { daemonRequestStartsWork, withUpdateAdmission } from "./update-lease.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("machine-wide update admission", () => {
  test("classifies observations separately from work-starting requests", () => {
    assert.equal(daemonRequestStartsWork("GET", "/events/stream", {}), false);
    assert.equal(daemonRequestStartsWork("POST", "/status", {}), false);
    assert.equal(daemonRequestStartsWork("POST", "/workspace/action", { type: "files.read" }), false);
    assert.equal(daemonRequestStartsWork("POST", "/workspace/action", { type: "conversation.submit" }), true);
    assert.equal(daemonRequestStartsWork("POST", "/run", {}), true);
  });

  test("refuses new work while a durable update lease exists", async () => {
    const root = await fixture();
    const lease = path.join(root, "update-lease.json");
    await writeFile(lease, `${JSON.stringify({ version: 1, nonce: "lease-nonce" })}\n`);
    let called = false;
    const result = await withUpdateAdmission(async () => {
      called = true;
      return { ok: true as const, value: "started" };
    }, lease);
    assert.deepEqual(result, { ok: false, reason: "Hivemind is being updated; new work is paused until the app restarts" });
    assert.equal(called, false);
  });

  test("holds the admission directory until the state-changing operation finishes", async () => {
    const root = await fixture();
    const lease = path.join(root, "update-lease.json");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let admitted!: () => void;
    const ready = new Promise<void>((resolve) => { admitted = resolve; });
    const operation = withUpdateAdmission(async () => {
      assert.equal(JSON.parse(await readFile(`${lease}.admission/owner.json`, "utf8")).pid, process.pid);
      admitted();
      await blocked;
      return { ok: true as const, value: "done" };
    }, lease);
    await ready;
    await assert.rejects(mkdir(`${lease}.admission`), { code: "EEXIST" });
    release();
    assert.deepEqual(await operation, { ok: true, value: "done" });
    assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".candidate-")), []);
    await mkdir(`${lease}.admission`);
  });

  test("fails closed on an unreadable or malformed lease", async () => {
    const root = await fixture();
    const lease = path.join(root, "update-lease.json");
    await writeFile(lease, "{}\n");
    assert.deepEqual(await withUpdateAdmission(async () => ({ ok: true, value: null }), lease), {
      ok: false,
      reason: "the machine-wide update lease is malformed; refusing new work"
    });
  });
});

async function fixture(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "hivemind-update-lease-"));
  fixtures.push(value);
  return value;
}
