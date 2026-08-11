import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { BANNED_VOCABULARY, containsInternalVocabulary } from "../src/lib/vocabulary";

const desktopRoot = path.resolve(import.meta.dirname, "..");

interface ReplayScenario {
  id: string;
  inspection: {
    needs_you: Array<{ kind: string; title: string; detail: string }>;
    later: Array<{ kind: string; title: string; detail: string }>;
  } | null;
}

describe("vocabulary the product does not say", () => {
  test("recognises the banned terms wherever they sit in a sentence", () => {
    expect(containsInternalVocabulary("Run the real project checks again before adoption.")).toBe(
      true
    );
    expect(containsInternalVocabulary("These checks predate verified-set provenance.")).toBe(true);
    expect(containsInternalVocabulary("path is read-only under the granted lease")).toBe(true);
    expect(containsInternalVocabulary("The project's checks could not finish.")).toBe(false);
  });

  /* The reason this file exists. Five design passes were verified against
     fixtures, and every fixture wrote its own copy. These are the strings Core
     actually wrote on the captured trails, so this is the only assertion here
     that could have caught the leak that shipped. */
  test("no Core-written queue string reaches a surface still carrying banned vocabulary", async () => {
    const raw = await readFile(path.join(desktopRoot, "tools", "replay-data.json"), "utf8");
    const { scenarios } = JSON.parse(raw) as { scenarios: ReplayScenario[] };
    expect(scenarios.length).toBeGreaterThan(0);

    const items = scenarios.flatMap((scenario) => [
      ...(scenario.inspection?.needs_you ?? []),
      ...(scenario.inspection?.later ?? [])
    ]);
    // The corpus has to actually contain queue items, or this proves nothing.
    expect(items.length).toBeGreaterThan(0);

    /* At least one real detail must trip the guard -- otherwise the guard is
       untested by this corpus and a regression would pass silently. */
    const offenders = items.filter((item) => containsInternalVocabulary(item.detail));
    expect(offenders.length).toBeGreaterThan(0);

    for (const item of offenders) {
      // Whatever the surface shows instead must itself be sayable.
      expect(containsInternalVocabulary(fallbackFor(item.kind))).toBe(false);
    }
  });

  test("the client does not reword Core's reasons, it only declines unsayable ones", async () => {
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    const inspection = await readFile(
      path.resolve(desktopRoot, "..", "src", "workspace-inspection.ts"),
      "utf8"
    );

    /* Core writes `plain_reason` beside the durable `reason` now, and
       `plainEvidence` prefers it, so a task issue arrives already readable.
       `plainTaskIssue` regexed Core's strings into sentences the client was
       guessing at; it is deleted, and re-adding it is the regression. */
    expect(work).not.toMatch(/plainTaskIssue/u);
    expect(inspection).toMatch(/for \(const key of \["plain_reason",/u);

    // The containment guard stays: it declines a sentence, never rewrites one.
    expect(work).toMatch(/containsInternalVocabulary\(detail\)/u);
  });

  test("Core writes plain_reason where the cause is known", async () => {
    const gate = await readFile(path.resolve(desktopRoot, "..", "src", "gate.ts"), "utf8");
    const analyze = await readFile(path.resolve(desktopRoot, "..", "src", "analyze.ts"), "utf8");

    // The durable reason is evidence and must survive untouched beside it.
    expect(gate).toMatch(/plain_reason: plainDecisionReason\(outcome\.cause, op\)/u);
    expect(analyze).toMatch(/reason: gateResult\.reason,\s*plain_reason: gateResult\.plain_reason/u);
  });

  test("a captured run replays with its plan, its spend and its history", async () => {
    const raw = await readFile(path.join(desktopRoot, "tools", "replay-data.json"), "utf8");
    const { scenarios } = JSON.parse(raw) as {
      scenarios: Array<{
        id: string;
        inspection: {
          current_plan: { tasks: unknown[]; execution_groups: unknown[] } | null;
          spend: { calls: number; effective_tokens: number; near_session_ceiling: boolean };
          history: { runs: Array<{ merged_tasks: string[]; calls: number }> };
          tasks: Array<{ state: string }>;
        } | null;
      }>;
    };

    /* The plan review, the spend meter and the Project surface had only ever
       been drawn from fixtures, because a trail alone carries none of the three:
       the plan, the ledger and the session are files, not events. The collector
       restores a captured `project-state/` beside the trail. If this regresses,
       those surfaces quietly go back to being unverified. */
    const run = scenarios.find((scenario) => scenario.id === "e2e-textkit-parallel-run");
    expect(run?.inspection, "the real end-to-end trail must still project").toBeTruthy();
    const inspection = run!.inspection!;

    expect(inspection.current_plan?.tasks).toHaveLength(4);
    expect(inspection.current_plan?.execution_groups).toHaveLength(2);
    expect(inspection.tasks.every((task) => task.state === "merged")).toBe(true);

    // Real measured spend, against the ceilings that run actually had.
    expect(inspection.spend.calls).toBe(5);
    expect(inspection.spend.effective_tokens).toBe(622_583);
    // 622K against this run's real 2.5M ceiling is not near it. Comparing it to
    // init's 500K default put a run that was well inside budget in amber.
    expect(inspection.spend.near_session_ceiling).toBe(false);

    expect(inspection.history.runs).toHaveLength(1);
    expect(inspection.history.runs[0]?.merged_tasks).toHaveLength(4);
  });

  test("the guard's list covers every term the brief bans", () => {
    for (const term of [
      "lease",
      "canon",
      "oracle",
      "write-intent",
      "integrate_shadow",
      "adoption",
      "execution group",
      "worktree",
      "task_type",
      "routing policy",
      "quality run",
      "admission"
    ]) {
      expect(BANNED_VOCABULARY).toContain(term);
    }
  });

  test("the fallback table in the Work tab covers every queue kind Core can send", async () => {
    const actions = await readFile(
      path.join(desktopRoot, "src", "lib", "workspace-actions.ts"),
      "utf8"
    );
    const work = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "work-tab.tsx"),
      "utf8"
    );
    const kinds = [...actions.matchAll(/^\s{4}\| "([a-z_]+)"$/gmu)].map((match) => match[1]);
    expect(kinds.length).toBeGreaterThan(5);

    /* A kind with no fallback would render Core's raw sentence. The table is
       typed `Record<WorkspaceQueueItem["kind"], string>` so this cannot drift
       silently, but the assertion states the intent out loud. */
    const table = work.slice(work.indexOf("const QUEUE_FALLBACK"));
    for (const kind of kinds) {
      expect(table).toContain(`${kind}:`);
    }
  });
});

function fallbackFor(kind: string): string {
  return {
    reverification_required:
      "The checks that passed are older than the code as it stands now. They have to run again before this can ship.",
    task_attention: "This task needs you before it can carry on."
  }[kind] ?? "This task needs you before it can carry on.";
}
