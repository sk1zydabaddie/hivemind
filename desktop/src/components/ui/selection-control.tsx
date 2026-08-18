import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One visual language for controls whose persistent meaning is selection.
 *
 * A selected option is not a primary command, so it does not borrow the
 * command button's gradient or raised resting shadow. Selection is expressed
 * by the navy wash and border; the brief press still moves and collapses into
 * the shared pressed token. Keeping these four sizes here prevents settings
 * cards, model chips, segmented controls, and pane toggles from independently
 * inventing their own pressure, type, radius, and spacing.
 */
const selectionControlVariants = cva(
  "cursor-pointer text-left transition-[color,background-color,border-color,box-shadow,transform] duration-[120ms] ease-[var(--spring)] active:translate-y-[2px] active:shadow-[var(--relief-pressed)] active:duration-[60ms] disabled:pointer-events-none disabled:cursor-default disabled:opacity-45",
  {
    variants: {
      shape: {
        card: "w-full rounded-md border border-rule bg-panel p-3 hover:border-navy/40 aria-[pressed=true]:border-navy aria-[pressed=true]:bg-navy-wash",
        chip: "rounded-sm border border-rule bg-panel px-2 py-1 hover:border-navy/40 aria-[pressed=true]:border-navy aria-[pressed=true]:bg-navy-wash",
        segment: "h-6 px-2 text-[11px] font-medium text-muted-foreground hover:text-ink aria-[pressed=true]:bg-navy-wash aria-[pressed=true]:text-navy",
        pane: "rounded-sm px-2.5 py-1 text-[12px] text-muted-foreground hover:text-ink aria-[pressed=true]:bg-panel aria-[pressed=true]:font-medium aria-[pressed=true]:text-ink",
        graph: "relative grid content-start gap-2.5 overflow-hidden rounded-md border border-l-2 bg-panel px-3 py-2.5 ring-2 aria-[pressed=true]:border-navy aria-[pressed=true]:border-l-navy aria-[pressed=true]:bg-navy-wash aria-[pressed=true]:ring-navy/20 aria-[pressed=true]:shadow-[var(--elevation-raised)]",
        lane: "group grid min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-2 rounded-md border border-transparent px-2.5 pt-2.5 pb-2 hover:bg-panel aria-[pressed=true]:border-navy/35 aria-[pressed=true]:bg-navy-wash",
        task: "lane group relative flex w-full items-start gap-2.5 bg-panel py-2.5 pr-3 pl-2.5 hover:bg-canvas aria-[pressed=true]:bg-navy-wash aria-[pressed=true]:shadow-[var(--elevation-raised)]"
      }
    },
    defaultVariants: { shape: "chip" }
  }
);

export function SelectionControl({
  active,
  className,
  shape,
  ...props
}: Omit<React.ComponentProps<"button">, "aria-pressed"> &
  VariantProps<typeof selectionControlVariants> & {
    active: boolean;
  }): React.JSX.Element {
  return (
    <button
      aria-pressed={active}
      className={cn(selectionControlVariants({ shape }), className)}
      data-slot="selection-control"
      data-shape={shape ?? "chip"}
      type="button"
      {...props}
    />
  );
}

export { selectionControlVariants };
