import assert from "node:assert/strict";
import test from "node:test";

import { createCachedProcessLivenessProbe, getProcessLiveness } from "../src/process-liveness.js";

test("PL-1 process liveness cases stay fail-closed", () => {
  const error = (code: string): Error & { code: string } =>
    Object.assign(new Error(code), { code });

  assert.equal(getProcessLiveness(101, () => undefined), "alive");
  assert.equal(
    getProcessLiveness(102, () => {
      throw error("ESRCH");
    }),
    "dead"
  );
  assert.equal(
    getProcessLiveness(103, () => {
      throw error("EPERM");
    }),
    "unknown"
  );
  assert.equal(
    getProcessLiveness(104, () => {
      throw error("EACCES");
    }),
    "unknown"
  );
  assert.equal(getProcessLiveness(undefined), "unknown");
  assert.equal(getProcessLiveness(Number.NaN), "unknown");
  assert.equal(getProcessLiveness(0), "unknown");
});

test("a startup liveness snapshot probes each worker pid only once", () => {
  const calls = new Map<number, number>();
  const cached = createCachedProcessLivenessProbe((pid) => {
    calls.set(pid, (calls.get(pid) ?? 0) + 1);
    return pid === 201 ? "dead" : "unknown";
  });

  assert.equal(cached(201), "dead");
  assert.equal(cached(202), "unknown");
  assert.equal(cached(201), "dead");
  assert.equal(cached(202), "unknown");
  assert.deepEqual([...calls.entries()], [[201, 1], [202, 1]]);
});
