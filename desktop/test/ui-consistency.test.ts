import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(desktopRoot, "src");

async function sourceFiles(dir = sourceRoot): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/u.test(entry.name)) files.push(full);
  }
  return files;
}

describe("shared UI primitives stay visually authoritative", () => {
  test("production contains no experimental theme workshop or override path", async () => {
    const files = await sourceFiles();
    expect(files.some((file) => path.basename(file) === "theme-playground.tsx")).toBe(false);
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
    expect(sources.join("\n")).not.toMatch(/hivemind\.experimental\.theme|ThemePlayground/u);
  });

  test("panel headers do not override the shared header surface", async () => {
    const files = await sourceFiles();
    const overrides: string[] = [];
    for (const file of files) {
      if (file.endsWith(path.join("ui", "panel.tsx"))) continue;
      const source = await readFile(file, "utf8");
      if (/<PanelHeader\s+className=/u.test(source)) {
        overrides.push(path.relative(sourceRoot, file).replaceAll("\\", "/"));
      }
    }
    expect(overrides, "PanelHeader owns its fill, height, edge, and padding").toEqual([]);
  });

  test("selection controls are implemented once", async () => {
    const files = await sourceFiles();
    const duplicateSelectionStyles: string[] = [];
    for (const file of files) {
      if (file.endsWith(path.join("ui", "selection-control.tsx"))) continue;
      const source = await readFile(file, "utf8");
      if (/aria-pressed[^>]{0,500}(?:border-navy|bg-navy-wash|relief-pressed)/su.test(source)) {
        duplicateSelectionStyles.push(path.relative(sourceRoot, file).replaceAll("\\", "/"));
      }
    }
    expect(
      duplicateSelectionStyles,
      "selection fill, pressure, radius, and spacing belong to SelectionControl"
    ).toEqual([]);
  });

  test("only interactive primitives own control gradients", async () => {
    const allowed = new Set([
      "components/ui/button.tsx",
      "components/ui/pressable.tsx",
      "components/ui/selection-control.tsx",
      "components/ui/tabs.tsx"
    ]);
    const files = await sourceFiles();
    const owners: string[] = [];
    for (const file of files) {
      const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
      const source = await readFile(file, "utf8");
      if (/bg-gradient-|\bfrom-(?:navy|clay)|\bto-(?:navy|clay)/u.test(source) && !allowed.has(relative)) {
        owners.push(relative);
      }
    }
    expect(owners, "a local gradient creates a second button language").toEqual([]);
  });

  test("callers cannot bypass the branded button primitives", async () => {
    const files = await sourceFiles();
    const rawButtons: string[] = [];
    for (const file of files) {
      if (file.endsWith(path.join("ui", "selection-control.tsx"))) continue;
      const source = await readFile(file, "utf8");
      if (/<button\b/u.test(source)) {
        rawButtons.push(path.relative(sourceRoot, file).replaceAll("\\", "/"));
      }
    }
    expect(rawButtons, "use Button or SelectionControl so controls cannot drift").toEqual([]);
  });

  test("selection state stays flat and uses the shared navy wash", async () => {
    const source = await readFile(
      path.join(sourceRoot, "components", "ui", "selection-control.tsx"),
      "utf8"
    );
    expect(source).not.toMatch(/bg-gradient-|shadow-\[var\(--control-relief\)/u);
    expect(source.match(/aria-\[pressed=true\]:bg-navy-wash/gu)?.length ?? 0).toBe(8);
  });

  test("only the dark Button variants force descendant contrast", async () => {
    const button = await readFile(path.join(sourceRoot, "components", "ui", "button.tsx"), "utf8");
    const selection = await readFile(
      path.join(sourceRoot, "components", "ui", "selection-control.tsx"),
      "utf8"
    );
    expect(button.match(/\[&_\*\]:!text-\[inherit\]/gu)?.length ?? 0).toBe(2);
    expect(selection).not.toContain("[&_*]:!text-[inherit]");
  });

  test("relief is reserved for committed actions, not navigation or suggestions", async () => {
    const button = await readFile(path.join(sourceRoot, "components", "ui", "button.tsx"), "utf8");
    const tabs = await readFile(path.join(sourceRoot, "components", "ui", "tabs.tsx"), "utf8");
    const work = await readFile(
      path.join(sourceRoot, "components", "workspace", "work-tab.tsx"),
      "utf8"
    );

    const defaultVariant = /default:\s*\n\s*"([^"]+)"/u.exec(button)?.[1] ?? "";
    const secondaryVariant = /secondary:\s*\n\s*"([^"]+)"/u.exec(button)?.[1] ?? "";
    expect(defaultVariant).toContain("shadow-[var(--control-relief)]");
    expect(defaultVariant).toContain("active:shadow-[var(--control-relief-pressed)]");
    expect(secondaryVariant).not.toMatch(/control-relief|bg-gradient/u);
    expect(tabs).toContain("data-[state=active]:after:scale-x-100");
    expect(tabs).not.toMatch(/shadow-\[var\(--relief|bg-gradient/u);
    expect(work).toMatch(/size="row"[\s\S]{0,100}variant="secondary"/u);
  });

  test("Button callers cannot override the primitive's visual contract", async () => {
    const files = await sourceFiles();
    const overrides: string[] = [];
    const forbidden = /(?:^|\s)(?:h-|size-|p[xy]?|gap|rounded|bg-|from-|to-|shadow-|text-(?:\[|xs|sm|base|lg|xl|navy|clay|ink|panel))/u;
    for (const file of files) {
      if (file.endsWith(path.join("ui", "button.tsx"))) continue;
      const source = await readFile(file, "utf8");
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (node.tagName.getText(tree) === "Button") {
            const attribute = node.attributes.properties.find(
              (entry): entry is ts.JsxAttribute =>
                ts.isJsxAttribute(entry) && entry.name.getText(tree) === "className"
            );
            const initializer = attribute?.initializer;
            const value =
              initializer && ts.isStringLiteral(initializer)
                ? initializer.text
                : initializer && ts.isJsxExpression(initializer) && initializer.expression
                  ? initializer.expression.getText(tree)
                  : "";
            if (forbidden.test(value)) {
              const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
              overrides.push(`${path.relative(sourceRoot, file).replaceAll("\\", "/")}:${line} ${value}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(
      overrides,
      "use Button variant/size props; local visual utilities create look-alike variants"
    ).toEqual([]);
  });
});
