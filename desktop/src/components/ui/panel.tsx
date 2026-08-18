import type * as React from "react";

import { cn } from "@/lib/utils";

/* The four shapes every surface in this app is built from.
 *
 * They exist because "a panel" was previously a class string repeated in three
 * files, and three copies of a class string are three chances to disagree. The
 * inconsistency this removes is real: the Work rail, the Project record and the
 * plan review each had their own panel padding, their own header height and
 * their own idea of what a section label looked like.
 *
 * A panel is a bordered region on the canvas. It has NO shadow -- the 1px rule
 * and the canvas behind it are the separation, which is the whole visual
 * language here. There is no elevated variant, deliberately.
 */

export function Panel({
  className,
  children,
  ...props
}: React.ComponentProps<"section">): React.JSX.Element {
  return (
    <section
      data-slot="panel"
      className={cn(
        "grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-rule bg-panel/88",
        className
      )}
      {...props}
    >
      {children}
    </section>
  );
}

/* Every panel header is the same height and the same rhythm: a micro label on
   the left, a mono figure or a control on the right, one rule underneath. */
export function PanelHeader({
  className,
  children,
  ...props
}: React.ComponentProps<"header">): React.JSX.Element {
  return (
    <header
      data-slot="panel-header"
      className={cn(
        "flex h-9 shrink-0 items-center gap-3 border-b border-rule bg-canvas/82 shadow-[var(--glass-edge)] px-3",
        className
      )}
      {...props}
    >
      {children}
    </header>
  );
}

/* The instrument's one label voice: 11px, letterspaced, muted, uppercase. Used
   for panel headers, lane headings and field names, and nowhere else — if a
   piece of text is a heading rather than a label, it is set in sentence case at
   13px or larger instead. */
export function PanelLabel({
  className,
  children,
  ...props
}: React.ComponentProps<"h2">): React.JSX.Element {
  return (
    <h2
      data-slot="panel-label"
      className={cn(
        "m-0 text-[11px] leading-none font-medium tracking-label text-muted-foreground uppercase",
        className
      )}
      {...props}
    >
      {children}
    </h2>
  );
}

/* A figure that belongs to a label: always mono, always right of it. */
export function PanelCount({
  className,
  children,
  ...props
}: React.ComponentProps<"span">): React.JSX.Element {
  return (
    <span
      data-slot="panel-count"
      className={cn("ml-auto font-mono text-[11px] text-muted-foreground", className)}
      {...props}
    >
      {children}
    </span>
  );
}
