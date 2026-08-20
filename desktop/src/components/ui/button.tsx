import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/* Orca-derived geometry and density, expressed through Hivemind's existing
 * primitive. The committed-action variant owns the one Hivemind signature
 * face and its press redemption; every utility variant stays in the surface
 * plane and remains solid. */
const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-md border border-transparent bg-transparent text-sm leading-none font-medium whitespace-nowrap outline-none transition-[color,background-color,border-color,box-shadow,transform] duration-[120ms] ease-[var(--spring)] [--control-relief:var(--relief)] [--control-relief-pressed:var(--relief-pressed)] [--press-distance:2px] focus-visible:border-navy focus-visible:ring-[3px] focus-visible:ring-navy/25 active:duration-[60ms] disabled:pointer-events-none disabled:cursor-default disabled:border-rule disabled:bg-surface disabled:bg-none disabled:text-muted-foreground disabled:shadow-none disabled:opacity-50 aria-invalid:border-destructive [&_kbd]:bg-transparent [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-primary/80 bg-primary bg-[image:var(--primary-face)] text-primary-foreground shadow-[var(--control-relief)] hover:bg-[image:var(--primary-face-hover)] active:translate-y-[var(--press-distance)] active:bg-[image:var(--primary-face-pressed)] active:shadow-[var(--control-relief-pressed)] [&_*]:!text-[inherit] [&_kbd]:border-white/30",
        destructive:
          "border-clay-deep bg-clay text-destructive-foreground shadow-[var(--control-relief)] hover:bg-clay/90 active:translate-y-[var(--press-distance)] active:bg-clay/80 active:shadow-[var(--control-relief-pressed)] [&_*]:!text-[inherit] [&_kbd]:border-white/30",
        "ghost-destructive":
          "text-clay hover:border-clay/20 hover:bg-clay-wash active:bg-clay-wash",
        "outline-destructive":
          "border-clay/35 bg-canvas text-clay shadow-[0_1px_2px_rgb(0_0_0/0.24)] hover:border-clay/55 hover:bg-clay-wash active:bg-clay-wash",
        outline:
          "border-input bg-canvas text-ink shadow-[0_1px_2px_rgb(0_0_0/0.24)] hover:border-muted-foreground/35 hover:bg-surface active:bg-surface-strong",
        secondary:
          "bg-surface text-ink hover:bg-surface-strong active:bg-surface-strong/80",
        ghost:
          "text-muted-foreground hover:bg-surface hover:text-ink active:bg-surface-strong",
        link:
          "text-navy underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 px-2 text-[12px] [--control-relief:var(--relief-micro)] [--control-relief-pressed:var(--relief-micro-pressed)] [--press-distance:1px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 text-[13px] [--control-relief:var(--relief-compact)] [--control-relief-pressed:var(--relief-compact-pressed)] [--press-distance:1px] has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 [--control-relief:var(--relief-micro)] [--control-relief-pressed:var(--relief-micro-pressed)] [--press-distance:1px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 [--control-relief:var(--relief-compact)] [--control-relief-pressed:var(--relief-compact-pressed)] [--press-distance:1px]",
        "icon-lg": "size-10",
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
