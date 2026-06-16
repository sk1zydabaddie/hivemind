import assert from "node:assert/strict";
import { markIdeationConvergence, recordIdeationRound, startIdeationSession } from "../../src/ideation.js";
import { ratifySpec } from "../../src/spec.js";

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
  const userConverged = await markIdeationConvergence(repo, specId, "user");
  assert.equal(userConverged.ok, true);
  const ratified = await ratifySpec(repo, specId);
  assert.equal(ratified.ok, true);
}
