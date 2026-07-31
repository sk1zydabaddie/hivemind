import assert from "node:assert/strict";
import test from "node:test";

import { getProcessLiveness } from "../src/process-liveness.js";

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
