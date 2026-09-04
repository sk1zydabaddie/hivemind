# Desktop design and interaction contract

Current entrypoint, reconciled 2026-09-04. Core owns policy and authority; this
document describes their desktop presentation. Read [project state](../docs/STATE.md)
and [AGENTS.md](../AGENTS.md) before implementation. The
[historical design archive](archive/DESIGN-NOTES-2026-09-04.md) preserves every
earlier decision, measurement and superseded proposal.

## Product and surface ownership

Hivemind helps a person describe work, review what needs human judgment and ship
verified changes. It is not an editor, terminal or preview. Preserve the existing
Work, Agents and Project structure when changing visual styling; an effect does
not justify rearranging the application.

Work is the durable conversation and run record. Agents shows the team once
work exists; before that it explains that agents appear after the conversation
starts, without duplicating Work's composer. Project holds repository context
and history. Settings is one plain-language configuration surface; advanced
details are collapsed and unmounted until opened.

The thread reports readable answers, real stages and work that happened—not
hidden reasoning, provider JSON envelopes or fabricated activity. Authoritative
entries rebuild from durable events. Transient streamed output is not a new
source of truth. A blank transcript plus a footer spinner is not an adequate
response to a submitted message.

## One visual system

The current material is Orca-derived geometry with Hivemind's dark blue palette.
It supersedes the light palette, Precision Instrument and universal raised-button
experiments. Use the existing component family and tokens, not mixed libraries
or screenshot approximations. For a UI implementation using 21st, ground it in
these tokens and existing components; record what was actually used.

`src/styles.css` owns the palette, radius/spacing scale, depth and motion.
Current key colors are canvas `#07111c`, ground/panel `#0d1923`, surface
`#14253b`, stronger surface `#1e3553`, ink `#f4f7fb`, muted `#96a3b5`, primary
`#7fa9e4`, brand navy `#1b3a6b`, attention amber `#d4a95f`, danger clay
`#df786d`. Read the source before editing; do not duplicate this table as a
second set of constants.

- Use shared Button, SelectionControl, PanelHeader and Dialog primitives.
  Callers own placement and content, not their own colors, gradients, shadows,
  radii, heights or focus effects. Default controls are 36px; compact 32px.
- Rounded geometry uses the established 4/6/8/10/14/18/22px token family with
  10px base corners. The first-message composer uses 22px corners and aligned
  15px prompt text, attachments on the left and circular upward send on the right.
- Typography is Geist; Geist Mono is reserved for technical values. Primary
  surfaces use plain language and task titles, not identifiers such as `T-001`.
  Technical details belong in intentionally secondary disclosure surfaces.
- Borders, fills and ordered opaque planes establish depth. No backdrop filters:
  their compositing affects text antialiasing window-wide. No arbitrary shadows
  or gradients at call sites. Do not add decoration that competes with attention.

## Relief and elevation are different permissions

Relief says a control responds to pressure. It must redeem that claim with the
shared rest/pressed token pair: rim inversion, shadow collapse and movement
(2px default, 1px compact/micro). An enabled actionable control may have relief;
being interactive does not require it. Only the committed default Button has
the navy same-hue gradient. Destructive relief stays solid clay.

Outline, secondary, ghost, link, navigation and suggestion-selection surfaces
remain flat. `Choose another` is intentionally outline, not a missed raised
button. Selected navigation has a simple underline, no attached hexagon and no
elevation. Checkbox/radio/switch use compact relief with a solid checked fill,
not a transplanted full-size button gradient. Disabled controls must read as
unavailable; do not invent raised permission for an inert control.

Elevation says an object is above another and is redeemed by real occlusion or
separation from siblings. There are exactly three closed memberships: raised,
floating and overlay. The substrate and selection alone have no level. Follow
`test/elevation.test.ts`, not a new shadow on every panel.

The historical 14.7/255-over-11px amber measurement was made on the old light
palette; it is not a current pixel sample. Current elevation bounds are computed
against the dark ground by the test (raised 11.9, floating 14.7, overlay below
26 on the strongest channel). Only figures asserted against current tokens bind
the current skin. Preserve the attention hierarchy and remeasure a palette change.

## Composer, decoration and liveness

- Empty Work starts with one centered rounded composer, not an empty thread
  with its box at the bottom. After submission the conversation uses its docked
  composer. Do not restore the three canned suggestion buttons.
- The composer has a real attachment action and project-role selection. Keep
  the draft and attachments until Core accepts the request. Durable request IDs
  make retries idempotent; block duplicate submission rather than guessing state.
- The idle hexagon field is low contrast and bounded. It appears only on the
  intended idle/setup surfaces, not behind ongoing work. Hide it synchronously
  at first submission. Decorative drift uses the existing small travel and slow
  timing, under `prefers-reduced-motion: no-preference` only.
- Respect OS accessibility preferences. Reduced motion stops decoration, not
  factual reporting. A live operation needs changing stage/text or elapsed time
  even when its spinner is static. Never fabricate percentage or progress bars.
- Historical source-build/download indicators are not permission to restore
  retired update execution. If that capability is reintroduced through an
  approved release contract, source builds need real stage/elapsed reporting and
  downloads may use actual byte progress only.

## Setup, providers and project switching

Setup and Settings share one provider board: Codex, Claude Code, Grok Build and
OpenCode, all through their CLIs. Kimi Code is retired as a direct harness;
Moonshot inside OpenCode is an inner provider, not another Hivemind row.

Provider marks track labels in em units and load as same-origin emitted assets,
not CSP-blocked inlined data images. Claude keeps its brand orange; monochrome
OpenAI, Grok and OpenCode marks remain monochrome. Do not tint them to match a
selection or create fallback initials to hide a loading failure.

Executable presence, sign-in, project probe and product qualification are
separate states. Render Core's typed standing; unknown is not signed out.
Signed-in rows replace Sign in with a checkmark and status. Grok's explicit
negative authentication marker wins even when cached model headings follow.
Refresh/discovery does not run paid model generation. A capability probe does
use provider quota and must say so before the person starts it.

Sign-in hands off to the provider-owned fixed CLI flow, with observable status
and retry. Hivemind does not inspect or return credential contents. Model lists
come from installed-provider discovery; planner, manager and worker assignments
use exact discovered slugs rechecked by Core. Do not restore cheaper/balanced/
strongest marketing presets or hold authoritative role configuration in React.

Folder selection supports both the native OS folder picker and manual full
paths. Invalid manual input keeps the chooser open. Switching projects preserves
each project's own state and rejects stale asynchronous completions, including
startup last-project restoration. Navigation is not permission to cancel work.

Git setup is an explicit transaction: preview what will be included/excluded,
protect secrets, links and nested repositories, and roll back only owned changes.
An empty project may be initialized; do not force manual Git setup. Detected
check commands are suggestions, not consent to run arbitrary project scripts.
Setup must report actionable failures and remain retryable, not optimistic Done.

## Accessibility, scale and truthful state

The shell minimum is 800x620 **outer** pixels, corresponding to the tested
790x610 client. Also test 1280x720, 1366x768 and 1440x900. Controls may not be
partially clipped, obscured, outside the viewport or behind overflow ancestors.
Do not fix a minimum-window bug by assuming the outer size is the document size.

Conversation is a named, focusable log with polite additions; users must be able
to enter and scroll it with a keyboard. Virtual rendering and durable paging
bound large archives (Work 320 events/page, Project 160), with older content
reachable rather than silently discarded. Archive size must not become DOM size.

Dialogs choose initial focus, trap it and return it to the opening interaction.
Transient layers close in order. Inputs retain accessible labels; disabled
controls retain an accessible explanation and cannot receive accidental actions.
Center the idle run headline without colliding with its right-side controls.

Unknown usage is not zero. Provider subscription limits and internal token
ceilings are distinct. A retained Core capability has one honest consumer;
client-local response types and inferred booleans cannot replace shared typed
responses. Older durable records remain valid inputs through deliberate shared
compatibility handling. Chat and guidance never become approval or shipping.

## Verification and history

Run the Desktop suite, production build and `npm run verify:reachable`. The
reachability run also checks actual image loads, CSP/resource errors and
operation-scoped liveness; an unbounded component test does not verify layout.
For runtime changes, ship/install and observe the actual installed behavior with
its build number. Report only what was exercised, including failures and limits.

The unabridged 5,118-line former document is retained in the
[dated archive](archive/DESIGN-NOTES-2026-09-04.md) with a content hash. It is
evidence and rationale, not a second current design system. Current work and
readiness belong in [STATE.md](../docs/STATE.md), not appended release narratives
here. Update these rules in place when an approved decision supersedes them.
