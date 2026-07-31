import assert from "node:assert/strict";
import test from "node:test";

import { terminateProcessTreeAndVerify } from "../src/process-control.js";

test("an uncooperative worker escalates from SIGTERM to SIGKILL before death is accepted", async () => {
  const signals: NodeJS.Signals[] = [];
  let killed = false;
  const result = await terminateProcessTreeAndVerify(
    { pid: 42, process_instance_id: "test-worker" },
    {
      platform: "linux",
      gracefulMs: 0,
      forcedMs: 0,
      probeLiveness: () => killed ? "dead" : "alive",
      sendSignal: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") killed = true;
        return { ok: true, reason: `${signal} sent` };
      }
    }
  );

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.status, "dead");
});

test("termination timeout and ambiguous liveness never claim worker death", async () => {
  const started = Date.now();
  const result = await terminateProcessTreeAndVerify(
    { pid: 42, process_instance_id: "test-worker" },
    {
      platform: "linux",
      gracefulMs: 0,
      forcedMs: 0,
      probeLiveness: () => "unknown",
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
