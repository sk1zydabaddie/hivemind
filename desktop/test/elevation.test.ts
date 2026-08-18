import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readStyles = async (): Promise<string> =>
  readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");

/**
 * Source with comments removed.
 *
 * Every rule below reads source, and the source is wrapped in prose explaining
 * these very rules — the stylesheet spends seventy lines on why `--shadow-panel`
 * was deleted, which contains every string a ban would look for. Four assertions
 * in this project have already matched their own documentation. It is a function,
 * not a thing to remember.
 */
const codeOf = async (file: string): Promise<string> =>
  (await readFile(file, "utf8"))
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^[ \t]*\/\/.*$/gmu, "");

const sourceFiles = async (): Promise<string[]> => {
  const root = path.join(desktopRoot, "src");
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".css")) found.push(full);
    }
  };
  await walk(root);
  return found;
};

/**
 * Elevation: three levels, each one a claim that can be false.
 *
 * `--shadow-panel` was deleted for being "decoration pretending to be
 * hierarchy". That was right about the symptom and imprecise about the cause,
 * and getting the cause right is what lets this exist at all: panels are not
 * forbidden depth — what was wrong is that EVERY panel had the SAME shadow, so it
 * asserted a hierarchy without expressing one. **A claim that applies to
 * everything distinguishes nothing.**
 *
 * So this is not the relief rule relaxed; it is a second claim with its own
 * redemption. Relief says "this responds to pressure" and is redeemed by the
 * press, in 60ms, by the object itself. Elevation says "this is above that" and
 * is redeemed by OCCLUSION — the higher thing covers the lower one, or is
 * separated from a plane its siblings share. Neither needs the other, and a panel
 * can truthfully be above another panel without ever being pressable.
 *
 * Which makes the enforceable content ASSIGNMENT: a level must correspond to
 * something true, and two things at different levels must not share one. Hence a
 * closed set per level rather than a utility anyone can sprinkle — the same shape
 * as the relief allowlist, for the same reason.
 */
describe("elevation is a scale, not a shadow utility", () => {
  /* Each list is closed, because "is this genuinely above that" is a judgement
     and an open rule is not a rule. Adding a file is a deliberate edit that has
     to survive review. */
  const LEVELS: Record<string, readonly string[]> = {
    /* Above the app, and each of these occludes it. */
    "elevation-overlay": ["dialog.tsx", "command.tsx", "dropdown-menu.tsx", "tooltip.tsx"],
    /* Above the surrounding content: the attention card over the stream, the
       ship card over the run it concludes, the plan banner, the queue card. */
    "elevation-floating": ["work-tab.tsx"],
    /* A discrete card brought forward from siblings it shares a surface with —
       and `styles.css`, which is `.lift:hover`: hovering a clickable card is
       that same claim, made for as long as the pointer is on it. */
    "elevation-raised": ["work-tab.tsx", "selection-control.tsx", "styles.css"]
  };

  test("each level appears only where it is allowed, and none is unused", async () => {
    const files = await sourceFiles();
    for (const [level, allowed] of Object.entries(LEVELS)) {
      const users: string[] = [];
      for (const file of files) {
        const code = await codeOf(file);
        /* A USE, not a mention. `styles.css` re-exports each level to Tailwind as
           `--shadow-elevation-x: var(--elevation-x)`, which is a declaration --
           counting it made the stylesheet appear to have assigned itself the
           overlay level. A use is the token inside a `box-shadow` declaration or
           a `shadow-[...]` utility, which is the only way it reaches an element. */
        const inBoxShadow = code.includes(`box-shadow: var(--${level})`);
        const inUtility = code.includes(`shadow-[var(--${level})`);
        const inUtilityList = code.includes(`,var(--${level})`);
        if (inBoxShadow || inUtility || inUtilityList) users.push(path.basename(file));
      }
      for (const user of users) {
        expect(allowed, `${user} takes --${level} and is not on its list`).toContain(user);
      }
      /* A level nothing takes is a level that means nothing — which is exactly
         the state this replaced, where three of four shadow tokens had no
         consumer anywhere in the app. */
      expect(users.length, `--${level} is declared and unused`).toBeGreaterThan(0);
    }
  });

  /* "Two things at different levels must not get the same shadow" is the old bug
     stated precisely, so it is enforced on the VALUES rather than on intent. */
  test("the levels are strictly ordered, so no two express the same height", async () => {
    const css = (await readStyles()).replace(/\/\*[\s\S]*?\*\//gu, "");
    const shape = (level: string): { offset: number; blur: number; ink: number } => {
      const at = css.indexOf(`--${level}:`);
      expect(at, `--${level} is not declared`).toBeGreaterThan(-1);
      const value = css.slice(at, css.indexOf(";", at));
      /* The widest layer carries the read, so the largest of each. */
      return {
        offset: Math.max(...[...value.matchAll(/0 (\d+)px/gu)].map((m) => Number(m[1]))),
        blur: Math.max(...[...value.matchAll(/0 \d+px (\d+)px/gu)].map((m) => Number(m[1]))),
        ink: Math.max(...[...value.matchAll(/var\(--ink\) (\d+)%/gu)].map((m) => Number(m[1])))
      };
    };
    const raised = shape("elevation-raised");
    const floating = shape("elevation-floating");
    const overlay = shape("elevation-overlay");

    expect(floating.blur, "floating must reach further than raised").toBeGreaterThan(raised.blur);
    expect(overlay.blur, "overlay must reach further than floating").toBeGreaterThan(floating.blur);
    expect(overlay.offset, "overlay must sit higher than raised").toBeGreaterThan(raised.offset);
    expect(overlay.ink, "overlay must be the darkest").toBeGreaterThan(raised.ink);
  });

  /**
   * The two constraints, as numbers taken from rendered pixels.
   *
   * Measured by `elevation-measure.mjs`, which renders each shadow on the real
   * canvas colour and samples outward from the edge. Peak is the darkest pixel
   * out of 255; reach is how far before it falls under 1/255.
   *
   * - The amber attention edge peaks at **14.7 over 11px**. `raised` (4.3/4) and
   *   `floating` (10.3/10) share a screen with it and stay under it on both axes.
   *   The first `floating` candidate measured 16.3/13 and was rejected for
   *   exceeding it — the ceiling did its job before anything shipped.
   * - `overlay` (25.3/36) is louder, and is the one level that OCCLUDES the edge
   *   rather than competing with it.
   * - Soft means soft: a deliberately-too-heavy shadow measured 59/57 and reads
   *   as a grey smudge on `#f5f6f8`, for the same reason the blur was removed.
   *
   * A test cannot re-render pixels, so it guards the INPUTS those numbers came
   * from. If an ink percentage grows past these, the measurement is stale and has
   * to be retaken rather than assumed still true.
   */
  test("it stays calmer than the amber edge, and soft on a near-white canvas", async () => {
    const css = (await readStyles()).replace(/\/\*[\s\S]*?\*\//gu, "");
    const inkOf = (level: string): number[] => {
      const at = css.indexOf(`--${level}:`);
      const value = css.slice(at, css.indexOf(";", at));
      return [...value.matchAll(/var\(--ink\) (\d+)%/gu)].map((m) => Number(m[1]));
    };

    for (const level of ["elevation-raised", "elevation-floating"]) {
      const inks = inkOf(level);
      expect(inks.length, `--${level} has no ink terms to check`).toBeGreaterThan(0);
      for (const ink of inks) {
        expect(ink, `--${level} at ${String(ink)}% risks outshouting the amber edge`)
          .toBeLessThanOrEqual(10);
      }
    }
    for (const ink of inkOf("elevation-overlay")) {
      expect(ink, `--elevation-overlay at ${String(ink)}% reads as a grey smudge`)
        .toBeLessThanOrEqual(20);
    }
  });

  /* The tokens this replaced are gone, not merely unused. Three of the four had
     no consumers, which is how the same mistake got made twice: names nobody had
     to justify, available for anybody to reach for. */
  test("the unassigned shadow tokens are gone, not just unused", async () => {
    const css = (await readStyles()).replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const dead of [
      "--shadow-panel",
      "--shadow-float",
      "--shadow-lift",
      "--shadow-overlay",
      "--shadow-raised"
    ]) {
      /* A plain string check. Escaping `-` for a unicode-mode regex produces
         `\-`, which is an invalid escape and THREW rather than asserting -- a
         rule that raises instead of failing is not reporting on the code. */
      expect(css, `${dead} is declared again`).not.toContain(`${dead}:`);
    }
    for (const file of await sourceFiles()) {
      if (!file.endsWith(".tsx")) continue;
      const code = await codeOf(file);
      for (const dead of ["--shadow-float", "--shadow-lift", "--shadow-overlay", "--shadow-raised"]) {
        expect(code, `${path.basename(file)} still reaches for ${dead}`).not.toContain(dead);
      }
    }
  });

  /**
   * Ground is where most of the app lives, and that has to stay true or the
   * scale stops meaning anything — which is precisely what went wrong the first
   * time. A `Panel` is the substrate: it sits ON the canvas and is separated by
   * its own 1px rule.
   */
  test("the substrate stays at ground level", async () => {
    const code = await codeOf(path.join(desktopRoot, "src", "components", "ui", "panel.tsx"));
    for (const level of Object.keys(LEVELS)) {
      expect(code, `panel.tsx claims --${level}; the substrate is ground`).not.toContain(level);
    }
  });

  /**
   * Chrome is not a card, so the active tab is deliberately NOT on the scale.
   *
   * Tabs are cut into the toolbar rather than sitting on it, and selection is
   * already expressed by a filled pill — a decision made specifically so that
   * relief and selection would stop sharing a device. Giving the active tab
   * elevation would hand selection two devices again, and would claim an "above"
   * that no occlusion demonstrates: a selected tab covers nothing.
   *
   * Asserted rather than merely intended, because it is the one place where the
   * level list and an earlier decision pulled in opposite directions, and the
   * next person to read the list will wonder why tabs are missing from it.
   */
  test("selection alone earns no level: the active tab stays fill-only", async () => {
    const code = await codeOf(path.join(desktopRoot, "src", "components", "ui", "tabs.tsx"));
    for (const level of Object.keys(LEVELS)) {
      expect(code, `tabs.tsx claims --${level}; selection is fill, not elevation`).not.toContain(
        level
      );
    }
    /* And it still expresses selection, so this is a substitution rather than an
       omission. */
    expect(code, "the selected tab must still be marked somehow").toMatch(
      /data-\[state=active\]:from-navy-wash/u
    );
  });
});
