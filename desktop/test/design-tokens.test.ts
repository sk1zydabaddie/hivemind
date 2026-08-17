import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "..");

const readStyles = async (): Promise<string> =>
  readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");

/** The block Tailwind reads. A token declared outside it generates no utility. */
const themeBlock = (styles: string): string => {
  const start = styles.indexOf("@theme inline {");
  expect(start, "styles.css has no @theme inline block").toBeGreaterThan(-1);
  return styles.slice(start, styles.indexOf("\n}", start));
};

/** Follows a var() chain through the :root declarations down to a literal. */
const resolve = (styles: string, name: string): string => {
  let value = `var(${name})`;
  for (let step = 0; step < 12 && /var\(--[a-z0-9-]+\)/u.test(value); step += 1) {
    value = value.replace(/var\((--[a-z0-9-]+)\)/gu, (whole, ref: string) => {
      const declared = styles.match(new RegExp(`${ref}:\\s*([^;}]+)`, "u"));
      return declared === null ? whole : declared[1].trim();
    });
  }
  return value.toLowerCase();
};

/**
 * The palette, from the product's logo. These eight are the whole vocabulary:
 * navy and charcoal are the identity, amber and clay only ever carry meaning.
 */
const palette = {
  ground: "#ffffff",
  surface: "#f5f6f8",
  ink: "#1f2328",
  navy: "#1b3a6b",
  rule: "#e3e6ea",
  muted: "#667085",
  amber: "#b88936",
  clay: "#b65b4f"
} as const;

/**
 * Every token a component from `npx shadcn add` can reference, mapped to the
 * palette value it must resolve to. A shadcn component is styled entirely
 * through these names, so a missing one does not fall back -- it generates no
 * CSS at all and the element renders unstyled. That is the failure this file
 * exists to catch: `--muted-foreground` was declared in :root but never
 * exposed to @theme, so `text-muted-foreground` -- the most common text
 * utility in generated components -- emitted nothing, in three components
 * already shipped in the app.
 */
const shadcnTokens: Record<string, string> = {
  background: palette.ground,
  foreground: palette.ink,
  card: palette.ground,
  "card-foreground": palette.ink,
  popover: palette.ground,
  "popover-foreground": palette.ink,
  primary: palette.navy,
  "primary-foreground": palette.ground,
  secondary: palette.surface,
  "secondary-foreground": palette.ink,
  // shadcn's muted pair is a SURFACE and a TEXT colour, not one value.
  muted: palette.surface,
  "muted-foreground": palette.muted,
  destructive: palette.clay,
  "destructive-foreground": palette.ground,
  border: palette.rule,
  input: palette.rule,
  ring: palette.navy,
  sidebar: palette.surface,
  "sidebar-foreground": palette.ink,
  "sidebar-primary": palette.navy,
  "sidebar-primary-foreground": palette.ground,
  "sidebar-accent-foreground": palette.navy,
  "sidebar-border": palette.rule,
  "sidebar-ring": palette.navy
};

describe("shadcn token contract", () => {
  test("every token a generated component uses resolves to a palette value", async () => {
    const styles = await readStyles();
    const theme = themeBlock(styles);

    for (const [token, expected] of Object.entries(shadcnTokens)) {
      expect(theme, `--color-${token} is missing from @theme inline`).toContain(
        `--color-${token}:`
      );
      // #ffffff and #fff are the same colour; compare on the short form.
      const actual = resolve(styles, `--color-${token}`).replace(
        /#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/u,
        "#$1$2$3"
      );
      const want = expected.replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/u, "#$1$2$3");
      expect(actual, `--color-${token} does not resolve to ${expected}`).toBe(want);
    }
  });

  test("the accent pair is a navy wash, the only tint allowed to read as a fill", async () => {
    const styles = await readStyles();
    expect(themeBlock(styles)).toContain("--color-accent:");
    expect(resolve(styles, "--color-accent-foreground")).toBe(palette.navy);
  });

  /**
   * Deliberate gap, asserted so it stays deliberate. `--chart-1` through
   * `--chart-5` need five mutually distinguishable hues, and the palette has
   * two colours that carry meaning (amber, clay) and none that are decorative.
   * Adding them means choosing colours the product does not have. A chart
   * component therefore needs a palette decision first, and should fail
   * visibly rather than silently pick something.
   */
  test("chart tokens are absent, because the palette has no decorative hues", async () => {
    const theme = themeBlock(await readStyles());
    expect(theme).not.toContain("--color-chart-");
  });

  test("Geist Sans and Geist Mono are the two families, and both are bundled", async () => {
    const theme = themeBlock(await readStyles());
    expect(theme).toMatch(/--font-sans:\s*"Geist Variable"/u);
    expect(theme).toMatch(/--font-mono:\s*"Geist Mono Variable"/u);

    const entry = await readFile(path.join(desktopRoot, "src", "main.tsx"), "utf8");
    expect(entry).toContain("@fontsource-variable/geist/wght.css");
    expect(entry).toContain("@fontsource-variable/geist-mono/wght.css");

    const manifest = JSON.parse(
      await readFile(path.join(desktopRoot, "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@fontsource-variable/geist"]).toBeDefined();
    expect(manifest.dependencies["@fontsource-variable/geist-mono"]).toBeDefined();
  });

  test("Tailwind is wired through the Vite plugin and scans the whole client", async () => {
    const styles = await readStyles();
    expect(styles).toContain('@import "tailwindcss"');

    /* This asserted `@layer theme, base, legacy, components, utilities;` long
       after `legacy.css` was deleted and the `legacy` layer went with it. The
       string was absent, `indexOf` returned -1, and -1 is less than any real
       index -- so the assertion PASSED BECAUSE THE THING IT LOOKED FOR WAS
       GONE. A guard that cannot fail is not a guard.

       Both halves are asserted now: the declaration exists, and it precedes the
       import. Order matters because a layer named after the import would be
       ordered after Tailwind's own layers. */
    const order = "@layer theme, base, components, utilities;";
    const orderAt = styles.indexOf(order);
    expect(orderAt, `styles.css does not declare "${order}"`).toBeGreaterThan(-1);
    expect(orderAt).toBeLessThan(styles.indexOf('@import "tailwindcss"'));

    const vite = await readFile(path.join(desktopRoot, "vite.config.ts"), "utf8");
    expect(vite).toContain('from "@tailwindcss/vite"');
    expect(vite).toMatch(/plugins:\s*\[[^\]]*tailwindcss\(\)/u);

    const components = JSON.parse(
      await readFile(path.join(desktopRoot, "components.json"), "utf8")
    ) as { tailwind: { css: string; config: string }; aliases: Record<string, string> };
    // Tailwind v4 is CSS-first; an empty `config` is what tells the CLI so.
    expect(components.tailwind.config).toBe("");
    expect(components.tailwind.css).toBe("src/styles.css");
    expect(components.aliases.ui).toBe("@/components/ui");
  });
});

/**
 * Radius is reachable for a CSS assertion in exactly the way colour is: the
 * whole scale is declared as literals in `@theme inline`, so every
 * `rounded-<x>` in the app resolves through one of these six names.
 *
 * Added after a mutation experiment: changing `--radius-md` from 4px to 9px
 * left the entire suite green, which meant the file's own claim to be a token
 * contract covered only half of what the contract is.
 */
describe("radius contract", () => {
  const radii: Record<string, string> = {
    "radius-xs": "2px",
    "radius-sm": "3px",
    "radius-md": "4px",
    "radius-lg": "5px",
    "radius-xl": "6px",
    "radius-2xl": "6px",
    "radius-3xl": "6px"
  };

  /* Evaluates `calc(var(--radius) * N)` the way the engine will, so the scale
     can be DERIVED from one number and still be checked as numbers. Resolving
     the var chain leaves a `calc()` string, and a test that compared strings
     would pass on any multiplier at all -- which is most of the value here. */
  const computed = (styles: string, token: string): number => {
    const value = resolve(styles, token);
    const direct = /^(\d+(?:\.\d+)?)px$/u.exec(value.trim());
    if (direct !== null) return Number(direct[1]);
    const scaled = /calc\(\s*(\d+(?:\.\d+)?)px\s*\*\s*(\d+(?:\.\d+)?)\s*\)/u.exec(value);
    expect(scaled, `${token} is neither a length nor a scale of one: ${value}`).not.toBeNull();
    return Number(scaled![1]) * Number(scaled![2]);
  };

  test("the six steps are the whole scale, and it stays barely rounded", async () => {
    const styles = await readStyles();
    const theme = themeBlock(styles);

    for (const [token, expected] of Object.entries(radii)) {
      expect(theme, `--${token} is missing from @theme inline`).toContain(`--${token}:`);
      expect(computed(styles, `--${token}`), `--${token} drifted off the scale`).toBe(
        Number(expected.replace("px", ""))
      );
    }

    /* Nothing above 6px, because a panel corner larger than that reads as a
       card on a marketing page rather than as an instrument's edge.
       This is a claim about the SHIPPED default. The experimental theme panel
       moves `--radius` at runtime on purpose and is temporary; what must not
       drift is the value in the stylesheet. */
    for (const declared of theme.match(/--radius[a-z0-9-]*:\s*[^;]+/gu) ?? []) {
      const token = declared.split(":")[0]!.trim();
      expect(computed(styles, token), `${token} is above 6px`).toBeLessThanOrEqual(6);
    }
  });

  /* The scale is SINGLE-SOURCED. Seven hand-written lengths are seven chances
     to disagree, and the theme panel could only move one of them -- a slider
     that rounded buttons and left panels square would be a control that half
     works, which is worse than one that does not. */
  test("every step derives from --radius, so one number moves the scale", async () => {
    const styles = await readStyles();
    const theme = themeBlock(styles);
    for (const token of Object.keys(radii)) {
      const declared = new RegExp(`--${token}:\\s*([^;]+);`, "u").exec(theme)?.[1] ?? "";
      expect(declared, `--${token} is a literal and cannot follow --radius`).toMatch(
        /var\(--radius\)/u
      );
    }
  });
});

describe("palette discipline", () => {
  test("the eight palette values are exactly the logo's, and are declared once", async () => {
    const styles = await readStyles();
    for (const [name, value] of Object.entries({
      panel: palette.ground,
      canvas: palette.surface,
      ink: palette.ink,
      navy: palette.navy,
      rule: palette.rule,
      muted: palette.muted,
      amber: palette.amber,
      clay: palette.clay
    })) {
      expect(resolve(styles, `--${name}`).replace(/#fff\b/u, "#ffffff")).toBe(value);
    }
  });

  test("no colour outside the palette and its tints reaches the stylesheet", async () => {
    const styles = await readStyles();
    const allowed = new Set([
      ...Object.values(palette),
      "#fff",
      "#edeff2", // rule-soft
      "#eef2f8", // navy wash
      "#f9f3e8", // amber wash
      "#f9edeb", // clay wash
      /* Pure black, and ONLY as a darkening term -- never a colour anything is
         painted. Two uses: deriving `--navy-deep` from `--navy` so a ramp's two
         stops cannot drift into different hues, and the shading half of
         `--relief`, which is a lighting overlay on whatever fill it sits on
         rather than a colour of its own. */
      "#000000"
    ]);
    const hexes = new Set(
      (styles.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []).map((hex) => hex.toLowerCase())
    );
    expect([...hexes].filter((hex) => !allowed.has(hex))).toEqual([]);
    /* Gradients: one shape, permitted 2026-08-14, and the rule is narrow.
     *
     * The blanket ban that used to live here was the wrong instrument. What
     * this project needs to avoid is the two-colour MULTI-HUE button that reads
     * as a generic AI product -- not gradients as such. A vertical ramp from a
     * colour to a darker mix of itself is what a physical control looks like.
     *
     * So: no radial or conic anywhere, and every linear ramp must be vertical
     * and single-hue. The stops are Tailwind `from-`/`to-` utilities in the
     * markup rather than CSS here, so the stylesheet keeps only the ban on the
     * shapes that cannot be constrained. */
    expect(styles).not.toMatch(/radial-gradient|conic-gradient/u);
    for (const direction of ["to right", "to left", "45deg", "90deg", "to top"]) {
      expect(styles).not.toContain(direction);
    }

    /* And the derived stops must be mixes of a palette colour, never a second
       hand-picked hue -- which is the only way two stops drift apart.
       BOTH ends of a ramp: `-lift` mixes toward white, `-deep` toward black.
       These were 88% mixes and are now 80/68, because a 12% darkening measured
       as a gradient and read as a flat rectangle. The RANGE is a value and may
       be turned up; the single hue is the rule and may not. */
    /* A ramp stop is a bare `color-mix`. Anchoring on that excludes
       `--shadow-lift`, which ends in the same word and is a box-shadow -- the
       first draft of this matched it and the baseline failed, which is the
       cheapest possible moment to learn that a pattern is too greedy. */
    const stops = [...styles.matchAll(/--(\w+)-(?:lift|deep):\s*(color-mix\([^;]+);/gu)];
    expect(stops.length, "no ramp stops are declared").toBeGreaterThan(0);
    for (const [whole, base, value] of stops) {
      expect(value, `${whole!} must be derived from its base`).toContain(`var(--${base!})`);
      expect(value).toMatch(/color-mix\(in oklab/u);
      /* The half the name check cannot do. `from-navy-lift to-navy-deep` passes
         any assertion about utility NAMES however the tokens are defined -- so a
         stop mixed with clay instead of white would produce a two-hue ramp that
         reads exactly like the generic-AI button this rule exists to prevent,
         and nothing would notice. Mutation testing found this hole by doing it.
         The only permitted second term is pure white or pure black, because a
         lighting mix is not a colour choice. */
      const terms = value.match(/#[0-9a-fA-F]{3,8}/gu) ?? [];
      expect(terms.length, `${whole!} mixes with no literal`).toBeGreaterThan(0);
      for (const term of terms) {
        expect(
          term.toLowerCase(),
          `${whole!} mixes its base with ${term} -- a ramp stop may only be lightened or darkened`
        ).toMatch(/^#(?:fff(?:fff)?|000(?:000)?)$/u);
      }
    }
  });

  test("exactly one thing can carry the attention edge, and panels never float", async () => {
    const root = path.join(desktopRoot, "src");
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".css")) files.push(full);
      }
    };
    await walk(root);

    /* If two things glow, neither means anything. The edge lives on the ONE
       primary queue item -- the rest collapse inside it -- so uniqueness is a
       property of placement, and this asserts the placement rather than
       trusting it. */
    const users: string[] = [];
    for (const file of files) {
      if (file.endsWith(".css")) continue;
      const source = await readFile(file, "utf8");
      if (/attention-edge/u.test(source)) users.push(path.basename(file));
    }
    expect(users, "the attention edge appears in more than one surface").toEqual(["work-tab.tsx"]);

    /* RELIEF is not elevation, and the difference is enforced rather than
       trusted. A raised button claims "this responds to pressure" and redeems
       the claim the moment it is pressed; a raised panel claims to be above the
       surface and never demonstrates it. So the two shadows are a PAIR: any
       rule that takes the raised state must also declare the pressed one, which
       means nothing can look proud of the canvas here without being pressable. */
    const reliefUsers: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".tsx")) continue;
      const source = await readFile(file, "utf8");
      if (!/shadow-\[var\(--relief\)\]/u.test(source)) continue;
      reliefUsers.push(path.basename(file));

      /* PER VARIANT, not per file. This used to assert against the whole
         source, and mutation testing showed why that was worthless: deleting
         the press from ONE of the two filled variants left the file still
         matching on the other one, and the suite went green on a button that no
         longer answered. Every class string that raises itself is checked on
         its own terms. */
      const raised = (source.match(/"[^"]*shadow-\[var\(--relief\)\][^"]*"/gu) ?? []);
      expect(raised.length, `${path.basename(file)} raises nothing this test can read`)
        .toBeGreaterThan(0);
      for (const variant of raised) {
        const which = /^"(bg-[a-z-]+)/u.exec(variant)?.[1] ?? variant.slice(0, 24);
        /* `group-active:` as well as `active:`. A switch THUMB is raised and
           depresses, but the pointer lands on the track, so `active:` on the
           thumb never fires -- the press has to be read from the parent. That
           is a real second form rather than a loophole: the requirement is
           still that this exact element shows the pressed state when the
           control is pressed. */
        expect(variant, `${which} takes relief with no pressed state`).toMatch(
          /(?:active|group-active):shadow-\[var\(--relief-pressed\)\]/u
        );
        /* It has to MOVE. The distance is a value and may be turned up -- it
           went from 1px to 2px when the relief was strengthened -- so this
           asserts a downward translate of at least a pixel rather than one
           exact utility. What is not negotiable is that something moves: a
           shadow swap with a stationary label is a repaint, not a press. */
        expect(variant, `${which} is raised but does not depress`).toMatch(
          /(?:active|group-active):translate-y-(?:px|\[[1-9]\d*px\])/u
        );
      }
    }
    /**
     * Who may claim relief — extended, and this is an APPLICATION of the rule
     * rather than a relaxation of it.
     *
     * The rule was never "only buttons". It is that relief claims affordance and
     * only an object that answers when pressed may make the claim. A checkbox
     * answers when pressed; so does a radio and a switch. Each takes a press and
     * returns a state change caused by that press, which is the same redemption
     * a button offers and the one a panel can never offer. `--shadow-panel`
     * stays deleted for exactly the reason it always was.
     *
     * The list stays closed, because "controls that answer" is a judgement and
     * an open rule would be no rule. Adding a file here is a deliberate edit
     * that has to survive review.
     */
    expect(
      [...reliefUsers].sort(),
      "relief belongs to controls that answer when pressed, and to nothing else"
    ).toEqual(["button.tsx", "pressable.tsx"]);

    /* A 16px control cannot borrow a large button's soft scale and remain
       legible at native size. Compact controls override the same paired tokens
       with a crisp two-pixel base; the press contract above still applies. */
    const pressables = await readFile(path.join(root, "components", "ui", "pressable.tsx"), "utf8");
    expect(pressables).toMatch(/\[--relief:[^\]]*inset_0_-2px/u);
    expect(pressables).toMatch(/\[--relief-pressed:/u);

    /**
     * The converse half, for controls that are FLAT at rest and depress anyway.
     *
     * Tabs are the case: a tab answers when pressed, so it may show the press,
     * but it does not sit proud of the toolbar — claiming relief at rest would be
     * the panel-shadow mistake with a hover state. So it takes the pressed
     * shadow and no raised one.
     *
     * Without this rule that combination is invisible to the suite: the checks
     * above only look at files containing `--relief`, so a control could take
     * `--relief-pressed` alone and never be examined. The requirement that
     * survives is the one that matters — **it has to move.** A shadow swap with a
     * stationary label is a repaint, not a press, whatever the resting state was.
     */
    for (const file of files) {
      if (!file.endsWith(".tsx")) continue;
      /* Comments out FIRST. The doc comment in `pressable.tsx` explains this
         very rule, and the first draft of this scan matched the prose and
         reported the explanation as a control that depresses without moving.
         Third time in one session -- so it is a helper, not a habit. */
      const source = (await readFile(file, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/^[ 	]*\/\/.*$/gmu, "");
      const pressedOnly = (source.match(/"[^"]*--relief-pressed[^"]*"/gu) ?? []).filter(
        (variant) => !variant.includes("var(--relief)")
      );
      for (const variant of pressedOnly) {
        expect(
          variant,
          `${path.basename(file)} depresses without moving: ${variant.slice(0, 70)}`
        ).toMatch(/(?:active|group-active):translate-y-(?:px|\[[1-9]\d*px\])/u);
      }
    }

    /* The pair is declared once, together, so neither can be taken alone. */
    const reliefCss = (await readStyles()).replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(reliefCss).toMatch(/--relief\s*:/u);
    expect(reliefCss).toMatch(/--relief-pressed\s*:/u);
    /* Raised at rest means an OUTER shadow; pressed means none. A pressed
       state that kept a drop shadow would be a button hovering while depressed,
       which is the tell that the effect is decoration. */
    /* Split on TOP-LEVEL commas: `color-mix(in oklab, #000000 20%, transparent)`
       has two of its own, and a naive split turns one shadow layer into three
       fragments that mention no `inset` at all. */
    const layers = (value: string): string[] =>
      value.replace(/color-mix\([^()]*\)/gu, "MIX").split(",");
    const relief = layers(/--relief:\s*([^;]+);/u.exec(reliefCss)?.[1] ?? "");
    const pressed = layers(/--relief-pressed:\s*([^;]+);/u.exec(reliefCss)?.[1] ?? "");
    expect(relief.some((layer) => !layer.includes("inset"))).toBe(true);
    expect(pressed.every((layer) => layer.includes("inset"))).toBe(true);

    /* Reduced motion shortens the press; it does not flatten the button.
       Somebody who asked for less movement did not ask for a different
       interface, so no reduced-motion rule may reset a relief shadow. */
    const reducedBlocks =
      reliefCss.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n\}/gu) ?? [];
    for (const block of reducedBlocks) {
      expect(block, "reduced motion must not flatten the relief").not.toMatch(
        /box-shadow|--relief/u
      );
    }

    /* And `--shadow-panel` stays deleted. Depth is for things that genuinely
       float; a shadow under a panel was decoration pretending to be
       hierarchy. */
    /* The DECLARATION, not the word. Both mentions in styles.css are comments
       explaining that the token was deleted -- banning the string catches the
       prose that documents the rule, which is this project's most-repeated
       trap. What must not exist is a declaration. */
    const styles = await readStyles();
    const cssCode = styles.replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(cssCode).not.toMatch(/--shadow-panel\s*:/u);
    for (const file of files) {
      if (!file.endsWith(".tsx")) continue;
      const source = await readFile(file, "utf8");
      expect(source, `${path.basename(file)} gives a panel a float shadow`).not.toMatch(
        /Panel[^>]{0,120}shadow-\[var\(--shadow-float\)\]/u
      );
    }
  });

  test("motion is spring-curved and reduced motion still shows what needs you", async () => {
    const styles = await readStyles();
    /* Two curves and no more -- a vocabulary, not a collection. */
    expect(styles).toMatch(/--spring:\s*cubic-bezier/u);
    expect(styles).toMatch(/--spring-firm:\s*cubic-bezier/u);

    /* Reduced motion stops the edge PULSING without removing it: somebody who
       asked for less movement still needs to know which thing needs them. */
    const reduced = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.attention-edge/u);
    expect(reduced).toMatch(/animation: none/u);

    /* The former universal animation reset also stopped functional indicators
       without providing another signal. Transitions may collapse globally;
       animations must opt into their reduced presentation by name. */
    const universal = /\*,\s*\n\s*\*::before,\s*\n\s*\*::after\s*\{([^}]+)\}/u.exec(reduced)?.[1] ?? "";
    expect(universal).not.toMatch(/animation-duration|animation-iteration-count/u);
    expect(reduced).toMatch(/\.animate-spin\s*\{\s*animation:\s*none/u);
  });

  test("every gradient in the markup is vertical and stays on one hue", async () => {
    const root = path.join(desktopRoot, "src");
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".tsx")) files.push(full);
      }
    };
    await walk(root);

    /* The failure being prevented is specific: `from-navy to-amber` -- two
       meaning colours in one control, which is the generic-AI-product tell.
       Same-hue ramps are fine and are the whole point of allowing this. */
    const offences: string[] = [];
    let ramps = 0;
    for (const file of files) {
      const source = await readFile(file, "utf8");
      /* Only vertical ramps exist. Anything else is refused outright. */
      for (const horizontal of source.match(/bg-gradient-to-(?:r|l|tr|tl|br|bl)/gu) ?? []) {
        offences.push(`${path.basename(file)}: ${horizontal}`);
      }
      for (const match of source.matchAll(
        /from-([a-z-]+)(?:\/\d+)?\s+(?:hover:)?to-([a-z-]+)(?:\/\d+)?/gu
      )) {
        ramps += 1;
        /* `-lift` joined `-deep` when the ramp was widened: the top stop is now
           a mix toward white and the bottom a mix toward black, both of the
           SAME palette colour. Stripping both keeps the real rule -- one hue
           per ramp -- while allowing the range to be as wide as it needs. */
        const base = (name: string): string => name.replace(/-lift$|-deep$|-wash$/u, "");
        if (base(match[1]!) !== base(match[2]!)) {
          offences.push(`${path.basename(file)}: from-${match[1]} to-${match[2]}`);
        }
      }
    }
    expect(offences, "a gradient left its hue or ran horizontally").toEqual([]);
    /* Non-vacuous: if the ramps disappear this stops proving anything. */
    expect(ramps).toBeGreaterThan(0);
  });
});

/* Depth, after the blur was measured and removed.
 *
 * The history matters because the rule survived two reversals and is narrower
 * than it looks. Version one allowed `backdrop-filter` on three floating
 * components and nothing else -- too tight to be a theme. Version two inverted
 * that to a denylist and put three ordered blurs on nine surfaces. Then the
 * frames were subtracted, and the blur turned out to change 4.73% of the window,
 * all of it glyph edges, because a backdrop filter promotes compositing layers
 * and a promoted layer loses subpixel antialiasing WINDOW-WIDE -- including on
 * the mono figures the denylist was written to protect.
 *
 * So the blur is gone and **its absence is now the thing being enforced**. What
 * remains is what was doing the visible work all along: a translucent fill and a
 * lit top edge, at three ordered distances. Frosted glass needs a backdrop with
 * structure, and white panels on a #f5f6f8 canvas have none -- that is a fact
 * about the palette, so no value would have fixed it.
 *
 * The two rules that outlived both reversals: nothing dense and monospaced sits
 * on a translucent fill, and nothing here gets louder than the amber attention
 * edge. */
/* The same walk the attention-edge test does, hoisted so the glass rules can
   use it too. */
async function sourceFiles(): Promise<string[]> {
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
}

describe("depth is fills and edges, and never a blur", () => {
  /* Where small monospaced figures are read. Translucency costs most exactly
     here and buys least: a token count that is hard to read is worse than a
     surface that is plain. Kept after the blur's removal because it was never
     about the blur -- a pale fill over a busy backdrop hurts a 11px figure
     whatever the filter says. */
  const DENSE_MONO = [
    "diff-view.tsx",
    "checks-output.tsx",
    "file-viewer.tsx",
    "spec-review.tsx"
  ];

  /* The edge IS the depth marker now, so these three names are the whole
     vocabulary: a surface's tier is whichever one it takes. */
  const DEPTHS = ["--glass-edge-near", "--glass-edge", "--glass-edge-far"] as const;

  test("three edges are declared, one per distance", async () => {
    const css = (await readStyles()).replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const edge of DEPTHS) {
      expect(css, `${edge} must be declared`).toContain(`${edge}:`);
    }
  });

  /* The blur is gone and must stay gone. This is the assertion that would have
     caught it going back in, and it is the whole point of the rewrite: a
     property that costs subpixel antialiasing across the window is not a thing
     to reintroduce quietly on one surface. */
  test("no surface reintroduces a backdrop filter", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      /* Comments out first. `styles.css` explains at length WHY the blur was
         removed, and banning the bare string flags the prose that documents the
         rule -- this project's most-repeated trap, and it caught this very
         assertion on its first run. What must not exist is a declaration. */
      const source = (await readFile(file, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/^\s*\/\/.*$/gmu, "");
      if (/backdrop-filter|backdrop-blur/u.test(source)) offenders.push(path.basename(file));
    }
    expect(
      offenders,
      "a backdrop filter promotes compositing layers and costs subpixel AA window-wide"
    ).toEqual([]);
  });

  /* Ordered, because that is what makes three tokens a distance rather than
     three arbitrary values. The edge brightens as a surface comes forward. */
  test("the edges are ordered, so they read as distance", async () => {
    const css = (await readStyles()).replace(/\/\*[\s\S]*?\*\//gu, "");
    const declared = (name: string): string => {
      const at = css.indexOf(`${name}:`);
      expect(at, `${name} is not declared`).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf(";", at));
    };
    const brightness = (name: string): number =>
      Number(/#ffffff\s+(\d+)%/u.exec(declared(name))?.[1] ?? 0);

    const near = brightness("--glass-edge-near");
    const mid = brightness("--glass-edge");
    const far = brightness("--glass-edge-far");
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);

    /* The ceiling, unchanged in intent: the amber attention edge is the only
       thing on screen that means "a person must act", so a white rim on a pane
       stays a hint at a boundary rather than a highlight. */
    expect(near, "the edge must stay a hint, not a highlight").toBeLessThanOrEqual(12);
  });

  test("every surface at a depth is translucent, or the edge lights nothing", async () => {
    const files = await sourceFiles();
    let users = 0;
    const perDepth = new Map<string, number>();
    for (const file of files) {
      if (!file.endsWith(".tsx")) continue;
      const source = await readFile(file, "utf8");
      for (const edge of DEPTHS) {
        /* Only count a real shadow utility, so the token appearing in a comment
           does not register as a user -- prose about a rule matching the rule
           is this project's most-repeated trap. */
        const taken = (source.match(/shadow-\[[^\]]*\]/gu) ?? []).filter((utility) =>
          utility.includes(`var(${edge})`)
        ).length;
        if (taken === 0) continue;
        users += taken;
        perDepth.set(edge, (perDepth.get(edge) ?? 0) + taken);
        /* An edge on an opaque fill is a hairline pretending to be a pane. The
           translucency is what the edge is the boundary OF, so without it the
           token is decoration -- the configured-and-doing-nothing shape. */
        expect(source, `${path.basename(file)} lights the edge of an opaque surface`).toMatch(
          /bg-[a-z-]+\/\d{2}/u
        );
      }
    }
    /* A ratchet, not a sanity check. A slack floor let three surfaces be
       stripped back to opaque without a word, which is how a material decays
       into a dialog trick one refactor at a time. */
    expect(users, "depth is meant to be the app's material, not a dialog trick")
      .toBeGreaterThanOrEqual(9);
    for (const edge of DEPTHS) {
      expect(perDepth.get(edge) ?? 0, `${edge} is declared but nothing takes it`)
        .toBeGreaterThan(0);
    }
  });

  test("nothing dense and monospaced sits on a translucent surface", async () => {
    const files = await sourceFiles();
    for (const name of DENSE_MONO) {
      const found = files.find((file) => path.basename(file) === name);
      if (found === undefined) continue;
      const source = await readFile(found, "utf8");
      for (const edge of DEPTHS) {
        expect(source, `${name} carries dense figures and must stay opaque`).not.toContain(
          `var(${edge})`
        );
      }

      /* The half that actually matters. The plan review's file lists are mono
         and sit inside a dialog that is itself translucent -- what keeps them
         legible is their OWN opaque fill, painted over whatever the ancestor is
         doing. A translucent fill here would put the figures on the dialog's
         surface, and no rule about this file's own depth tokens would notice. */
      const fills = source.match(/\bbg-(?:panel|canvas|surface)(?:\/\d+)?\b/gu) ?? [];
      expect(fills.length, `${name} paints no fill of its own to sit on`).toBeGreaterThan(0);
      expect(
        fills.filter((fill) => fill.includes("/")),
        `${name} carries dense figures on a translucent fill`
      ).toEqual([]);
    }
  });
});
