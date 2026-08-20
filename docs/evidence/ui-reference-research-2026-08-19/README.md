# UI reference research — 2026-08-19

This evidence set grounds the Precision Instrument visual overhaul in real
product imagery. It is deliberately **visual-only**: none of the reference
applications' navigation, panel placement, editor layout, workflow, or
information architecture is a specification for Hivemind.

## Captured references

| Product | Local image | Source | SHA-256 |
| --- | --- | --- | --- |
| DeepSeek Harness | `01-deepseek-harness.png` (1520×950) | [DeepSeek Harness](https://deepseek.com/harness/en/), official `feat-plugin.en.png` asset | `0797e3861b1fb49ce6138db4ecf4b82afa9dba8f499cbca124f10bbeba7ccf7f` |
| Codex harness | `02-codex-harness.jpg` (2064×1084) | [GitHub's official third-party agents announcement](https://github.blog/news-insights/product-news/bring-your-own-agent-to-vs-code/), showing the Codex harness in VS Code's Agents UI | `2a7b1da7e2c12c79808a5de12bd78b46752693bce07685fa98ffe8ed57b314a0` |
| Claude Code | `03-claude-code.jpg` (2500×1155) | [Claude Code IDE integration](https://code.claude.com/docs/en/ide-integrations), official graphical VS Code interface image | `918393f205b96af5c1d4b285d3154b39058cc85bb4df63920e56ec9388b96783` |
| OpenCode | `04-opencode.png` (1920×1080) | [OpenCode](https://opencode.ai/), frame extracted at 3 seconds from the official `opencode-min` product video | `f4ae79e45e8a4e1aa0d6c5422ecf6042fdb1e4510c1029218677b105721bfe47` |
| Nexa | `05-nexa.webp` (1600×900) | [Nexa](https://rshai.dev/), official `nexa-desk.webp` desktop image | `d4b98f83d000f5177f9498c873d407a94c739f9de70824d0cf0eb66d2be2dc9f` |
| Orca | `06-orca.jpg` (800×450) | [Orca](https://www.onorca.dev/), official `orca-split-screen.jpg` image | `c177fb4f4f6361af771e73e0910c26941167d76b2de3b6afe62e0b472136b3d3` |

The Codex reference is a harness screenshot rather than a marketing-page
reconstruction. OpenAI's [Codex app article](https://openai.com/index/introducing-the-codex-app/)
was also inspected; its primary app visual is an embedded product video.

## What the images actually support

Across the six references:

- Work surfaces use closely stepped cool neutrals. Separation comes mainly
  from tone changes and hairline rules, not a shadow under every region.
- Navigation and compact utilities sit flat in their surrounding chrome.
  Persistent state uses an underline, a restrained wash, or a small accent.
- The strongest filled control is scarce. It remains visually distinct from
  prompt suggestions, disclosure rows, and toolbar actions.
- Type is compact and high-contrast. Monospace is reserved for code, paths,
  status, and measurements rather than applied to the whole application.
- Atmosphere belongs to the canvas behind work, not to every panel. Nexa and
  Orca use strong external imagery; Hivemind adapts that principle as a quiet
  navy instrument grid because its light palette and attention ceiling forbid
  a wallpaper-strength effect.
- Accent colours are singular and purposeful. Hivemind keeps its existing
  navy identity plus amber/clay meaning colours instead of importing green,
  purple, or another product's brand hue.

## What is explicitly not copied

- no sidebar, editor, composer, pane, or navigation relocation;
- no dark-mode conversion in this visual-only phase;
- no glass blur, backdrop filter, glowing dock, pill navigation, or animated
  decorative background;
- no second icon set and no component-owned authoritative state;
- no components mixed across unrelated catalogue authors.

## 21st workflow record

The direct CLI used the repository's `.21st/design.json` context. `21st usage`
reported a paid tier with unlimited search and component-code retrieval. No AI
generation was run and no component was installed.

Searches:

1. `compact desktop developer tool flat underline navigation cool neutral`
2. `rule separated prompt suggestion rows no cards developer tool`
3. `subtle technical canvas background light app no blur`
4. `compact flat icon toolbar desktop application`

Code retrieved and reviewed:

| 21st id | Candidate | Decision |
| --- | --- | --- |
| `18169` | Underlined Navigation Menu | Keep the underline principle. Reject installation: it adds Next navigation and `@radix-ui/react-icons`, while Hivemind already owns Radix Tabs and Lucide. |
| `23286` | Great UI Minimal Buttons | Keep the restrained top reflection and short contact shadow for committed actions. Reject installation: 10–15px radii, extra bevel rules, and its spinner do not match the 2–6px Hivemind scale or functional-motion rule. |
| `9051` | Action Toolbar | Reject: it adds local toggle state, pill styling, and another shadow/gradient language. |
| `7406` | Gradient Blur Bg / grid overlay | Keep only the low-strength technical grid idea. Reject the component, violet/blue fields, unused state/imports, and full-screen structure. Implement the effect in Hivemind's existing canvas token. |

The result uses Hivemind's existing `Button`, `SelectionControl`, `Tabs`, and
`Panel` primitives. This is substantive 21st use as research and code review,
without making the codebase a collage of registry packages.
