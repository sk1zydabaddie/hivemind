import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>): React.JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          /* Nearest depth: a tooltip is the one thing that is unambiguously
             above everything. Inverted, so the fill stays high (92%) -- light
             text on a dark chip loses more to translucency than dark on light,
             and a tooltip that is hard to read has failed at its only job. */
          "z-90 max-w-[320px] rounded-sm bg-ink/92 px-2 py-1.5 text-[12px] leading-snug text-panel shadow-[var(--elevation-overlay),var(--glass-edge-near)]",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
