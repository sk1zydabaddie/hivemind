import { useEffect, useRef } from "react";

import { attentionItems, announcement, newAttention } from "@/lib/attention";
import type { WorkspaceInspection } from "@/lib/workspace-actions";

/**
 * Sends the notification, and brings the person back to the decision.
 *
 * Split from `attention.ts` on purpose: everything about *what* is worth
 * interrupting for is pure and tested there, and this file holds only the parts
 * that cannot be — the plugin call, the permission prompt, and the window.
 *
 * ## Three ways this can be silent, and only one is a bug
 *
 * - **The app is closed.** Nothing fires, and Hivemind does not run a
 *   background service to fix that. A daemon that notifies while the app is
 *   shut is a different product with a different trust story.
 * - **Permission was refused.** The person said no; that is an answer.
 * - **Windows toasts need a Start-menu shortcut with an AppUserModelID**, which
 *   the NSIS installer creates and `tauri dev` does not. So this can work in
 *   the installed build and be silent in development — the inverse of the
 *   `bundle.icon` failure, and worth knowing before concluding it is broken.
 */
export function useAttention(
  inspection: WorkspaceInspection | null,
  onOpen: () => void
): void {
  /* `null` until the first inspection has been recorded. Everything already
     waiting when the app opens is baseline, not news -- it is on screen. */
  const seen = useRef<ReadonlySet<string> | null>(null);
  const granted = useRef<boolean | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  /* Clicking the toast is the whole point of sending it: it has to land on the
     thing that needs deciding rather than on whatever was last open. */
  useEffect(() => {
    let stop: (() => void) | null = null;
    let abandoned = false;
    void (async () => {
      try {
        const [{ onAction }, { getCurrentWindow }] = await Promise.all([
          import("@tauri-apps/plugin-notification"),
          import("@tauri-apps/api/window")
        ]);
        const listener = await onAction(() => {
          void getCurrentWindow()
            .setFocus()
            .catch(() => {
              /* Focus is best-effort; the navigation below still happens. */
            });
          openRef.current();
        });
        if (abandoned) listener.unregister();
        else stop = () => listener.unregister();
      } catch {
        /* Outside the shell -- the replay harness has no plugin. The surface
           renders identically; it simply never notifies. */
      }
    })();
    return () => {
      abandoned = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (inspection === null) return;
    const current = attentionItems(inspection.needs_you);
    const { announce, seen: next } = newAttention(seen.current, current);
    seen.current = next;
    const message = announcement(announce);
    if (message === null) return;

    void (async () => {
      try {
        const plugin = await import("@tauri-apps/plugin-notification");
        if (granted.current === null) {
          granted.current =
            (await plugin.isPermissionGranted()) ||
            (await plugin.requestPermission()) === "granted";
        }
        if (!granted.current) return;
        plugin.sendNotification({ title: message.title, body: message.body });
      } catch {
        /* Same as above: no plugin, no notification, no error on screen. */
      }
    })();
  }, [inspection]);
}
