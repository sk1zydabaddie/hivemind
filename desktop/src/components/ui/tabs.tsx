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
 * Tabs are controls, so they use compact relief like every other object that
 * answers a press. Their persistent selected state is still a separate claim:
 * navy fill and text identify location, while relief identifies affordance.
 * Neither state claims elevation; tabs occlude nothing and elevation remains a
 * closed, independently tested scale.
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
        "relative my-1.5 inline-flex cursor-pointer items-center gap-1.5 rounded-md border-0 bg-gradient-to-b from-quiet-lift to-quiet-deep px-2.5 text-[13px] font-medium text-muted-foreground shadow-[var(--relief-compact)] transition-[color,background-color,box-shadow,translate] duration-[120ms] ease-[var(--spring)] hover:from-quiet hover:to-quiet-deep hover:text-ink active:translate-y-[1px] active:shadow-[var(--relief-compact-pressed)] active:duration-[60ms] focus-visible:outline-offset-[-3px]",
        /* Selection changes the quiet ramp, not its physical construction. */
        "data-[state=active]:from-navy-wash data-[state=active]:to-quiet-deep data-[state=active]:text-navy",
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
