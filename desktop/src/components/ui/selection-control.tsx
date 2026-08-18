import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * One visual language for controls whose persistent meaning is selection.
 *
 * A selected option is not a primary command, so it uses the quiet control
 * ramp. Selection remains expressed by navy wash and border; relief only says
 * the option answers a press. Keeping these sizes here prevents settings
 * cards, model chips, segmented controls, and pane toggles from independently
 * inventing their own pressure, type, radius, and spacing.
 */
const selectionControlVariants = cva(
  "cursor-pointer border border-navy-deep bg-gradient-to-b from-quiet-lift to-quiet-deep text-left text-primary-foreground shadow-[var(--control-relief)] transition-[color,background-color,border-color,box-shadow,transform] duration-[120ms] ease-[var(--spring)] [--control-relief:var(--relief-compact)] [--control-relief-pressed:var(--relief-compact-pressed)] [--press-distance:1px] hover:from-quiet hover:to-quiet-deep active:translate-y-[var(--press-distance)] active:shadow-[var(--control-relief-pressed)] active:duration-[60ms] disabled:pointer-events-none disabled:cursor-default disabled:bg-canvas disabled:bg-none disabled:text-muted-foreground disabled:shadow-none disabled:opacity-45 [&_*]:!text-[inherit]",
  {
    variants: {
      shape: {
        card: "w-full rounded-md p-3 aria-[pressed=true]:border-navy-lift aria-[pressed=true]:from-navy aria-[pressed=true]:to-navy-deep",
        chip: "rounded-sm px-2 py-1 aria-[pressed=true]:border-navy-lift aria-[pressed=true]:from-navy aria-[pressed=true]:to-navy-deep",
        segment: "h-6 px-2 text-[11px] font-medium aria-[pressed=true]:from-navy aria-[pressed=true]:to-navy-deep",
        pane: "rounded-sm px-2.5 py-1 text-[12px] aria-[pressed=true]:from-navy aria-[pressed=true]:to-navy-deep aria-[pressed=true]:font-medium",
        graph: "relative grid content-start gap-2.5 overflow-hidden rounded-md border border-l-2 px-3 py-2.5 ring-2 aria-[pressed=true]:border-navy-lift aria-[pressed=true]:border-l-navy-lift aria-[pressed=true]:from-navy aria-[pressed=true]:to-navy-deep aria-[pressed=true]:ring-white/20",
        lane: "group grid min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-2 rounded-md px-2.5 pt-2.5 pb-2 aria-[pressed=true]:border-navy-lift aria-[pressed=true]:from-navy aria-[pressed=true]:to-navy-deep",
        task: "lane group relative flex w-full items-start gap-2.5 py-2.5 pr-3 pl-2.5 aria-[pressed=true]:from-navy aria-[pressed=true]:to-navy-deep",
        tree: "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-[12px] leading-tight aria-[pressed=true]:from-navy aria-[pressed=true]:to-navy-deep aria-[pressed=true]:font-medium"
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
