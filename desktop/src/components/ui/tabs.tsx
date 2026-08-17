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
 * Pills, and a decision about what relief is allowed to mean.
 *
 * ## The question
 *
 * Every pressable control in this app may now claim relief, because relief is a
 * claim about affordance and a pressed control redeems it. A tab is pressable.
 * So may a SELECTED tab stay raised?
 *
 * ## The call: no. Selection is not a press.
 *
 * Relief says "this responds to pressure", and it is redeemed *by the press* --
 * the rim inverts, the shadow collapses, the label drops, and then it all comes
 * back. That is a claim about what will happen when you push, and it is answered
 * in about 60ms.
 *
 * "This is the tab you are on" is a different claim entirely. It is persistent,
 * it is about location rather than affordance, and nothing about pressing
 * demonstrates it. A selected tab wearing a permanent pressed state would be
 * asserting it is mid-press indefinitely -- an animation frozen on one frame --
 * and a selected tab wearing a permanent RAISED state would look identical to
 * the three unselected ones beside it, which is the same failure the attention
 * edge rule guards against: if everything glows, nothing does.
 *
 * So the two claims get different devices, and this is the split:
 *
 *   - **Pressing** -> relief, on any tab, for as long as the press lasts.
 *   - **Being selected** -> a filled pill. Fill and colour, never elevation.
 *
 * That keeps one device for one meaning, which is the only reason the relief
 * rule has been worth enforcing at all.
 *
 * ## Why pills rather than the underline
 *
 * The underline read as chrome, which was the argument for it, and it lost on
 * looking: a 2px rule under 13px text is a smaller signal than the thing it is
 * marking. The pill is the shape asked for. 21st.dev's catalogue is still not
 * the source -- structure and interaction come from Radix, every visual decision
 * here is this project's.
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
        "relative my-1.5 inline-flex cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2.5 text-[13px] font-medium text-muted-foreground focus-visible:outline-offset-[-3px]",
        "transition-[color,background-color,box-shadow,translate] duration-[120ms] ease-[var(--spring)]",
        "hover:bg-canvas hover:text-ink",
        /* SELECTED: a filled pill. Fill and colour carry the state -- see the
           note above for why elevation deliberately does not. */
        "data-[state=active]:bg-navy-wash data-[state=active]:text-navy",
        /* PRESSED: the surface gives way. Flat at rest and pressed on `:active`,
           which is the honest pairing for chrome -- a tab does not sit proud of
           the toolbar, so claiming relief at rest would be the panel-shadow
           mistake with a hover state. What it does do is answer, and the answer
           is the depression plus the movement. `design-tokens.test.ts` enforces
           that half too: anything taking the pressed shadow must also move. */
        "active:translate-y-[2px] active:shadow-[var(--relief-pressed)] active:duration-[60ms]",
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
