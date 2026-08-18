<!-- Initialized by 21st, then corrected against repository sources. -->
# Project Design Context

## Project

- Name: Hivemind AI
- Product: compact Tauri desktop coding orchestrator
- Stack: Tauri 2, React 19, TypeScript 5, Tailwind CSS 4, Radix UI
- Mode: light
- Density: compact desktop instrument

## Sources of truth

- Tokens: `desktop/src/styles.css`
- Primitives: `desktop/src/components/ui/`
- Product surfaces: `desktop/src/components/workspace/`
- Rules and findings: `desktop/DESIGN-NOTES.md`
- Current status: `docs/STATE.md`

## Visual hierarchy

The canvas is atmospheric ground, panels are separated by one rule, and only
occluding content may use one of the three closed elevation levels. Explicit
command buttons may use the navy physical-control relief. Navigation,
suggestions, and selection rows remain flat and communicate state through
underline, fill, rules, hover, and focus instead of pretending to be buttons.

## Constraints

### Must

- Preserve the existing information architecture and audited dispatcher.
- Keep top navigation flat with an underline selected state.
- Keep example prompts as rule-separated rows without relief.
- Keep brand marks untinted and provider-correct.
- Preserve visible focus, keyboard behavior, responsive reachability, and
  non-motion liveness.
- Keep the amber attention edge as the visual-weight ceiling.

### Avoid

- Raised or pill-shaped navigation.
- Raised suggestion rows.
- White-on-white hierarchy.
- Backdrop filters, glass blur, decorative panel shadows, and unbounded
  gradients.
- Structural or workflow changes in the visual-only overhaul.

## Pending design selection

The 21st exploration phase is comparing three directions that all keep the
existing structure. No production direction is selected yet.
