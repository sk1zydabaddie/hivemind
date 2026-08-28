import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const source = (...parts: string[]) => readFile(path.join(desktopRoot, "src", ...parts), "utf8");

describe("the desktop remains reachable at its supported minimum", () => {
  test("the CSS substrate does not exceed the native minimum", async () => {
    const config = JSON.parse(await readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
    const styles = await source("styles.css");
    expect(config.app.windows[0].minWidth).toBe(800);
    expect(config.app.windows[0].minHeight).toBe(620);
    expect(styles).toMatch(/#root\s*\{[^}]*min-width:\s*0;/su);
    expect(styles).toContain("@media (max-width: 900px)");
  });

  test("the viewport checker rejects partial clipping, overlap, and document overflow", async () => {
    const checker = await readFile(path.join(desktopRoot, "tools", "check-reachable.mjs"), "utf8");
    expect(checker).toContain("{ width: 790, height: 610 }");
    expect(checker).toContain("box.left < -2 || box.right > window.innerWidth + 2");
    expect(checker).toContain("found.overlaps.length === 0");
    expect(checker).toContain("found.documentOverflow.x <= 2");
  });
});

describe("focus and archive contracts are shared rather than screen-local", () => {
  test("dialogs focus an explicit target and restore their opener", async () => {
    const dialog = await source("components", "ui", "dialog.tsx");
    const work = await source("components", "workspace", "work-tab.tsx");
    expect(dialog).toContain("[data-dialog-initial-focus], [data-slot='dialog-title']");
    expect(dialog).toContain("opener?.current?.focus()");
    expect(work).not.toContain("onOpenAutoFocus={(event) => event.preventDefault()}");
  });

  test("selection controls and scroll viewports retain keyboard focus indication", async () => {
    const pressable = await source("components", "ui", "pressable.tsx");
    const selection = await source("components", "ui", "selection-control.tsx");
    const scrollArea = await source("components", "ui", "scroll-area.tsx");
    const tabs = await source("components", "ui", "tabs.tsx");
    const command = await source("components", "ui", "command.tsx");
    const diff = await source("components", "workspace", "diff-view.tsx");
    expect(pressable.match(/focus-visible:ring-\[3px\]/gu)?.length).toBe(3);
    expect(selection).toContain("focus-visible:ring-[3px]");
    expect(scrollArea).toContain("tabIndex={0}");
    expect(scrollArea).toContain('role="region"');
    expect(tabs).toContain("focus-visible:outline-solid");
    expect(command.match(/focus-visible:ring-\[2px\]/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(diff).toMatch(/textarea[\s\S]*focus-visible:ring-\[3px\]/u);
  });

  test("conversation and project archives use bounded pages and one virtual list", async () => {
    const work = await source("components", "workspace", "work-tab.tsx");
    const project = await source("components", "workspace", "project-tab.tsx");
    const virtual = await source("components", "ui", "virtual-list.tsx");
    expect(work).toContain('payload: { limit: 320 }');
    expect(work).toContain("Beginning of conversation");
    expect(project).toContain('payload: { limit: 160 }');
    expect(work).toContain('role="log"');
    expect(work).toContain('aria-label="Message Hivemind"');
    expect(virtual).toContain("visible.map((row)");
    expect(virtual).toContain("focus-visible:outline-solid");
    expect(virtual).not.toContain("items.map((item)");
  });
});
