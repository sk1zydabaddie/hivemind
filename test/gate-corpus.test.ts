import assert from "node:assert/strict";
import test from "node:test";

import { runGate } from "../src/gate.js";
import { withGateCorpusFixtures } from "./fixtures/gate-corpus.js";

test("runGate satisfies the M1.5 adversarial corpus", async () => {
  await withGateCorpusFixtures(async (fixtures) => {
    assert.deepEqual(
      fixtures.map((fixture) => fixture.name),
      [
        "rename-launder",
        "symlink-escape",
        "dot-dot-path-escape",
        "wrong-base",
        "case-collision",
        "forbidden-file-deletion",
        "mode-bit-flip",
        "happy-path"
      ]
    );

    for (const fixture of fixtures) {
      const result = await runGate(fixture.baseCommit, fixture.patchPath, fixture.contract, fixture.config);

      assert.equal(result.verdict, fixture.expectedVerdict, fixture.name);
      assert.notEqual(result.reason.trim(), "", fixture.name);
      if (fixture.reasonPattern) {
        assert.match(result.reason, fixture.reasonPattern, fixture.name);
      }
    }
  });
});
