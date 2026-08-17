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
 * So the enforcement is identical rather than relaxed: every control in this file
 * carries `--relief` at rest, `--relief-pressed` on `:active`, and a downward
 * translate, and `design-tokens.test.ts` checks each class string on its own
 * terms — the per-variant check, not a per-file one, because a file-level check
 * let one of the two button variants lose its press and still pass.
 *
 * ## Why these are built rather than taken
 *
 * The behaviour is Radix's (already a dependency, and keyboard semantics are not
 * worth re-deriving); every visual decision is this project's. Per the standing
 * rule about component sources: take structure and interaction logic, never
 * styling opinions.
 *
 * ## The one thing that is NOT here
 *
 * Tabs. A selected tab is a state, not a press — see `tabs.tsx` for why that
 * distinction is load-bearing rather than pedantic.
 */
import { Checkbox as CheckboxPrimitive, RadioGroup as RadioGroupPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { CheckIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The raised-and-pressed pair, in one place.
 *
 * Written once and shared so a control cannot take half of it. The three parts
 * are the raised shadow, the pressed shadow, and the movement — and it is the
 * movement that separates a press from a repaint, so it is not optional.
 */
const PRESSABLE =
  /* At 16px, the general button relief compresses into a single dark edge.
     These are the SAME paired tokens and the SAME press, with crisper compact
     values: a two-pixel base and contact shadow survive native-scale rendering
     while the outer blur stays below the attention edge's visual weight. */
  "cursor-pointer [--relief:inset_0_1px_0_#ffffffb8,inset_0_-2px_0_#000000a3,inset_0_0_0_1px_#00000045,0_2px_0_#0000005c,0_4px_6px_-3px_#00000073] [--relief-pressed:inset_0_2px_3px_#00000080,inset_0_1px_0_#0000006b,inset_0_-1px_0_#ffffff5c,inset_0_0_0_1px_#00000052] shadow-[var(--relief)] transition-[background-color,box-shadow,translate] duration-[120ms] ease-[var(--spring)] active:translate-y-[2px] active:shadow-[var(--relief-pressed)] active:duration-[60ms] disabled:cursor-default disabled:shadow-none disabled:opacity-45";

/** Checked fills use the same single-hue ramp as a filled button. */
const CHECKED_FILL =
  "data-[state=checked]:bg-navy data-[state=checked]:bg-gradient-to-b data-[state=checked]:from-navy-lift data-[state=checked]:to-navy-deep data-[state=checked]:text-primary-foreground";

export function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>): React.JSX.Element {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-sm border border-rule bg-panel text-transparent outline-none",
        PRESSABLE,
        CHECKED_FILL,
        "data-[state=checked]:border-navy-deep",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="grid place-items-center text-current"
        data-slot="checkbox-indicator"
      >
        <CheckIcon aria-hidden="true" className="size-3 stroke-[3]" />
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
        "grid size-4 shrink-0 place-items-center rounded-full border border-rule bg-panel outline-none",
        PRESSABLE,
        CHECKED_FILL,
        "data-[state=checked]:border-navy-deep",
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
        "group relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-rule bg-canvas outline-none",
        /* The groove: an inset shadow, and inset only. A switch track is the
           inverse of relief and must never be confused for it. */
        "shadow-[inset_0_1px_2px_0_color-mix(in_oklab,#000000_18%,transparent)]",
        "transition-colors duration-[120ms] ease-[var(--spring)]",
        "data-[state=checked]:border-navy-deep data-[state=checked]:bg-navy",
        "disabled:cursor-default disabled:opacity-45",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          /* No ramp. A 12px thumb gets its form from the relief, and a
             panel-to-canvas gradient would be a two-token ramp -- white to
             near-white is not what the single-hue rule guards against, but
             carving a neutral exception into a rule is worse than not needing
             one. */
          "pointer-events-none block size-3 rounded-full bg-panel",
          "data-[state=checked]:translate-x-[14px]",
          /* The pair in ONE string, deliberately. Split across two literals for
             readability it read as a raised thumb with no press, because the
             enforcement examines each class string on its own -- and that
             per-string check is there because a per-file one let a button
             variant lose its press silently. Keeping the pair adjacent is the
             point of it being a pair.
             `group-active:` rather than `active:`: the pointer lands on the
             track, so `active:` on the thumb never fires. */
          "[--relief:inset_0_1px_0_#ffffffb8,inset_0_-2px_0_#000000a3,inset_0_0_0_1px_#00000045,0_2px_0_#0000005c,0_4px_6px_-3px_#00000073] [--relief-pressed:inset_0_2px_3px_#00000080,inset_0_1px_0_#0000006b,inset_0_-1px_0_#ffffff5c,inset_0_0_0_1px_#00000052] shadow-[var(--relief)] translate-x-[2px] transition-[translate,box-shadow] duration-[120ms] ease-[var(--spring)] group-active:shadow-[var(--relief-pressed)] group-active:translate-y-[2px]"
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}
