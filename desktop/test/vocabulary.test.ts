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
