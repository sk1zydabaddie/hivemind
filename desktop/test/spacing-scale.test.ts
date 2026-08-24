import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

/* The spacing guard, and why it is not in `design-tokens.test.ts`.
 *
 * Colour, radius and token resolution are declared as literals in
 * `@theme inline`, so a CSS assertion can read the contract and check it.
 * **Spacing is declared nowhere.** It is Tailwind's default scale, spent as
 * utilities in TSX, so `px-3` against `px-3.5` is invisible to any assertion
 * over the stylesheet no matter how it is written.
 *
 * Catching it needs a different instrument: a scan of the markup. That is this
 * file. It was recorded as a deliberate gap in DESIGN-NOTES on 2026-08-12 and
 * built on 2026-08-14, when the surface count had roughly doubled.
 *
 * Two rules, and the second matters more than the first:
 *
 * 1. Spacing comes from a bounded set of steps.
 * 2. **No arbitrary values.** `p-[13px]` is how a scale dies — not by one wrong
 *    step, but by stopping being a scale at all.
 */

const SRC = path.resolve(import.meta.dirname, "..", "src");

/* The steps actually in use, measured from the tree rather than invented, so
   the guard starts by passing and only bites on a NEW value. A scale nobody
   currently honours is a wish, not a contract.

   0.5 through 3.5 are the working range -- 3 alone accounts for a third of all
   spacing. 5, 6, 7, 8 and 12 appear a handful of times each at panel and
   dialog scale. Adding a step is a deliberate act: change this list and say
   why in the same commit. */
const ALLOWED_STEPS = new Set([
  "0",
  "0.5",
  "1",
  "1.5",
  "2",
  "2.5",
  "3",
  "3.5",
  "4",
  "5",
  "6",
  "7",
  "8",
  "12",
  /* Structural rather than rhythmic: full-bleed and auto-centring carry no
     step and cannot drift. */
  "px",
  "auto",
  "full"
]);

/* Sorted longest-first, and that is load-bearing rather than tidy. JS
   alternation takes the FIRST matching branch, so with `gap` before `gap-x`,
   `gap-x-2` parses as prefix `gap` with step `x` -- which the guard then
   reports as an off-scale step in every file that uses it. Caught on the first
   run, by the guard producing 14 offences that were all the same bug. */
const SPACING_PREFIXES = [
  "px", "py", "pt", "pb", "pl", "pr", "ps", "pe", "p",
  "mx", "my", "mt", "mb", "ml", "mr", "ms", "me", "m",
  "gap-x", "gap-y", "gap",
  "space-x", "space-y"
];

/* Matches a spacing utility with its step, allowing a Tailwind variant prefix
   (`sm:`, `hover:`) and a negative margin. */
const SPACING = new RegExp(
  `(?:^|[\\s"'\`{])(?:[a-z-]+:)*(-)?(${SPACING_PREFIXES.join("|")})-((?:\\[[^\\]]*\\])|[\\w.]+)`,
  "gu"
);

async function tsxFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await tsxFiles(full)));
    } else if (entry.name.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Alignment, which is not rhythm.
 *
 * A few values exist to line content up with a fixed gutter or to nudge a mark
 * onto a text baseline. Those are optical decisions with a specific measured
 * answer, and rounding them to the nearest step would visibly misalign the
 * thing they exist to align. Banning them would make the guard wrong; ignoring
 * arbitrary values everywhere would make it useless.
 *
 * So each one is registered WITH ITS REASON, and the guard asserts every
 * registration is still in use. That is what stops this becoming a list that
 * only ever grows: delete the markup and the entry fails as stale.
 */
const ALIGNMENT_EXCEPTIONS: Record<string, string> = {
  "components/workspace/work-tab.tsx: pl-[52px]":
    "aligns a wrapped detail row under the thread's timestamp gutter",
  "components/workspace/work-tab.tsx: pl-[92px]":
    "aligns a nested row under the same gutter, one level in",
  "components/workspace/work-tab.tsx: pl-9":
    "aligns a list under the icon column of the header above it",
  /* Retired: the 6px square that needed this became the lane's hexagon, which
     is taller, sits on a track and aligns on a scale step. An exception that
     outlives the markup it was granted for is how a registry stops meaning
     anything, so the test fails on a stale one rather than tolerating it. */
  "components/workspace/project-tab.tsx: ml-[136px]":
    "aligns a run's detail block under the run's own metadata column",
  /* Not a design measurement at all: macOS draws its traffic lights over our
     content at the window's top left, and this is the room they take. The
     number belongs to the platform, so it cannot be expressed as a step on our
     scale without pretending it is our decision. */
  "App.tsx: pl-[78px]": "clears the macOS traffic lights the system draws over the header"
};

interface Offence {
  file: string;
  utility: string;
}

async function scan(): Promise<{ arbitrary: Offence[]; offScale: Offence[]; used: Set<string> }> {
  const arbitrary: Offence[] = [];
  const offScale: Offence[] = [];
  const used = new Set<string>();
  for (const file of await tsxFiles(SRC)) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(SRC, file).replaceAll("\\", "/");
    for (const match of source.matchAll(SPACING)) {
      const [, negative, prefix, step] = match;
      const utility = `${negative ?? ""}${prefix}-${step}`;
      const key = `${relative}: ${utility}`;
      if (key in ALIGNMENT_EXCEPTIONS) {
        used.add(key);
      } else if (step!.startsWith("[")) {
        arbitrary.push({ file: relative, utility });
      } else if (!ALLOWED_STEPS.has(step!)) {
        offScale.push({ file: relative, utility });
      }
    }
  }
  return { arbitrary, offScale, used };
}

describe("spacing stays on one scale", () => {
  test("no arbitrary spacing value anywhere in the markup", async () => {
    const { arbitrary } = await scan();
    expect(
      arbitrary.map((entry) => `${entry.file}: ${entry.utility}`),
      "an arbitrary spacing value bypasses the scale entirely; use a step, or add one deliberately"
    ).toEqual([]);
  });

  test("every spacing utility uses a step the design system allows", async () => {
    const { offScale } = await scan();
    expect(
      [...new Set(offScale.map((entry) => `${entry.file}: ${entry.utility}`))],
      "a spacing step outside the scale; add it to ALLOWED_STEPS and say why, or use an existing step"
    ).toEqual([]);
  });

  test("every registered alignment exception is still in the markup", async () => {
    /* An allowlist that only grows stops being a guard. If the markup that
       needed the exception is gone, so is the exception. */
    const { used } = await scan();
    const stale = Object.keys(ALIGNMENT_EXCEPTIONS).filter((key) => !used.has(key));
    expect(stale, "these alignment exceptions no longer match any markup; delete them").toEqual([]);
  });

  /* The instrument must be able to fail, which this project has shipped
     without exactly once and rediscovered six times. Both rules are exercised
     against text that should trip them, so a broken regex cannot pass as a
     clean tree. */
  test("the scan can actually catch both kinds of drift", () => {
    const sample = `<div className="p-[13px] gap-9 px-3" />`;
    const found = [...sample.matchAll(SPACING)].map((match) => ({
      step: match[3]!,
      utility: `${match[2]}-${match[3]}`
    }));
    expect(found.some((entry) => entry.step.startsWith("["))).toBe(true);
    expect(found.some((entry) => !entry.step.startsWith("[") && !ALLOWED_STEPS.has(entry.step))).toBe(
      true
    );
    /* And a legitimate utility is not flagged, or the guard would be noise. */
    expect(found.some((entry) => entry.utility === "px-3")).toBe(true);
    expect(ALLOWED_STEPS.has("3")).toBe(true);
  });

  test("the scan reaches the real surfaces, not an empty list", async () => {
    /* A clean result from a scan that read nothing is the vacuous pass this
       project keeps rediscovering. */
    const files = await tsxFiles(SRC);
    expect(files.length).toBeGreaterThan(15);
    const joined = files.map((file) => path.basename(file));
    expect(joined).toContain("work-tab.tsx");
    expect(joined).toContain("project-tab.tsx");
  });
});
