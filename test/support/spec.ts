import assert from "node:assert/strict";
import { markIdeationConvergence, recordIdeationRound, startIdeationSession } from "../../src/ideation.js";
import { ratifySpec } from "../../src/spec.js";
import { requestUserConvergence } from "../../src/spec-convergence.js";

export async function createRatifiedSpec(repo: string, specId = "S-001"): Promise<void> {
  const created = await startIdeationSession(repo, specId, "Test spec", "Test goal");
  assert.equal(created.ok, true);
  const round = await recordIdeationRound(repo, specId, {
    alternatives: [
      { title: "Minimal", tradeoffs: ["Small scope"] },
      { title: "Complete", tradeoffs: ["More coverage"] }
    ],
    self_critique: {
      weakest_point: "The fixture is intentionally thin.",
      cut_or_change: "Keep only deterministic test setup."
    },
    spec_updates: {
      "Non-goals": "No production behavior beyond the test fixture.",
      "Open questions": ""
    },
    substantive_change: true,
    orchestrator_calls_convergence: true
  });
  assert.equal(round.ok, true);
  /* Fixtures sign the way a person does: take out an authorization against the
     document as it stands, then spend it. There is no shortcut for tests
     either, which is the point. */
  const authorization = await requestUserConvergence(repo, specId, "test-fixture");
  assert.equal(authorization.ok, true);
  if (!authorization.ok) return;
  const userConverged = await markIdeationConvergence(repo, specId, "user", authorization.value);
  assert.equal(userConverged.ok, true);
  const ratified = await ratifySpec(repo, specId);
  assert.equal(ratified.ok, true);
}
