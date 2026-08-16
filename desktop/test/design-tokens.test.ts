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

  test("the six steps are the whole scale, and it stays barely rounded", async () => {
    const styles = await readStyles();
    const theme = themeBlock(styles);

    for (const [token, expected] of Object.entries(radii)) {
      expect(theme, `--${token} is missing from @theme inline`).toContain(`--${token}:`);
      expect(resolve(styles, `--${token}`), `--${token} drifted off the scale`).toBe(expected);
    }

    /* Nothing above 6px, because a panel corner larger than that reads as a
       card on a marketing page rather than as an instrument's edge. */
    for (const declared of theme.match(/--radius[a-z0-9-]*:\s*[^;]+/gu) ?? []) {
      const px = /(\d+)px/u.exec(resolve(styles, declared.split(":")[0]!.trim()));
      if (px !== null) expect(Number(px[1]), `${declared} is above 6px`).toBeLessThanOrEqual(6);
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
       hand-picked hue -- which is the only way two stops drift apart. */
    const deepTokens = [...styles.matchAll(/--(\w+)-deep:\s*([^;]+);/gu)];
    expect(deepTokens.length).toBeGreaterThan(0);
    for (const [, base, value] of deepTokens) {
      expect(value).toContain(`var(--${base!})`);
      expect(value).toMatch(/color-mix\(in oklab/u);
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
      expect(source, `${path.basename(file)} takes relief with no pressed state`).toMatch(
        /active:shadow-\[var\(--relief-pressed\)\]/u
      );
      /* And it has to actually move. A shadow swap on its own is a repaint,
         not a press: what makes it read as a real button is that the label
         goes down with the surface. */
      expect(source, `${path.basename(file)} is raised but does not depress`).toMatch(
        /active:translate-y-px/u
      );
    }
    /* Only the control component may carry it at all. */
    expect(reliefUsers, "relief belongs to the button and nothing else").toEqual(["button.tsx"]);

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
        const base = (name: string): string => name.replace(/-deep$|-wash$/u, "");
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

/* Glass is relief's rule one axis over.
 *
 * Relief asks "is this pressable?" and is redeemed by the press. Glass asks "is
 * this ABOVE the app?" and is redeemed by what shows through it — which is only
 * true for something that genuinely floats over content still sitting there.
 * The substrate does not float; it IS the app, and frosting it would be the
 * panel-shadow mistake in a new material.
 *
 * So the same three-part enforcement: a declared pair, an allowlist of files
 * that may take it, and a ceiling that keeps it below the attention edge. */
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

describe("glass belongs to what floats", () => {
  /* The four surfaces that genuinely float over live content. Everything else
     -- panels, the rail, window chrome, the canvas -- is substrate. */
  const MAY_FLOAT = ["command.tsx", "dialog.tsx", "dropdown-menu.tsx"];

  test("only floating surfaces take it, and never alone", async () => {
    const files = await sourceFiles();
    const users: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".tsx")) continue;
      const source = await readFile(file, "utf8");
      if (!/\[backdrop-filter:var\(--glass\)\]/u.test(source)) continue;
      users.push(path.basename(file));
      /* The blur alone reads as a smudge. What makes it a PANE is the bright
         edge catching light at the boundary, so the two are a pair exactly as
         relief and relief-pressed are. */
      expect(source, `${path.basename(file)} takes glass with no edge`).toMatch(
        /shadow-\[var\(--glass-edge\)\]/u
      );
      /* And it must be translucent. Glass over an opaque fill blurs nothing --
         the effect would be inert, which is the shape this project keeps
         recording: configured, correct, and doing nothing. */
      expect(source, `${path.basename(file)} frosts an opaque surface`).toMatch(
        /bg-[a-z-]+\/\d{2}/u
      );
    }
    expect(
      [...new Set(users)].sort(),
      "glass belongs to what floats above the app, and nothing else"
    ).toEqual(MAY_FLOAT);
  });

  test("the pair is declared once, together", async () => {
    const css = (await readStyles()).replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(css).toMatch(/--glass\s*:/u);
    expect(css).toMatch(/--glass-edge\s*:/u);
  });

  /* The constraint that decides the ceiling is not taste. The amber attention
     edge is the only thing on screen that means "a person must act", so a
     material that competes with it is a bug however good it looks. */
  test("it stays quieter than the thing that means act now", async () => {
    const css = (await readStyles()).replace(/\/\*[\s\S]*?\*\//gu, "");
    const blur = /--glass:[^;]*blur\((\d+)px\)/u.exec(css);
    expect(blur, "glass must declare its blur radius").not.toBeNull();
    expect(Number(blur![1]), "a heavy blur turns a pane into a spotlight").toBeLessThanOrEqual(16);

    const edge = /--glass-edge:[^;]*#ffffff\s+(\d+)%/u.exec(css);
    expect(edge, "the edge must be a white mix").not.toBeNull();
    expect(Number(edge![1]), "the edge must stay a hint, not a highlight").toBeLessThanOrEqual(8);
  });

  /* Dense monospaced figures are where translucency costs most and buys least,
     so the surfaces that carry diffs, trails and token counts stay opaque. */
  test("nothing dense and monospaced sits on glass", async () => {
    for (const name of ["diff-view.tsx", "checks-output.tsx", "project-tab.tsx", "work-tab.tsx"]) {
      const found = (await sourceFiles()).find((file) => path.basename(file) === name);
      if (found === undefined) continue;
      expect(await readFile(found, "utf8"), `${name} carries dense figures and must stay opaque`)
        .not.toMatch(/\[backdrop-filter:var\(--glass\)\]/u);
    }
  });
});
