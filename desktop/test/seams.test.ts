import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = path.resolve(desktopRoot, "..", "src");

/**
 * Three seams where both sides are internally consistent and can disagree.
 *
 * `command-surface.test.ts` closed the fourth — React calling a Tauri command by
 * string — after two of fifteen turned out never to have been registered. The
 * audit that followed found the other three consistent, but consistent *on one
 * day, checked by hand*, which is a snapshot rather than a guarantee.
 *
 * Then writing this file found a real one immediately: **Core has emitted
 * `adoption_failed` and `adoption_indeterminate` since adoption was built, and
 * the client's union carried neither** — so a run that did not ship, and a run
 * whose outcome cannot be determined, could never raise a notification. Those
 * are the two clearest "a person must decide" states in the product. Widening
 * the union then made TypeScript surface a third incomplete map in the Work tab.
 *
 * ## Why exactly three, and no more
 *
 * A seam test that tries to catch every string crossing a boundary becomes the
 * greedy regex that swallowed whole blocks and reported nine matches with none
 * of the nine names. Each test below names **one seam and its two sides**, and
 * parses each side from its own declaration rather than by scanning for
 * anything that looks like an identifier. If a fourth seam is worth covering it
 * gets its own named test, not a widened pattern here.
 */

const between = (source: string, start: RegExp, end: RegExp): string => {
  const from = source.search(start);
  if (from < 0) return "";
  const rest = source.slice(from);
  const to = rest.slice(1).search(end);
  return to < 0 ? rest : rest.slice(0, to + 1);
};

/**
 * String literals in a fragment, which is all these unions are made of.
 *
 * Every dot must be followed by a segment. Without that, `"quality."` — a
 * `startsWith` prefix in the projection — parses as an event name and reports a
 * dead branch that does not exist. A scan that cannot tell a name from a prefix
 * of one is measuring its own pattern.
 */
const literals = (fragment: string): string[] =>
  [
    ...new Set(
      [...fragment.matchAll(/"([a-z_]+(?:\.[a-z_]+)*)"/gu)].map((m) => m[1])
    )
  ].sort();

async function sourceFilesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFilesBelow(absolute));
    else if (/\.tsx?$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

describe("seam: action ids, client union to Core's accepted list", () => {
  test("every action the client can send is one Core accepts", async () => {
    const client = literals(
      between(
        await readFile(path.join(desktopRoot, "src", "lib", "workspace-actions.ts"), "utf8"),
        /export type WorkspaceAction = \{/u,
        /^\s*payload:/mu
      )
    ).filter((name) => name.includes("."));

    const core = literals(
      between(
        await readFile(path.join(coreRoot, "workspace-actions.ts"), "utf8"),
        /const workspaceActionTypes/u,
        /^\] as const;/mu
      )
    );

    expect(client.length, "the client union failed to parse").toBeGreaterThan(20);
    expect(core.length, "Core's accepted list failed to parse").toBeGreaterThan(20);

    const unaccepted = client.filter((name) => !core.includes(name));
    expect(
      unaccepted,
      "the client can dispatch these and Core rejects them; the button does nothing"
    ).toEqual([]);
  });

  test("Core actions with no production surface are an exact, reviewed set", async () => {
    const core = literals(
      between(
        await readFile(path.join(coreRoot, "workspace-actions.ts"), "utf8"),
        /const workspaceActionTypes/u,
        /^\] as const;/mu
      )
    );
    const constructed = new Set<string>();
    for (const file of await sourceFilesBelow(path.join(desktopRoot, "src"))) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/\btype:\s*"([a-z_]+(?:\.[a-z_]+)+)"/gu)) {
        if (core.includes(match[1])) constructed.add(match[1]);
      }
    }

    /* Queue actions are Core-published controls consumed through Work's generic
       `approveQueueItem(item.action)` path. They are reachable even though no
       client file constructs their literal payload. Count that seam explicitly
       instead of declaring every dynamically published action dead. */
    const queueSource = await readFile(path.join(coreRoot, "workspace-inspection.ts"), "utf8");
    for (const match of queueSource.matchAll(/\btype:\s*"([a-z_]+(?:\.[a-z_]+)+)"/gu)) {
      if (core.includes(match[1])) constructed.add(match[1]);
    }

    const unreachable = core.filter((action) => !constructed.has(action));
    expect(unreachable).toEqual([
      "accounts.add",
      "manual_task.authorize",
      "manual_task.review",
      "memory.review_handoff",
      "quality.best_of_n",
      "quality.cancel",
      "quality.draft_refine",
      "verify.characterize"
    ]);
  });
});

describe("seam: queue kinds, Core's union to the client's and the notification allowlist", () => {
  const coreKinds = async (): Promise<string[]> =>
    literals(
      between(
        await readFile(path.join(coreRoot, "workspace-inspection.ts"), "utf8"),
        /^\s*kind:\s*"plan_review"/mu,
        /;$/mu
      )
    );

  const clientKinds = async (): Promise<string[]> =>
    literals(
      between(
        await readFile(path.join(desktopRoot, "src", "lib", "workspace-actions.ts"), "utf8"),
        /export interface WorkspaceQueueItem \{/u,
        /^\s*title: string;/mu
      )
    );

  test("the client declares every kind Core can emit", async () => {
    const core = await coreKinds();
    const client = await clientKinds();
    expect(core.length, "Core's kind union failed to parse").toBeGreaterThan(8);

    const undeclared = core.filter((kind) => !client.includes(kind));
    expect(
      undeclared,
      "Core emits these and the client's type does not know them; they render and notify as nothing"
    ).toEqual([]);
  });

  /**
   * The live one.
   *
   * The allowlist keys on these strings, so a rename in Core silently stops
   * matching and notifications go quiet — the exact silence the feature was
   * built to remove. It is a SUBSET check, not equality: choosing not to
   * interrupt for a kind is a decision, and `task_attention`, `memory_review`
   * and `quality_review` are deliberately excluded. What must not happen is a
   * key that matches nothing.
   */
  test("every kind the notification allowlist waits for still exists", async () => {
    const core = await coreKinds();
    const allowlist = [
      ...new Set(
        [
          ...between(
            await readFile(path.join(desktopRoot, "src", "lib", "attention.ts"), "utf8"),
            /const INTERRUPTS/u,
            /^\};/mu
          ).matchAll(/^\s{2}([a-z_]+):/gmu)
        ].map((m) => m[1])
      )
    ].sort();

    expect(allowlist.length, "the allowlist failed to parse").toBeGreaterThan(5);
    const orphaned = allowlist.filter((kind) => !core.includes(kind));
    expect(
      orphaned,
      "these would never fire: the allowlist waits for a kind Core no longer emits"
    ).toEqual([]);

    /* And the two that were missing entirely, named so a regression is
       unambiguous rather than a count moving by one. */
    expect(allowlist).toContain("adoption_failed");
    expect(allowlist).toContain("adoption_indeterminate");
  });
});

describe("seam: trail event names, Core's emissions to the client projection", () => {
  test("every event the projection matches on is one Core writes", async () => {
    const projection = await readFile(
      path.join(desktopRoot, "src", "lib", "projection.ts"),
      "utf8"
    );
    /* Dotted lowercase literals, which is what an event name looks like and
       what this file's vocabulary consists of. Matching on `=== "..."` alone
       missed the `switch (event.type) { case "..." }` blocks and found 3 of
       ~40 — a scan that parses one of the two forms in use reports a clean
       seam because it never looked at most of it. Requiring the dot is what
       keeps it from picking up `"healthy"`, which is an AgentDisplayState. */
    const matched = literals(projection).filter((name) => name.includes("."));
    expect(matched.length, "the projection's event matches failed to parse").toBeGreaterThan(20);

    /* Membership across Core, because an event name is written wherever the
       thing happens rather than in one table. The question is only "does Core
       ever write this", so a broad haystack is right and a broad needle would
       not be. */
    const emitted = new Set<string>();
    for (const file of ["events.ts", "workspace-inspection.ts", "adoption.ts", "daemon.ts"]) {
      try {
        for (const name of literals(await readFile(path.join(coreRoot, file), "utf8"))) {
          emitted.add(name);
        }
      } catch {
        /* A file that has been renamed is not a seam failure; the assertion
           below still holds against the rest. */
      }
    }

    const unknown = matched.filter((name) => !emitted.has(name));
    expect(
      unknown,
      "the projection waits for events Core never writes; that branch is dead"
    ).toEqual([]);
  });

  /**
   * The shell's idleness proof scans the trail for worker process events, so
   * the Rust side of that seam carries two event names as string literals no
   * compiler checks. A rename in Core would silently blind the scan -- and a
   * blinded scan reads a live worker's worktree as stale, which is the
   * dangerous direction. Each name is held against Core's closed event union.
   */
  test("every trail event the shell's worker scan matches on is one Core writes", async () => {
    const shell = (
      await readFile(path.join(desktopRoot, "src-tauri", "src", "project.rs"), "utf8")
    )
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    /* Any dotted task.* literal, not the two names this was written for: a
       pattern anchored on the expected names cannot see a rename, because the
       renamed literal falls out of the scan instead of failing it. That is
       exactly how the first draft of this test proved unable to bite. */
    const matched = [...shell.matchAll(/"(task\.[a-z_.]+)"/gu)].map((match) => match[1]);
    expect(matched.length, "the shell's worker scan failed to parse").toBeGreaterThanOrEqual(2);

    const union = await readFile(path.join(coreRoot, "events.ts"), "utf8");
    const declared = new Set(
      [...union.matchAll(/"([a-z_]+\.[a-z_.]+)"/gu)].map((match) => match[1])
    );
    const unknown = matched.filter((name) => !declared.has(name));
    expect(
      unknown,
      "the shell scans for events Core never writes; the worker scan is blind"
    ).toEqual([]);
  });
});
