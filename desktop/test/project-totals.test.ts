import { describe, expect, test } from "vitest";

import replayData from "../tools/replay-data.json";
import { projectTotals } from "../src/lib/project-totals";
import type { WorkspaceHistoryRun, WorkspaceInspection } from "../src/lib/workspace-actions";

/* The gamification rule, as a test: every number is a sum over the durable
 * record, and the satisfying ones that are NOT derivable are named as missing
 * rather than estimated.
 */

const scenarios = (replayData as {
  scenarios: Array<{ id: string; inspection?: WorkspaceInspection | null }>;
}).scenarios;

function run(overrides: Partial<WorkspaceHistoryRun> = {}): WorkspaceHistoryRun {
  return {
    session_id: "s",
    spec_id: "S-001",
    started_at: "2026-08-01T10:00:00.000Z",
    last_activity_at: "2026-08-01T10:06:00.000Z",
    duration_ms: 360_000,
    outcome: "completed",
    outcome_detail: "",
    verified_tasks: [],
    merged_tasks: [],
    stopped_tasks: [],
    calls: 0,
    effective_tokens: 0,
    provider_reported_tokens: 0,
    self_measured_tokens: 0,
    evidence_paths: [],
    autonomy_levels: [],
    ...overrides
  };
}

describe("what a project has accumulated", () => {
  test("nothing recorded totals to nothing, and claims nothing missing", () => {
    const totals = projectTotals([]);
    expect(totals.tasksShipped).toBe(0);
    expect(totals.runsShipped).toBe(0);
    expect(totals.lastShippedAt).toBeNull();
    /* An empty project is not owed a list of caveats about numbers it has no
       runs to compute. */
    expect(totals.absent).toEqual([]);
  });

  test("sums across runs and counts only runs that actually shipped", () => {
    const totals = projectTotals([
      run({ merged_tasks: ["T-001", "T-002"], verified_tasks: ["T-001", "T-002"], calls: 3, effective_tokens: 100 }),
      run({ merged_tasks: [], verified_tasks: ["T-003"], calls: 2, effective_tokens: 50 }),
      run({ merged_tasks: ["T-004"], verified_tasks: ["T-004"], calls: 1, effective_tokens: 25 })
    ]);

    expect(totals.tasksShipped).toBe(3);
    expect(totals.tasksChecked).toBe(4);
    expect(totals.runsShipped).toBe(2);
    expect(totals.runsRecorded).toBe(3);
    expect(totals.calls).toBe(6);
    expect(totals.effectiveTokens).toBe(175);
    expect(totals.workingMs).toBe(1_080_000);
  });

  test("a run that verified but never shipped is not counted as shipped", () => {
    const totals = projectTotals([run({ verified_tasks: ["T-001"], merged_tasks: [] })]);
    expect(totals.runsShipped).toBe(0);
    expect(totals.tasksShipped).toBe(0);
    expect(totals.tasksChecked).toBe(1);
  });

  test("names what it cannot know instead of estimating it", () => {
    const totals = projectTotals([run({ merged_tasks: ["T-001"] })]);
    /* Files touched is in the trail's adoption events and not in the per-run
       summary; time saved is a counterfactual and is in nothing, ever. */
    expect(totals.absent).toContain("how many files all of this changed");
    expect(totals.absent).toContain("how much time it saved you");
    /* And there is no field anywhere here that could carry an invented one. */
    expect(Object.keys(totals)).not.toContain("timeSaved");
    expect(Object.keys(totals)).not.toContain("streak");
  });

  test("totals a real captured run without inventing anything", () => {
    const inspection = scenarios.find(
      (scenario) => scenario.id === "e2e-textkit-parallel-run"
    )?.inspection;
    expect(inspection).toBeTruthy();
    const runs = inspection!.history.runs;
    const totals = projectTotals(runs);

    /* Every figure has to be reproducible by hand from the same input, which
       is the whole claim: these are sums, not measurements of their own. */
    expect(totals.runsRecorded).toBe(runs.length);
    expect(totals.tasksShipped).toBe(
      runs.reduce((count, entry) => count + entry.merged_tasks.length, 0)
    );
    expect(totals.effectiveTokens).toBe(
      runs.reduce((count, entry) => count + entry.effective_tokens, 0)
    );
    expect(totals.workingMs).toBeGreaterThanOrEqual(0);
  });
});
