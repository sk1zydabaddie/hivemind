import assert from "node:assert/strict";
import { createSpec, ratifySpec } from "../../src/spec.js";

export async function createRatifiedSpec(repo: string, specId = "S-001"): Promise<void> {
  const created = await createSpec(repo, specId, "Test spec");
  assert.equal(created.ok, true);
  const ratified = await ratifySpec(repo, specId);
  assert.equal(ratified.ok, true);
}
