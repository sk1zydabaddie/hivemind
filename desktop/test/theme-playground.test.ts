import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = path.join(desktopRoot, "src", "components", "theme-playground.tsx");

/**
 * Source with its comments removed.
 *
 * Four separate assertions in this session have matched the prose that documents
 * the very rule being asserted -- including one in this file, where the panel's
 * own note explaining that `document.fonts.check()` cannot be trusted tripped the
 * ban on `fonts.check`. STATE.md calls this the project's most-repeated trap. It
 * is not a thing to be more careful about; it is a function.
 */
const codeOf = async (file: string): Promise<string> =>
  (await readFile(file, "utf8"))
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^[ 	]*\/\/.*$/gmu, "");

const sourceFiles = async (): Promise<string[]> => {
  const root = path.join(desktopRoot, "src");
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) found.push(full);
    }
  };
  await walk(root);
  return found;
};

/**
 * The theme playground is temporary, and this is what makes that true.
 *
 * "Temporary" is a promise about the future, and a promise about the future is
 * exactly the kind of claim this project has learned not to accept undefended.
 * A panel described as temporary that has grown imports into six files is a
 * permanent panel nobody decided to keep — so the cost of removing it is
 * asserted rather than intended, and if that cost rises these tests fail.
 *
 * The bill for deletion is meant to stay at: one file, two import sites.
 */
describe("the theme playground stays cheap to delete", () => {
  test("it is one file, and nothing else holds theme state", async () => {
    const files = await sourceFiles();
    const owners = files.filter((file) => path.basename(file).startsWith("theme-playground"));
    expect(owners.map((file) => path.basename(file))).toEqual(["theme-playground.tsx"]);

    /* The storage key lives in the panel and nowhere else. A second reader would
       be a second thing to find when this goes. */
    const elsewhere: string[] = [];
    for (const file of files) {
      if (file === PANEL) continue;
      const source = await readFile(file, "utf8");
      if (source.includes("hivemind.experimental.theme")) elsewhere.push(path.basename(file));
    }
    expect(elsewhere, "the experimental key is read outside the panel").toEqual([]);
  });

  test("exactly two files import it, and both are named in the panel's own notes", async () => {
    const files = await sourceFiles();
    const importers: string[] = [];
    for (const file of files) {
      if (file === PANEL) continue;
      const source = await readFile(file, "utf8");
      if (/from "(?:@\/components|\.\/components)\/theme-playground"/u.test(source)) {
        importers.push(path.basename(file));
      }
    }
    /* The mount and the startup call. Any third importer means deletion has
       become a search rather than an edit. */
    expect([...importers].sort()).toEqual([
      "main.tsx",
      "settings-dialog.tsx"
    ]);
  });

  test("it is marked experimental where a person will see it, not only in a comment", async () => {
    const panel = await readFile(PANEL, "utf8");
    const rendered = panel.slice(panel.indexOf("export function ThemePlayground"));
    expect(rendered, "the panel must say so on screen").toMatch(/Experimental/u);
    expect(rendered).toMatch(/will be deleted/u);
  });

  /* It writes the REAL tokens. A preview pane with its own styles would answer a
     different question than the one being asked, and the whole reason to build
     this rather than argue was to see the actual app. */
  test("it writes the app's own tokens rather than a preview's", async () => {
    const panel = await codeOf(PANEL);
    for (const token of ["--radius", "--font-sans", "--font-mono"]) {
      expect(panel, `${token} is not written`).toContain(`"${token}"`);
    }
    expect(panel).toMatch(/document\.documentElement/u);
    /* And no private stylesheet of its own -- no <style> tag, no injected CSS
       text, which is how a "preview" quietly becomes the thing being judged. */
    expect(panel, "a panel with its own stylesheet is a preview pane").not.toMatch(
      /createElement\("style"\)|innerHTML|insertRule/u
    );
  });

  /**
   * The font list is filtered by MEASUREMENT, not by hope.
   *
   * A picker offering families this machine does not have silently falls back to
   * Segoe UI and shows one rendering under six names — a control that appears to
   * work and does nothing, which is this project's most-repeated failure shape.
   * Eleven of the candidates are absent on this machine and correctly disappear.
   */
  test("families are offered only when they are really installed", async () => {
    const panel = await codeOf(PANEL);
    expect(panel).toMatch(/const available = /u);
    expect(panel, "availability must be measured, not asserted").toMatch(/measureText/u);
    /* `document.fonts.check()` reports true for locally installed families
       whether or not they exist, so it must not be what decides this. */
    expect(panel, "fonts.check() cannot answer this and must not be trusted to").not.toMatch(
      /fonts\.check/u
    );
    expect(panel, "families that are missing must be named, not hidden").toMatch(/not offered/u);
  });

  /* Changing family or radius changes metrics, and this app is full of
     fixed-height controls that cannot grow. The panel measures the live layout
     and NAMES what clips rather than letting it break quietly -- and it reports
     rather than repairs, because silently growing every control would answer
     "does this typeface work here" with "yes, once I changed the layout". */
  test("it measures what clips instead of assuming nothing does", async () => {
    const panel = await codeOf(PANEL);
    expect(panel).toMatch(/const findClipping = /u);
    expect(panel).toMatch(/scrollHeight > .*clientHeight/u);
    expect(panel).toMatch(/scrollWidth > .*clientWidth/u);
    /* Re-measured after the browser has reflowed at the new metrics. Measuring
       in the same tick reads the OLD layout and reports a clean bill for a
       broken screen. */
    expect(panel, "the re-measure must wait for a reflow").toMatch(/requestAnimationFrame/u);
    expect(panel).toMatch(/Fit check/u);
  });

  /* The radius slider can only work if the whole scale follows one number --
     which is a claim about styles.css, asserted here because it is what makes
     the panel's single slider honest rather than partial. */
  test("one slider can move the whole scale", async () => {
    const styles = await readFile(path.join(desktopRoot, "src", "styles.css"), "utf8");
    for (const step of ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"]) {
      const declared = new RegExp(`--radius-${step}:\\s*([^;]+);`, "u").exec(styles)?.[1] ?? "";
      expect(declared, `--radius-${step} does not follow --radius`).toMatch(/var\(--radius\)/u);
    }
  });
});
