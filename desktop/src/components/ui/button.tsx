import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/* Conformed to the token contract: 4px corners, 13px label, 1px edges, and no
 * ring of its own -- focus is the single navy hairline declared once in
 * styles.css, so every focusable thing in the app agrees.
 *
 * Icons are 14px at stroke 1.75 to match the rest of the instrument; the
 * generated component's 16px/stroke-2 read a size too loud beside 13px text.
 */
const buttonVariants = cva(
  /* A disabled control is never filled. A navy button at 45% opacity still
     reads as pressable -- "Start building" sat over an empty box looking like
     it would do something -- so the filled variants drop to the canvas instead
     of fading. */
  /* Motion: a spring curve on colour AND transform, so a press reads as the
     surface giving way rather than as a repaint. `active:` goes DOWN past rest
     -- returning to zero would feel like nothing happened. */
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 overflow-hidden rounded-md border border-transparent bg-transparent text-[13px] leading-none font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-[120ms] ease-[var(--spring)] [--control-relief:var(--relief)] [--control-relief-pressed:var(--relief-pressed)] [--press-distance:2px] active:duration-[60ms] disabled:pointer-events-none disabled:cursor-default disabled:border disabled:border-rule disabled:bg-canvas disabled:bg-none disabled:text-muted-foreground disabled:shadow-none aria-invalid:border-destructive [&_kbd]:bg-transparent [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        /* Relief is reserved for committed actions. Quiet utilities still
           answer a press, but they sit in the chrome or content plane and use
           fill, border and focus instead of pretending to be raised objects. */
        /* The permitted gradient, and now with enough range to be seen as
           one: `-lift` at the top, `-deep` at the bottom, both mixes of the
           same meaning colour. Same hue, two stops, top to bottom -- what a
           physical control looks like, not what a template looks like. The
           multi-hue two-colour button is the AI-default tell this whole visual
           language exists to avoid, and widening a single-hue ramp does not
           move it any closer to that.
           Strong actions use the full hue. Outline, ghost, secondary, and link
           use its pale derived ramp so they retain hierarchy while agreeing
           that they answer a press.
           Three states, three distinct fills: at rest the ramp runs lift ->
           deep, hover darkens the top stop so the ramp compresses as though
           already yielding, and active flattens to `deep` outright -- a pressed
           face is out of the light, so a lit ramp on it would contradict the
           shadow. */
        /* Raised at rest, pressed in on `active:`. The two shadows are a pair
           declared together in styles.css -- see the rule there for why a
           button may look proud of the surface and a panel may not. */
        default:
          "border-navy-deep bg-navy bg-gradient-to-b from-navy-lift to-navy-deep text-primary-foreground shadow-[var(--control-relief)] hover:from-navy hover:to-navy-deep active:translate-y-[var(--press-distance)] active:from-navy-deep active:to-navy-deep active:shadow-[var(--control-relief-pressed)] [&_*]:!text-[inherit] [&_kbd]:border-white/30",
        destructive:
          "border-clay-deep bg-clay bg-gradient-to-b from-clay-lift to-clay-deep text-destructive-foreground shadow-[var(--control-relief)] hover:from-clay hover:to-clay-deep active:translate-y-[var(--press-distance)] active:from-clay-deep active:to-clay-deep active:shadow-[var(--control-relief-pressed)] [&_*]:!text-[inherit] [&_kbd]:border-white/30",
        "ghost-destructive":
          "text-clay hover:border-clay/20 hover:bg-clay-wash active:bg-clay-wash",
        "outline-destructive":
          "border-clay/35 bg-panel/72 text-clay hover:border-clay/55 hover:bg-clay-wash active:bg-clay-wash",
        outline:
          "border-rule bg-panel/72 text-navy hover:border-navy/30 hover:bg-navy-wash/72 active:bg-navy-wash",
        secondary:
          "border-rule bg-navy-wash/48 text-navy hover:border-navy/25 hover:bg-navy-wash active:bg-navy-wash",
        ghost:
          "text-navy hover:border-navy/15 hover:bg-navy-wash/72 active:bg-navy-wash",
        link:
          "text-navy underline-offset-2 hover:bg-navy-wash/60 hover:underline active:bg-navy-wash",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 px-2 text-[12px] [--control-relief:var(--relief-micro)] [--control-relief-pressed:var(--relief-micro-pressed)] [--press-distance:1px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 px-2.5 text-[12px] [--control-relief:var(--relief-compact)] [--control-relief-pressed:var(--relief-compact-pressed)] [--press-distance:1px] has-[>svg]:px-2",
        lg: "h-9 px-4 has-[>svg]:px-3.5",
        icon: "size-8",
        "icon-xs": "size-6 [--control-relief:var(--relief-micro)] [--control-relief-pressed:var(--relief-micro-pressed)] [--press-distance:1px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [--control-relief:var(--relief-compact)] [--control-relief-pressed:var(--relief-compact-pressed)] [--press-distance:1px]",
        "icon-lg": "size-9",
        inline: "h-6 px-1.5 text-[12px] [--control-relief:var(--relief-micro)] [--control-relief-pressed:var(--relief-micro-pressed)] [--press-distance:1px]",
        row: "h-auto min-h-9 w-full justify-start px-3 py-2.5 text-left [--control-relief:var(--relief-compact)] [--control-relief-pressed:var(--relief-compact-pressed)] [--press-distance:1px]",
        "row-sm": "h-9 w-full justify-start px-3 text-left [--control-relief:var(--relief-compact)] [--control-relief-pressed:var(--relief-compact-pressed)] [--press-distance:1px]",
        file: "h-auto min-h-6 w-full justify-start px-3 py-1 text-left font-mono text-[12px] break-all [--control-relief:var(--relief-micro)] [--control-relief-pressed:var(--relief-micro-pressed)] [--press-distance:1px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

/**
 * The button that started the work, showing the work.
 *
 * The action and its progress are ONE object. A button that starts a run and a
 * separate bar that reports it are two things a person has to associate; the
 * progress filling the control they just pressed needs no association at all.
 *
 * `ratio` is real or it is absent. It comes from Core's own phase counts --
 * never from a timer, never from an animation that advances on its own. A bar
 * that moves while nothing is happening is the thing this project refuses
 * everywhere else, and it would be worse here because it sits on the control
 * that appears to be causing it.
 *
 * `null` means "working, and nothing knows how far" -- rendered as a still
 * fill rather than an indeterminate sweep, because a sweep is motion carrying
 * no information.
 */
function ButtonProgress({ ratio }: { ratio: number | null }): React.JSX.Element {
  const clamped = ratio === null ? null : Math.max(0, Math.min(1, ratio));
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-0 bg-[color-mix(in_oklab,#fff_22%,transparent)] transition-[width] duration-[240ms] ease-[var(--spring)]"
      style={{ width: clamped === null ? "100%" : `${String(clamped * 100)}%` }}
      data-indeterminate={clamped === null ? "true" : undefined}
    />
  );
}

export { Button, ButtonProgress, buttonVariants }
