import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva("badge", {
  variants: {
    tone: {
      neutral: "badge-neutral",
      live: "badge-live",
      good: "badge-good",
      warning: "badge-warning",
      danger: "badge-danger"
    }
  },
  defaultVariants: {
    tone: "neutral"
  }
});

export function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>): React.JSX.Element {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props} />
  );
}
