/**
 * The controls that answer when pressed, and therefore may claim relief.
 *
 * ## This does not weaken the relief rule; it applies it
 *
 * The rule in `styles.css` has never been "only buttons". It is:
 *
 * > **Relief is a claim about AFFORDANCE, not importance, and only an object
 * > that answers when pressed may make it.**
 *
 * A checkbox answers when pressed. So does a radio, and a switch. Each takes a
 * press and returns a state change caused by that press, which is exactly the
 * redemption the rule demands — the same redemption a button offers and a panel
 * never can. `--shadow-panel` is still deleted for the same reason it always was.
 *
 * So the enforcement is identical rather than relaxed: every control in this
 * file carries one of the shared relief pairs at rest and on `:active`, plus a
 * downward translate. Compact and micro tokens keep the geometry legible at
 * native size without copying shadow values into the component.
 *
 * ## Why these are built rather than taken
 *
 * The behaviour is Radix's (already a dependency, and keyboard semantics are not
 * worth re-deriving); every visual decision is this project's. Per the standing
 * rule about component sources: take structure and interaction logic, never
 * styling opinions.
 *
 */
import { Checkbox as CheckboxPrimitive, RadioGroup as RadioGroupPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { CheckIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The raised-and-pressed pair, in one place.
 *
 * Tokens are declared once in styles.css so a control cannot locally invent a
 * stronger or weaker shadow. Movement still separates a press from a repaint.
 */
const PRESSABLE =
  /* At compact control size, the general button relief compresses into a single dark edge.
     These are the SAME paired tokens and the SAME press, with crisper compact
     values: a two-pixel base and contact shadow survive native-scale rendering
     while the outer blur stays below the attention edge's visual weight. */
  "cursor-pointer shadow-[var(--relief-compact)] transition-[background-color,box-shadow,translate] duration-[120ms] ease-[var(--spring)] active:translate-y-[1px] active:shadow-[var(--relief-compact-pressed)] active:duration-[60ms] disabled:cursor-default disabled:shadow-none disabled:opacity-45";

/** Checked fills use the same Hivemind primary face as a committed action. */
const CHECKED_FILL =
  "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground";

export function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>): React.JSX.Element {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-sm border border-input bg-canvas text-transparent outline-none",
        PRESSABLE,
        CHECKED_FILL,
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="grid place-items-center text-current"
        data-slot="checkbox-indicator"
      >
        <CheckIcon aria-hidden="true" className="size-[13px] stroke-[3]" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export const RadioGroup = RadioGroupPrimitive.Root;

export function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>): React.JSX.Element {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio"
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-full border border-input bg-canvas outline-none",
        PRESSABLE,
        CHECKED_FILL,
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        className="size-1.5 rounded-full bg-current"
        data-slot="radio-indicator"
      />
    </RadioGroupPrimitive.Item>
  );
}

/**
 * A switch, where the relief belongs to the THUMB.
 *
 * The track is a groove — a recess in the surface, which is the one thing that
 * legitimately reads as *below* rather than above, and it never claims to be
 * pressable. The thumb is the part a finger moves, so the thumb is raised and
 * the thumb depresses. Putting relief on the track would say the whole control
 * lifts off the surface, which is not what a switch does.
 */
export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "group relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-input bg-canvas outline-none",
        /* The groove: an inset shadow, and inset only. A switch track is the
           inverse of relief and must never be confused for it. */
        "shadow-[inset_0_1px_2px_0_color-mix(in_oklab,#000000_18%,transparent)]",
        "transition-colors duration-[120ms] ease-[var(--spring)]",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        "disabled:cursor-default disabled:opacity-45",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          /* The 12px thumb gets its form from the micro relief. The track is
             the recessed part and stays flat. */
          "pointer-events-none block size-3 rounded-full bg-panel",
          "data-[state=checked]:translate-x-[14px]",
          /* `group-active:` rather than `active:`: the pointer lands on the
             track, so `active:` on the thumb never fires. */
          "shadow-[var(--relief-micro)] translate-x-[2px] transition-[translate,box-shadow] duration-[120ms] ease-[var(--spring)] group-active:shadow-[var(--relief-micro-pressed)] group-active:translate-y-[1px]"
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}
