import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The window's own minimise / maximise / close, drawn by the app.
 *
 * WHY THE APP DRAWS THEM. The native Windows caption is painted by the system
 * in the system's colour, which above a dark app reads as two stacked
 * programs. The apps that solve this -- VS Code, Discord, Claude's own desktop
 * app -- extend their chrome to the window edge and put the controls inside it.
 * In Electron that is nearly free because Chromium implements the non-client
 * behaviours. In Tauri some of it is ours, so what we get and what we owe is
 * written down here rather than discovered later:
 *
 *   FREE, from Tauri 2.11's own drag script (read, not assumed):
 *     - dragging the window by the header
 *     - DOUBLE-CLICK to maximise (`e.detail === 2` -> internal_toggle_maximize,
 *       with the macOS cancel-on-move variant)
 *     - clicks on tabs and buttons never drag: its `isClickableElement` blocks
 *       drag for BUTTON, anything with `tabindex`, and `role` in
 *       {button, link, menuitem, tab, ...}. Radix `TabsTrigger` renders
 *       `<button role="tab">`, so a tab is excluded on both counts.
 *     - drag-to-edge snapping, because `start_dragging` hands the drag to the OS
 *     - Win+Arrow keyboard management, a system command on the window
 *
 *   OURS, and deliberately NOT implemented yet -- named so nobody discovers
 *   them as surprises:
 *     - the Windows 11 Snap Layouts flyout that appears when you HOVER the
 *       maximise button. It needs WM_NCHITTEST to answer HTMAXBUTTON, which
 *       means subclassing the window. Dragging to an edge and Win+Arrow both
 *       still snap; only the hover flyout is missing.
 *     - the right-click system menu on the caption strip.
 *
 * Platform is read from the user agent rather than the OS plugin: this decides
 * a chrome layout, the plugin would be a new dependency in the shell for one
 * string, and every webview this ships in names its OS there.
 *
 * "Am I in the shell" is asked as CAN I ADDRESS A WINDOW, not as "does the
 * bridge object exist". The replay harness DEFINES `__TAURI_INTERNALS__` with
 * an invoke stub that throws for any command it has no answer for, so the
 * presence of the bridge is not evidence of a window -- `getCurrentWindow()`
 * reads metadata the stub does not carry and threw during render, blanking
 * every replayed surface. Caught by the reachability check, which is the one
 * thing here that runs the real bundle in a real browser.
 */
function addressableWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
    const current = getCurrentWindow();
    /* A label is what every window command is addressed by; without one there
       is nothing to minimise. */
    return typeof current?.label === "string" && current.label !== "" ? current : null;
  } catch {
    return null;
  }
}

function platformName(): "windows" | "macos" | "linux" | "browser" {
  if (addressableWindow() === null) return "browser";
  const agent = navigator.userAgent;
  if (/Macintosh|Mac OS X/u.test(agent)) return "macos";
  if (/Windows/u.test(agent)) return "windows";
  return "linux";
}

export function WindowControls(): React.JSX.Element | null {
  const platform = platformName();
  const [maximized, setMaximized] = useState(false);
  const owned = platform === "windows" || platform === "linux";

  useEffect(() => {
    if (!owned) return undefined;
    let abandoned = false;
    const current = addressableWindow();
    if (current === null) return undefined;
    const sync = async (): Promise<void> => {
      try {
        const next = await current.isMaximized();
        if (!abandoned) setMaximized(next);
      } catch {
        /* A window that cannot be asked is not a window we can label. */
      }
    };
    void sync();
    /* The icon follows the WINDOW, however it changed -- double-click on the
       header, Win+Up, a snap, or this button -- rather than following our own
       clicks, which would drift the moment anything else resized it. */
    const unlisten = current.onResized(() => void sync());
    return () => {
      abandoned = true;
      void unlisten.then((stop) => stop());
    };
  }, [owned]);

  /* macOS draws its own traffic lights top left and the header reserves room
     for them instead; drawing ours too would be two sets of controls. */
  if (!owned) return null;
  const current = addressableWindow();
  if (current === null) return null;
  const button =
    "inline-flex h-full w-[46px] shrink-0 items-center justify-center text-muted-foreground transition-colors duration-[var(--motion-fast)] hover:bg-surface hover:text-ink focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-navy/45";

  return (
    /* Buttons, which Tauri's own rule already excludes from dragging; this
       wrapper carries no drag attribute so it cannot re-admit them. */
    <div className="-mr-2.5 ml-1 flex shrink-0 items-stretch self-stretch">
      <button
        aria-label="Minimise window"
        className={button}
        title="Minimise"
        type="button"
        onClick={() => void current.minimize()}
      >
        <Minus aria-hidden="true" className="size-4" />
      </button>
      <button
        aria-label={maximized ? "Restore window" : "Maximise window"}
        className={button}
        title={maximized ? "Restore" : "Maximise"}
        type="button"
        onClick={() => void current.toggleMaximize()}
      >
        {maximized ? (
          <Copy aria-hidden="true" className="size-3.5" />
        ) : (
          <Square aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <button
        aria-label="Close window"
        /* The one hover that is not the neutral wash: closing is destructive
           and every platform marks it that way. */
        className={`${button} hover:bg-clay hover:text-white`}
        title="Close"
        type="button"
        onClick={() => void current.close()}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

/**
 * Whether the header must reserve space for macOS's traffic lights.
 *
 * A layout difference rather than a styling one: the lights sit at the window's
 * top left, over our content, so the brand mark starts to their right.
 */
export function trafficLightInset(): boolean {
  return platformName() === "macos";
}
