import { describe, expect, test } from "vitest";

import { plainActionError } from "../src/lib/plain-language";

describe("plain action errors", () => {
  test("surfaces an independent-check plan refusal as a recoverable no-work-started state", () => {
    expect(
      plainActionError(
        "SKELETON_TRAP_ACCEPTANCE: task T-002 deterministic_validity_check must be independent of required_tests"
      )
    ).toBe(
      "The proposed plan was stopped because its contract check duplicated a worker-owned test. No work started. Retry planning to produce an independent check."
    );
  });
});
