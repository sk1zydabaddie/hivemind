import assert from "node:assert/strict";

import { authorizeManualTask, reviewManualTaskForAuthorization } from "../../src/plan.js";

export async function authorizePlanlessManualTaskIfEligible(
  repo: string,
  taskId: string,
  specId = "S-001"
): Promise<void> {
  const review = await reviewManualTaskForAuthorization(repo, specId, taskId);
  if (!review.ok) {
    if (
      /has a tentative plan|already has a ratified plan|must be ratified before planning|is not active/u.test(review.reason)
    ) {
      return;
    }
    assert.fail(review.reason);
  }
  const authorized = await authorizeManualTask(repo, specId, taskId, review.value.contract_hash);
  assert.equal(authorized.ok, true, authorized.ok ? undefined : authorized.reason);
}
