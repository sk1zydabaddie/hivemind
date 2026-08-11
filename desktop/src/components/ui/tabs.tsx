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

/* Sections are marked by a navy rule on the chrome's own edge, not by a raised
 * pill. 21st.dev's tabs (originui, and every other one in the catalogue) are the
 * same lifted-pill shape this app already had -- taking one would have changed
 * nothing except which file the opinion came from, so the underline is
 * hand-built. It costs four utilities and it makes the toolbar read as chrome
 * rather than as a widget sitting on top of chrome.
 */
export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        /* The focus ring is inset: a full-height tab outlined one pixel clear
           of itself reads as a floating box rather than as a focused tab. */
        "relative inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 text-[13px] font-medium text-muted-foreground transition-colors focus-visible:outline-offset-[-3px]",
        "after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent after:transition-colors",
        "hover:text-ink",
        "data-[state=active]:text-ink data-[state=active]:after:bg-navy",
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
