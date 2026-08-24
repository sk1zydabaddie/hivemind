import { describe, expect, test } from "vitest";

import { setupExitState } from "../src/components/workspace/setup-screen";

/* The reported bug: everything filled in on the setup screen and no way
 * forward. A healthy machine promotes straight to the work surface, so an
 * end-to-end walk proves that path and cannot reach the stuck ones -- they are
 * pinned here.
 *
 * Proven to bite: make the blocked branch return `{ kind: "hidden" }` and
 * "names the unmet term" fails; drop the `runnable` check and "offers the door"
 * fails. */
const connected = { role: "planner", connected_at: "2026-08-23T00:00:00Z", problems: [] };

describe("the way out of the setup screen", () => {
  test("says nothing before the project exists", () => {
    expect(setupExitState({ live: false, runnable: true, adapters: [], checkResolved: true }).kind).toBe(
      "hidden"
    );
  });

  test("offers the door when work can start", () => {
    expect(setupExitState({ live: true, runnable: true, adapters: [], checkResolved: true }).kind).toBe(
      "ready"
    );
  });

  /* The shape that shipped: every step ticked, `runnable` false, nothing
     rendered. Now it names the term. */
  test("names the unmet term rather than rendering nothing", () => {
    const state = setupExitState({
      live: true,
      runnable: false,
      adapters: [connected],
      checkResolved: true
    });
    expect(state.kind).toBe("blocked");
    expect(state.kind === "blocked" && state.missing.join("; ")).toContain("manager");
    expect(state.kind === "blocked" && state.missing.join("; ")).toContain("worker");
  });

  test("an adapter with problems does not count as connected", () => {
    const state = setupExitState({
      live: true,
      runnable: false,
      adapters: [{ ...connected, problems: ["refused"] }],
      checkResolved: true
    });
    expect(state.kind === "blocked" && state.missing[0]).toMatch(/planner/u);
  });

  test("an unanswered check question is reported as its own term", () => {
    const state = setupExitState({
      live: true,
      runnable: false,
      adapters: [connected],
      checkResolved: false
    });
    expect(state.kind === "blocked" && state.missing.at(-1)).toMatch(/checked is unanswered/u);
  });

  /* Steps satisfied and Core still says no: a blank screen is the one answer
     that is never right. */
  test("reports the disagreement when this screen can see nothing wrong", () => {
    const state = setupExitState({
      live: true,
      runnable: false,
      adapters: [
        connected,
        { role: "manager", connected_at: "x", problems: [] },
        { role: "worker", connected_at: "x", problems: [] }
      ],
      checkResolved: true
    });
    expect(state.kind).toBe("disagreement");
  });
});
