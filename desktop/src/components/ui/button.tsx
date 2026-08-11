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
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:cursor-default aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/88 disabled:border disabled:border-rule disabled:bg-canvas disabled:text-muted-foreground",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/88 disabled:border disabled:border-rule disabled:bg-canvas disabled:text-muted-foreground",
        outline:
          "border border-rule bg-panel text-ink hover:border-navy/45 hover:bg-navy-wash hover:text-navy disabled:opacity-45",
        secondary: "bg-secondary text-secondary-foreground hover:bg-rule/60 disabled:opacity-45",
        ghost: "text-muted-foreground hover:bg-canvas hover:text-ink disabled:opacity-45",
        link: "text-primary underline-offset-2 hover:underline disabled:opacity-45",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 px-2 text-[12px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 px-2.5 text-[12px] has-[>svg]:px-2",
        lg: "h-9 px-4 has-[>svg]:px-3.5",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
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

export { Button, buttonVariants }
