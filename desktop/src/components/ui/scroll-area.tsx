import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

export function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>): React.JSX.Element {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] outline-none"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        data-slot="scroll-area-scrollbar"
        className="flex w-2 touch-none border-l border-rule/70 p-0.5 select-none"
        orientation="vertical"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-sm bg-rule" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
