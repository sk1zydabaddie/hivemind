import { describe, expect, test } from "vitest";

import { trialAffordance, type CheckTrialView } from "../src/lib/workspace-actions";

function trial(overrides: Partial<CheckTrialView>): CheckTrialView {
  return {
    command: "npm test",
    outcome: "failed",
    exit_code: 1,
    duration_ms: 900,
    output_tail: "",
    detail: "",
    stored: false,
    ...overrides
  };
}

/* The reported defect: a field that blocks progress gets filled with whatever
 * unblocks it, and `npm test` in a project with no tests then fails every
 * integration after the money is spent. Core refuses to store a command that
 * never ran; this pins that the screen does not offer to either.
 *
 * Proven to bite: return "accept_or_replace" for any unstored trial and the
 * not_runnable and timed_out cases fail. */
describe("what a trial lets you do next", () => {
  test("a command that never ran has no accept path", () => {
    expect(trialAffordance(trial({ outcome: "not_runnable" }))).toBe("replace_only");
  });

  test("an unfinished run has no accept path either, because the outcome is unknown", () => {
    expect(trialAffordance(trial({ outcome: "timed_out" }))).toBe("replace_only");
  });

  /* A red suite is a real state, so accepting it is a real choice -- made after
     seeing the output, and recorded. */
  test("a command that ran and failed can be accepted", () => {
    expect(trialAffordance(trial({ outcome: "failed" }))).toBe("accept_or_replace");
  });

  test("nothing is offered once it is stored", () => {
    expect(trialAffordance(trial({ outcome: "passed", stored: true }))).toBe("settled");
    expect(trialAffordance(trial({ outcome: "failed", stored: true }))).toBe("settled");
  });
});
