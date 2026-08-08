import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/* Rules and tinted fills, never pills. `tone` is the vocabulary the workspace
   already speaks, so the prop is kept as-is. */
const badgeVariants = cva(
  "badge inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-sm border px-2 py-0.5 text-[12px] leading-4 font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:pointer-events-none",
  {
    variants: {
      tone: {
        neutral: "border-rule bg-surface text-muted-foreground",
        live: "border-navy/25 bg-navy-wash text-navy",
        good: "border-navy/25 bg-navy-wash text-navy",
        warning: "border-amber/35 bg-amber-wash text-amber",
        danger: "border-clay/35 bg-clay-wash text-clay"
      }
    },
    defaultVariants: {
      tone: "neutral"
    }
  }
);

export function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>): React.JSX.Element {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  );
}

export { badgeVariants };
