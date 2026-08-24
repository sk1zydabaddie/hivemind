import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* The window's own chrome, and the two ways this goes wrong when done badly.
 *
 * A white system caption above a dark app reads as two stacked programs, so the
 * caption is gone and the header runs to the window edge. The risk that comes
 * with that is the drag region: if the app's tab row is draggable, clicking a
 * tab drags the window and dragging activates a tab. Tauri 2.11's own drag
 * script prevents both -- its `isClickableElement` blocks drag for BUTTON,
 * anything with `tabindex`, and `role` in {button, link, menuitem, tab, ...} --
 * and the attribute form we choose is the second half of the guarantee. */
describe("window chrome", () => {
  test("the system caption is off and macOS keeps its native overlay", async () => {
    const config = JSON.parse(
      await readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8")
    ) as { app: { windows: Array<Record<string, unknown>> } };
    const window = config.app.windows[0]!;
    expect(window.decorations).toBe(false);
    /* macOS draws traffic lights over the content rather than a caption strip,
       which is a layout difference rather than a styling one. */
    expect(window.titleBarStyle).toBe("Overlay");
    expect(window.hiddenTitle).toBe(true);
    /* The screenshot size the chrome is verified at stays the default. */
    expect(window.width).toBe(1440);
    expect(window.height).toBe(900);
  });

  test("the header is the drag region, and only the header itself", async () => {
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    /* BARE, never "deep": bare means only direct clicks on the header start a
       drag, so no descendant -- tab, button, project switcher -- can begin one.
       `deep` would make the whole subtree draggable and reintroduce exactly the
       conflict this test exists for. */
    expect(app).toMatch(/data-tauri-drag-region\s*\n?\s*>/u);
    expect(app).not.toMatch(/data-tauri-drag-region="deep"/u);
    /* One drag region. A second one elsewhere in the shell would be a second
       title bar.
       Counted with comments STRIPPED: the first version of this counted two and
       the second was the comment above the attribute explaining it, which is
       the same trap the provider-knowledge rule solves the same way. */
    const code = app.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(code.match(/data-tauri-drag-region/gu)?.length).toBe(1);
  });

  test("the controls are on the platform's own side, and say what they do", async () => {
    const controls = await readFile(
      path.join(desktopRoot, "src", "components", "window-controls.tsx"),
      "utf8"
    );
    /* Three controls, each named for a screen reader: the native caption
       announced itself and a custom one has to do the same. */
    for (const label of ["Minimise window", "Close window"]) {
      expect(controls).toContain(label);
    }
    /* The maximise control's name follows the window's state rather than
       claiming one of them. */
    expect(controls).toMatch(/maximized \? "Restore window" : "Maximise window"/u);
    /* macOS renders none of ours: its lights are drawn by the system, and two
       sets of controls is worse than the white caption we started with. */
    expect(controls).toMatch(/if \(!owned\) return null/u);
    expect(controls).toMatch(/platform === "windows" \|\| platform === "linux"/u);
    /* The state follows the WINDOW, not our clicks, or the icon drifts the
       first time anything else resizes it. */
    expect(controls).toMatch(/onResized/u);
  });

  test("what Tauri gives and what remains ours is written where it is owed", async () => {
    const controls = await readFile(
      path.join(desktopRoot, "src", "components", "window-controls.tsx"),
      "utf8"
    );
    /* The free half, so nobody reimplements it. */
    expect(controls).toMatch(/DOUBLE-CLICK to maximise/u);
    expect(controls).toMatch(/drag-to-edge snapping/u);
    /* The owed half, named rather than discovered: the Snap Layouts hover
       flyout needs WM_NCHITTEST, and the caption right-click menu is absent. */
    expect(controls).toMatch(/Snap Layouts flyout/u);
    expect(controls).toMatch(/HTMAXBUTTON/u);
    expect(controls).toMatch(/right-click system menu/u);
  });

  /* Measured on the installed app before this existed: every window call
     answered "Command plugin:window|... not allowed by ACL". With the system
     caption gone and no window permissions, the window could not be moved,
     maximised or closed -- strictly worse than the white title bar it replaced.
     Tauri's drag script is not exempt: it invokes `start_dragging` and
     `internal_toggle_maximize` through the same gate, so the header looked
     draggable and was not. */
  test("the window permissions the title bar needs are granted, and nothing wider", async () => {
    const capability = JSON.parse(
      await readFile(path.join(desktopRoot, "src-tauri", "capabilities", "default.json"), "utf8")
    ) as { permissions: string[]; description: string };

    const windowGrants = capability.permissions.filter((entry) => entry.startsWith("core:window:"));
    expect(new Set(windowGrants)).toEqual(
      new Set([
        /* the drag script's two */
        "core:window:allow-start-dragging",
        "core:window:allow-internal-toggle-maximize",
        /* the three controls we draw */
        "core:window:allow-minimize",
        "core:window:allow-toggle-maximize",
        "core:window:allow-close",
        /* the state the maximise control names itself from */
        "core:window:allow-is-maximized"
      ])
    );
    /* `core:window:default` would grant the whole plugin surface -- creating
       windows, setting positions, reading monitors -- for a title bar. */
    expect(windowGrants).not.toContain("core:window:default");

    /* The resize event the icon follows, and nothing that lets webview code
       emit events into the shell. */
    const eventGrants = capability.permissions.filter((entry) => entry.startsWith("core:event:"));
    expect(new Set(eventGrants)).toEqual(
      new Set(["core:event:allow-listen", "core:event:allow-unlisten"])
    );
    expect(eventGrants.some((entry) => entry.includes("emit"))).toBe(false);

    /* Why the widening happened, recorded where the widening is. */
    expect(capability.description).toMatch(/not\s+"?allowed by ACL/u);
  });

  test("platform detection adds no dependency and degrades outside the shell", async () => {
    const controls = await readFile(
      path.join(desktopRoot, "src", "components", "window-controls.tsx"),
      "utf8"
    );
    /* The replay harness serves this bundle in a plain browser, where there is
       no window to control; the absence of the shell is the check. */
    expect(controls).toMatch(/__TAURI_INTERNALS__/u);
    const packageJson = JSON.parse(
      await readFile(path.join(desktopRoot, "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain("@tauri-apps/plugin-os");
  });
});
