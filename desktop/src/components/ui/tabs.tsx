import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

export function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>): React.JSX.Element {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex min-h-0 flex-col", className)}
      {...props}
    />
  );
}

export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>): React.JSX.Element {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex h-full items-stretch", className)}
      {...props}
    />
  );
}

/**
 * Navigation is cut into the chrome rather than placed on top of it. The
 * underline is location, the hover wash is affordance, and neither makes the
 * tab compete with a command action for physical weight.
 */
export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        /* The focus ring is inset: a tab outlined one pixel clear of itself
           reads as a floating box rather than as a focused tab. */
        "relative inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent px-2.5 text-[13px] font-medium text-muted-foreground transition-[color,background-color] duration-[120ms] before:absolute before:bottom-[-1px] before:left-2.5 before:z-1 before:size-[5px] before:origin-center before:scale-0 before:bg-navy before:transition-transform before:duration-[120ms] before:[clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)] after:absolute after:right-2.5 after:bottom-0 after:left-3.5 after:h-[2px] after:origin-left after:scale-x-0 after:bg-navy after:transition-transform after:duration-[120ms] hover:bg-surface/70 hover:text-ink active:bg-surface focus-visible:outline-offset-[-3px]",
        "data-[state=active]:bg-transparent data-[state=active]:text-ink data-[state=active]:before:scale-100 data-[state=active]:after:scale-x-100",
        "[&>svg]:size-3.5 [&>svg]:shrink-0",
        className
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>): React.JSX.Element {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("min-h-0 flex-1 outline-none", className)}
      {...props}
    />
  );
}
