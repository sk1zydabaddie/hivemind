import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { terminateProcessTreeAndVerify } from "../src/process-control.js";
import { getProcessGroupLiveness, getProcessLiveness } from "../src/process-liveness.js";

const posixOnly = { skip: process.platform === "win32" ? "POSIX process groups do not exist on Windows" : false };

test("an uncooperative worker escalates from SIGTERM to SIGKILL, signalling the whole group", async () => {
  const signalled: Array<{ target: number; signal: NodeJS.Signals }> = [];
  let killed = false;
  const result = await terminateProcessTreeAndVerify(
    { pid: 42, process_instance_id: "test-worker", process_group_id: 42 },
    {
      platform: "linux",
      gracefulMs: 0,
      forcedMs: 0,
      probeGroupLiveness: () => killed ? "dead" : "alive",
      sendSignal: (pid, signal) => {
        signalled.push({ target: pid, signal });
        if (signal === "SIGKILL") killed = true;
        return { ok: true, reason: `${signal} sent` };
      }
    }
  );

  assert.deepEqual(signalled.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  // Negative pid is the group. A positive one would reach only the named
  // process and leave the agent CLI's own children running.
  assert.deepEqual(signalled.map((entry) => entry.target), [-42, -42]);
  assert.equal(result.status, "dead");
});

test("a POSIX worker with no recorded process group is never reported dead", async () => {
  // The pid itself is definitively absent, which under the old code was the
  // whole proof. It says nothing about the orphans that outlived it, so the
  // stop must refuse and reclaim nothing.
  const result = await terminateProcessTreeAndVerify(
    { pid: 42, process_instance_id: "test-worker", process_group_id: null },
    { platform: "linux", probeLiveness: () => "dead" }
  );

  assert.equal(result.status, "not_proven_dead");
  assert.equal(result.liveness, "unknown");
  assert.match(result.reason, /no recorded process group/u);
  assert.match(result.reason, /cannot be proven dead/u);
});

test("a dead root process does not prove a live group dead", async () => {
  // The exact shape of the defect: the named pid is gone, descendants are not.
  const result = await terminateProcessTreeAndVerify(
    { pid: 42, process_instance_id: "test-worker", process_group_id: 42 },
    {
      platform: "linux",
      gracefulMs: 0,
      forcedMs: 0,
      probeLiveness: () => "dead",
      probeGroupLiveness: () => "alive",
      sendSignal: () => ({ ok: true, reason: "signal accepted" })
    }
  );

  assert.equal(result.status, "not_proven_dead");
  assert.equal(result.liveness, "alive");
});

test("termination timeout and ambiguous group liveness never claim worker death", async () => {
  const started = Date.now();
  const result = await terminateProcessTreeAndVerify(
    { pid: 42, process_instance_id: "test-worker", process_group_id: 42 },
    {
      platform: "linux",
      gracefulMs: 0,
      forcedMs: 0,
      probeGroupLiveness: () => "unknown",
      sendSignal: () => ({ ok: true, reason: "signal accepted" })
    }
  );

  assert.equal(result.status, "not_proven_dead");
  assert.equal(result.liveness, "unknown");
  assert.match(result.reason, /not proven/u);
  assert.ok(Date.now() - started < 500, "the stop attempt must remain bounded");
});

test("Windows taskkill is awaited and its result is verified through PL-1", async () => {
  let taskkillFinished = false;
  let dead = false;
  const result = await terminateProcessTreeAndVerify(
    { pid: 42, process_instance_id: "test-worker" },
    {
      platform: "win32",
      forcedMs: 0,
      probeLiveness: () => dead ? "dead" : "alive",
      runWindowsTaskkill: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        taskkillFinished = true;
        dead = true;
        return { ok: true, reason: "taskkill exited zero" };
      }
    }
  );

  assert.equal(taskkillFinished, true);
  assert.equal(result.status, "dead");
});

test("Windows still terminates the tree without a process group, because taskkill /t is the tree primitive", async () => {
  let args: string[] = [];
  let dead = false;
  const result = await terminateProcessTreeAndVerify(
    { pid: 42, process_instance_id: "test-worker", process_group_id: null },
    {
      platform: "win32",
      forcedMs: 0,
      probeLiveness: () => dead ? "dead" : "alive",
      runWindowsTaskkill: async (pid) => {
        args = ["/pid", String(pid), "/t", "/f"];
        dead = true;
        return { ok: true, reason: "taskkill exited zero" };
      }
    }
  );

  assert.deepEqual(args, ["/pid", "42", "/t", "/f"]);
  assert.equal(result.status, "dead");
});

test("a worker crash racing taskkill is accepted only after PL-1 proves death", async () => {
  let dead = false;
  const result = await terminateProcessTreeAndVerify(
    { pid: 42, process_instance_id: "test-worker" },
    {
      platform: "win32",
      probeLiveness: () => dead ? "dead" : "alive",
      runWindowsTaskkill: async () => {
        dead = true;
        return { ok: false, reason: "taskkill found no running instance" };
      }
    }
  );

  assert.equal(result.status, "dead");
  assert.equal(result.liveness, "dead");
  assert.match(result.reason, /definitively absent/u);
});

test("group liveness answers about the group, not one member", posixOnly, () => {
  assert.equal(getProcessGroupLiveness(null), "unknown");
  assert.equal(getProcessGroupLiveness(0), "unknown");
  assert.equal(getProcessGroupLiveness(-1), "unknown");
  // This process's own group certainly exists.
  assert.equal(getProcessGroupLiveness(process.pid, () => undefined), "alive");
  assert.equal(
    getProcessGroupLiveness(123456, () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }),
    "dead"
  );
  // Exists but is not ours to signal. Present is present.
  assert.equal(
    getProcessGroupLiveness(123456, () => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    }),
    "alive"
  );
});

/**
 * The real thing, on a real kernel.
 *
 * A worker whose child spawns grandchildren must have ALL of them dead before
 * the lease is released. Everything above this point uses injected probes and
 * would pass against a single-pid kill; this one spawns actual processes and
 * asks the kernel.
 */
test("every grandchild of a worker is dead before termination reports success", posixOnly, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-tree-kill-"));
  const pidFile = path.join(dir, "grandchildren.json");
  const workerScript = path.join(dir, "worker.mjs");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // Stands in for an agent CLI that shells out: it spawns children of its
    // own and then keeps running. The grandchildren ignore SIGTERM, so only a
    // group SIGKILL removes them.
    await writeFile(
      workerScript,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const pids = [];",
        "for (let i = 0; i < 3; i += 1) {",
        "  const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1e9);\"], { stdio: 'ignore' });",
        "  pids.push(grandchild.pid);",
        "}",
        `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(pids));`,
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1e9);"
      ].join("\n"),
      "utf8"
    );

    child = spawn(process.execPath, [workerScript], { cwd: dir, detached: true, stdio: "ignore" });
    const workerPid = child.pid;
    assert.ok(workerPid !== undefined, "the worker did not start");

    const grandchildren = await waitForPids(pidFile);
    assert.equal(grandchildren.length, 3);
    for (const pid of grandchildren) {
      assert.equal(getProcessLiveness(pid), "alive", `grandchild ${pid} did not start`);
    }
    // Grandchildren are in the worker's group because setsid() applies to the
    // whole subtree it starts. That is what makes one signal enough.
    assert.equal(getProcessGroupLiveness(workerPid), "alive");

    const result = await terminateProcessTreeAndVerify({
      pid: workerPid,
      process_instance_id: "real-worker",
      process_group_id: workerPid
    });

    assert.equal(result.status, "dead", result.reason);
    assert.equal(result.liveness, "dead");
    assert.match(result.reason, /no descendant survives/u);

    // The claim under test: not "the root is gone" but "nothing is left".
    for (const pid of grandchildren) {
      assert.equal(
        getProcessLiveness(pid),
        "dead",
        `grandchild ${pid} outlived a termination that reported success`
      );
    }
    assert.equal(getProcessGroupLiveness(workerPid), "dead");
  } finally {
    if (child?.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone, which is the expected outcome of the test body.
      }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function waitForPids(pidFile: string): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    try {
      const parsed = JSON.parse(await readFile(pidFile, "utf8")) as number[];
      if (Array.isArray(parsed) && parsed.every((pid) => Number.isSafeInteger(pid))) {
        return parsed;
      }
    } catch {
      // Not written yet, or written partially. Both resolve by waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the worker never recorded its grandchildren");
}
