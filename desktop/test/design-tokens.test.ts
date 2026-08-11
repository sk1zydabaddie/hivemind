import { readFile } from "node:fs/promises";
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
      "#f9edeb" // clay wash
    ]);
    const hexes = new Set(
      (styles.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []).map((hex) => hex.toLowerCase())
    );
    expect([...hexes].filter((hex) => !allowed.has(hex))).toEqual([]);
    // Elevation is neutral ink at low alpha, never a hue, and never a gradient.
    expect(styles).not.toMatch(/linear-gradient|radial-gradient|conic-gradient/u);
  });
});
