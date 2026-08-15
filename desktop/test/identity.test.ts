import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { holdingGate, passedGates } from "../src/lib/gates";
import { createBoardProjection, type BoardProjection } from "../src/lib/projection";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const withEvents = (types: string[]): BoardProjection => ({
  ...createBoardProjection(),
  recentEvents: types.map((type, index) => ({ seq: index, type }) as never)
});

describe("the gates are drawn from the trail", () => {
  /* The whole claim of this surface: a screenshot where nothing has gone wrong
     still shows that something is being enforced. That is only true if the
     rules come from events that really happened. */
  test("a rule is drawn only for a gate something actually passed through", () => {
    expect(passedGates(createBoardProjection())).toEqual([]);

    const rules = passedGates(withEvents(["lease.approved", "task.started"]));
    expect(rules.map((rule) => rule.id)).toEqual(["scope"]);
    expect(rules[0]!.detail).toBe("1 file claim approved");
    /* No rule for the gates nothing has reached. Drawing those would be
       describing the product rather than reporting the run. */
    expect(rules.map((rule) => rule.id)).not.toContain("write");
  });

  /* The constraint that matters most: the rules must not become chrome. */
  test("one rule per GATE, never per task and never per phase", () => {
    const rules = passedGates(
      withEvents([
        "lease.approved",
        "lease.approved",
        "lease.approved",
        "write_intent.approved",
        "write_intent.approved"
      ])
    );
    expect(rules).toHaveLength(2);
    expect(rules.find((rule) => rule.id === "scope")!.detail).toBe("3 file claims approved");
    expect(rules.find((rule) => rule.id === "write")!.detail).toBe("2 edits approved");
  });

  test("only a held gate is allowed to be loud", () => {
    for (const rule of passedGates(withEvents(["lease.approved"]))) {
      expect(rule.standing).toBe("passed");
    }
    const held = holdingGate({
      task_id: "T-004",
      state: "paused",
      issue: "package.json needs a person"
    } as never);
    expect(held?.standing).toBe("held");
    expect(held?.detail).toBe("package.json needs a person");
  });

  /* Core's reason, verbatim, or no rule. A rule that invented a name for
     something nobody named would be the surface asserting a fact of its own. */
  test("a task with no recorded reason gets no rule", () => {
    expect(holdingGate({ task_id: "T-001", state: "paused", issue: "" } as never)).toBeNull();
    expect(
      holdingGate({ task_id: "T-002", state: "running", issue: "still going" } as never)
    ).toBeNull();
  });

  test("the passed rule is thinner and lighter than any lane", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    const gate = styles.slice(styles.indexOf(".gate-rule::before"));
    /* A hairline against the rule colour. The lane is 2px in navy or clay; a
       gate that matched it would be another lane, and every phase boundary
       drawing one would be horizontal noise competing with the attention
       edge for the same glance. */
    expect(gate).toMatch(/height:\s*1px/u);
    expect(gate).toMatch(/background:\s*var\(--rule\)/u);
    expect(styles).toMatch(/\.lane\[data-standing="working"\][\s\S]*?background:\s*var\(--navy\)/u);
  });
});

describe("the motion is bound to real state", () => {
  test("nothing animates on a timer", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    for (const name of ["hex-draw", "hex-advance", "ship-land"]) {
      const rule = new RegExp(`animation:\\s*${name}[^;]*;`, "u").exec(styles);
      expect(rule, `${name} must be declared`).not.toBeNull();
      /* `infinite` is what makes a decoration out of a signal. The one
         exception in this app is the attention edge, which is elsewhere and
         means "this needs you" rather than "something happened". */
      expect(rule![0]).not.toMatch(/infinite/u);
    }
  });

  test("every new animation is switched off for reduced motion", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    /* `\n}` needs the brace escaped under the `u` flag — a lone `}` is a
       "lone quantifier bracket" and the file will not even parse. */
    const reduced = styles.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n\}/gu) ?? [];
    const joined = reduced.join("\n");
    for (const name of ["hex-check", "hex-advance", "ship-mark"]) {
      expect(joined, `${name} must stop under reduced motion`).toMatch(
        new RegExp(`\\.${name}`, "u")
      );
    }
  });

  test("the check draws on completion rather than fading in", async () => {
    const hex = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "hex.tsx"),
      "utf8"
    );
    /* Taken from 21st.dev's AI Task List: a dash-offset keyframe rather than an
       animated motion value, so reduced motion is handled in CSS with no JS
       branch to get out of step. */
    expect(hex).toMatch(/strokeDasharray/u);
    expect(hex).toMatch(/pathLength=\{1\}/u);
    expect(hex).not.toMatch(/framer-motion|useReducedMotion/u);
  });
});

describe("the accumulation is a count, not a metric", () => {
  test("the comb counts shipped tasks and invents nothing", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "project-tab.tsx"),
      "utf8"
    );
    const comb = source.slice(source.indexOf("function Comb("));
    /* Every stat card surveyed for this pass paired a count-up on mount with a
       percentage change against a "previous period". Both are invented. */
    expect(comb).not.toMatch(/streak|average|percent|%|previous|trend|since last/iu);
    expect(comb).not.toMatch(/setInterval|requestAnimationFrame/u);
    /* And a capped comb says it is capped. A count that silently stops is a
       count that lies. */
    expect(comb).toMatch(/more not drawn/u);
  });
});

describe("the mark is the real one", () => {
  test("the brand mark ships as the asset, in both themes", async () => {
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    expect(app).toMatch(/assets\/mark\.png/u);
    expect(app).toMatch(/assets\/mark-dark\.png/u);
    /* The near-black half of the mark disappears on the dark canvas, so the
       swap is a real requirement rather than a nicety — and it is done in CSS
       so it follows the OS with no JS and no flash of the wrong one. */
    expect(app).toMatch(/prefers-color-scheme: dark/u);
    expect(app).not.toMatch(/const hex = \(cx: number/u);
  });
});
