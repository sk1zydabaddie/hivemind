<!-- Initialized by 21st, then corrected against repository sources. -->
# Project Design Context

## Project

- Name: Hivemind AI
- Product: compact Tauri desktop coding orchestrator
- Stack: Tauri 2, React 19, TypeScript 5, Tailwind CSS 4, Radix UI
- Mode: dark
- Density: compact desktop instrument

## Sources of truth

- Tokens: `desktop/src/styles.css`
- Primitives: `desktop/src/components/ui/`
- Product surfaces: `desktop/src/components/workspace/`
- Rules and findings: `desktop/DESIGN-NOTES.md`
- Current status: `docs/STATE.md`

## Visual hierarchy

The canvas is solid navy-black ground. Four opaque surface steps, restrained
8% white rules, and lit top edges establish hierarchy; only occluding content
may use one of the three closed elevation levels. Explicit command buttons may
use the solid Hivemind-navy physical-control relief. Navigation, suggestions,
and selection rows remain flat and communicate state through underline, fill,
rules, hover, and focus instead of pretending to be buttons.

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
- White-on-white or light-theme hierarchy.
- Backdrop filters, glass blur, decorative panel shadows, and unbounded
  gradients.
- Atmospheric dot grids or decorative canvas fields.
- Structural or workflow changes in the visual-only overhaul.

## Selected direction

Orca-derived Hivemind superseded Precision Instrument on 2026-08-20. A fresh
clone of the official `stablyai/orca` repository at commit
`9d06b3ba938d3c5467de5b82b0bec322af2620a8` supplied concrete relationships:
its 10px curve and radius scale, compact 36px/32px controls, four opaque dark
surface steps, 7%/15% border hierarchy, and solid flat controls. Hivemind maps
those relationships into its navy palette and retains its existing relief rule
for committed actions. Its structure, navigation placement, workflows, copy,
and audited action paths remain fixed.

The grounded image and 21st catalogue record is in
`docs/evidence/ui-reference-research-2026-08-19/README.md`. No catalogue
component was installed: the useful patterns and the Orca source measurements
were conformed to the existing Hivemind primitives so the application retains
one component family.
