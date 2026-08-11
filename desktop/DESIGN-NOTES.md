# Desktop design notes

Decisions and open threads for the desktop client. Written down so they survive
between passes. This file is notes, not policy — Core's invariants live in Core.

## The product model the UI is built for

The app asks for exactly two decisions per run:

1. Type what you want built.
2. Ship it once the work is verified.

Everything between those happens silently. The person is interrupted only when
something genuinely needs a human: work stopped, a change was rejected, a plan
needs review, budget ran low.

Every layout decision below follows from that. When a surface starts asking for
a third decision, it is probably in the wrong place.

## Why the Work tab is a thread

The Work tab was a monitoring dashboard with a prompt bolted on. Two passes of
polish did not fix it, because the problem was structural: the primary
interaction — you typed something — had no reply and no record. Guidance sent
mid-run vanished into a one-line toast held in React state.

The Work tab is now a **run thread**: your messages, the plan, milestones in
plain language, and the ship decision, in order, with the composer anchored
beneath it. The task list moved to the rail, because it is *state you glance at*
while the thread is *the interaction*.

Two rules that keep it honest:

- **It is a conversation with the product, not with a model.** The orchestrator
  is silent on a clean run — the mechanical pipeline (contract, file locking,
  worktree setup, submit, analyze, queue, verify) is deterministic code, not
  model calls. A model transcript would be blank on a successful run. The thread
  narrates what *happened*, not what a model *said*.
- **Every entry comes from a durable daemon event.** `buildRunThread` in
  `src/lib/work-thread.ts` is a pure function over the replayed event history,
  so the thread survives a reload. Nothing in the thread is remembered in React.

## What the thread is allowed to know

Every entry maps to a durable event:

| Entry | Source |
| --- | --- |
| your request | `plan.prepared.data.prompt` |
| the plan | `plan.prepared` / `plan.ratified`, counts from `status.inspect` |
| your guidance | `human.guidance_recorded.data.message` |
| whether guidance was used | `human.guidance_consumed.data.guidance_ids` |
| milestones | task, integration and quota events |
| the ship summary | `adoption.completed` + the plan's acceptance wording |
| the run subject | `status.inspect.active_spec_title` |

`plan.prepared` originally recorded only `prompt_hash`, so the thread could not
show what you asked for. Core now records the normalized `prompt` alongside the
hash, capped at 20,000 characters exactly as `human.guidance_recorded` caps its
message — one pattern for the same problem, and the request is rejected rather
than truncated so the text and the hash can never disagree.

Do not reconstruct any of this client-side. A thread rebuilt from React state
disappears on reload, which is worse than not having it.

## The client's event buffer

`RECENT_EVENT_LIMIT` in `src/lib/projection.ts` bounds how much replayed history
the client holds. It evicts the **oldest** events, which is the head of the
thread — the request and the plan card — so it is deliberately set an order of
magnitude above a realistic run rather than just above it.

A busy task emits roughly 15–25 events across its lifecycle, scout, lease,
write-intent, patch, routing and verification records, so a 15-task run lands
near 400. The limit is 4,000 (~1MB of small objects). When the buffer has
actually dropped events, the thread says so instead of silently losing its
beginning.

## Done: four tabs became two

The shell is now **Work** (the run) and **Project** (its past). Swarm became a
view toggle inside Work; Memory and History merged into Project.

Reading the code made the case harder than the original argument did:

- **Swarm could not show anything Work did not already have.** `buildSwarmTree`
  takes exactly `inspection.execution_groups`, `inspection.tasks` and
  `projection.subagents` — the same inputs the rail reads. A tab whose inputs are
  a subset of another tab's is a *rendering*, not a place.
- **It was a second inspector for the same tasks.** `TaskInspector` in the tree
  and `InspectorPane` in Work rendered one task, one output stream and the same
  three controls, in two code paths with two vocabularies ("Redirect" against
  "Guide this agent"). That is a divergence waiting to happen, and merging them
  removed it.
- **Memory and History could not act.** Every memory card ended in "review this
  in a terminal", and History was read-only plus one trail dialog. Two tabs, one
  subject, zero decisions.

What that bought, beyond one less decision model:

- `src/legacy.css` is **gone**. It existed only to serve those three tabs, so
  every surface is utility-only now and the `@layer legacy` quarantine went with
  it.
- Stopping one task moved into the rail inspector, so `task.stop` is reachable
  from the one place that owns task controls.
- The map dispatches **no actions at all**. It selects a task; the rail acts on
  it. That is what keeps it a view rather than a second place to be.

### The four phases

`src/lib/phases.ts` is the model both the map and the rail draw: **Queued →
Editing → Checked → Ready**, plus shipped, stopped, and needs-you. It is a
`Record<TaskState, TaskPhase>` and nothing else — a rendering of the state Core
publishes, exhaustive by type so a new task state upstream refuses to compile.
It reads no events, keeps no time, and holds no state; deriving a phase any
other way would make the client a second opinion about where a task is.

### Standing rule: the trail must be able to REBUILD the state, not just attest it

A durable event is not enough because it proves something happened. It has to
carry what is needed to reconstruct the state it describes. Ask of every new
event: **could the state be rebuilt from this alone?** If not, the trail is a
receipt, not a record.

This has now bitten four times:

1. a checkpoint that could not be resumed from,
2. a pre-M8.7 verification that could not be adopted from,
3. `plan.prepared` storing the request as a hash, so the run could not say what
   was asked for,
4. `task.created` omitting `required_tests`, `deterministic_validity_check` and
   `routing_task_type`, so **Core's own contract validation refuses a contract
   rebuilt from Core's own log** — found by replaying the trail through the UI.

The fourth is the sharpest statement of the rule: the system cannot reconstruct
its own state from its own durable record. Adding those three fields to
`task.created` closes this instance; the rule is what prevents the fifth.

## Standing rule: capture the trail, not just the picture

Every verification run keeps its JSONL trail alongside its screenshots. A
screenshot cannot be replayed into a redesigned UI; the trail can, and it is the
only artefact that stays useful after the surface changes.

The M10.8 concurrent run and the M8 end-to-end runs are lost to replay because
only PNGs and prose were kept. Their durations, their nine-task plan and their
adoption refs exist as numbers in a README and cannot be rendered by anything.

## Standing rule: real trails verify, fixtures only lay out

`npm run replay:collect` then `/replay.html?scenario=<id>` is permanent
infrastructure. **Any UI change is replayed against real trails before it counts
as verified.** The fixture harness is a layout tool for arranging surfaces that
have no captured data yet — nothing more.

Five passes of green fixtures produced a UI that rendered "A task has to revise
its change ×3" on real data, merging three different failing tasks into one row.
No fixture caught it because every fixture had a title for every task.

## What replaying real trails caught this pass

Three defects that every fixture would have passed. Recorded because the shape
of them keeps repeating, not because these three instances matter most.

**A verified task drawn in failure red.** The map coloured a task's phase spine
from Core's `needs_you` queue as well as from its state. On
`final-run-transcript-4` that put T-002 — `verified`, checks passed — in clay,
directly above its own words "Checks passed, ready to ship". The queue item was
real (`reverification_required`: the checks are stale, not failed), but how far a
task *got* is its state and nothing else. The queue is a separate fact and now
gets a separate, quieter mark. **Two true things, one of them rendered as the
other.**

**Core's own copy leaking banned vocabulary onto the primary surface.** The
attention bar rendered "These checks predate verified-set provenance. Run the
real project checks again before adoption." verbatim — Core's sentence, with two
words the product does not say. A containment guard already existed in
`plainPrimaryDetail`; its word list was simply narrower than the actual ban list.
It is now `src/lib/vocabulary.ts`, one list shared by the guard and its test,
and `test/vocabulary.test.ts` asserts it against the **real captured detail
strings** in `tools/replay-data.json` — including that at least one real string
still trips it, so the guard cannot quietly stop being exercised.

This is a containment check, not a translation: the client recognises *its own*
banned vocabulary and declines to render the sentence, falling back to wording
chosen by the item's typed `kind`. It still does not guess what Core meant. When
Core writes `plain_reason`, the guard stops firing on its own.

**A 360px rail held open for nothing.** `m7-4-consolidation-behavioral` has five
queue items and **zero** projected tasks — a shape no fixture had. The rail
rendered "No tasks in this run yet." across 500px of white. The body grid now
drops the rail entirely when there are no tasks.

### Still leaking, and why it is not fixed here

`rejected add src/ledger.js` still renders raw in the attention bar and the task
row. It carries no banned vocabulary, so the guard correctly leaves it alone; it
is simply terse gate output. The fix remains Core's `plain_reason`, and adding a
fourth client-side regex for it would repeat the mistake this file already
records three times.

On `m7-4` the thread reads "T-101 has to revise its change" because that trail
carries no task titles at all — `inspection.tasks` is empty, so `task_titles` is
empty. Leading with the identifier is correct there: naming it anything else
would be invention. Where a title *is* known, `attentionHeadline` now leads with
it and demotes the identifier, which is the same rule the rows already followed.

## A known class of bug: Core records it, the UI never shows it

The chat hole was `human.guidance_recorded` having no display. A later audit
found the same shape four more times. Treat this as a class, not a series of
one-offs: **when Core appends an event, something must either render it or
deliberately suppress it.** An event with no reader is a silent state.

Two are outstanding, both needing Core to surface state it already records.

#### `adoption.indeterminate` — the most dangerous silence in the app

Emitted by `src/adoption.ts` (`appendIndeterminate`) when the live base ref
matches neither the pre-adoption ref nor the candidate ref, when the candidate's
tree does not match the adoption intent, when HEAD cannot be read, or when the
adoption intent is malformed. It means **Hivemind cannot tell whether your code
landed on your branch.**

Today the reconciliation loop records it, `continue`s, and returns
`{ok: true, value: {reconciled}}`. `inspectLatestAdoptionReadiness` does not
consider it, so the workspace shows nothing at all — or worse, re-offers the
ship bar as though the attempt never happened.

Needed from Core, in `buildQueues`:

```
kind:   "adoption_indeterminate"          // new WorkspaceQueueItem kind
title:  "Hivemind cannot tell whether this change landed"
detail: the recorded reason, plus the two refs it compared
action: null                              // there is no safe automatic recovery
change_set: the verification_id, task_ids and changed_files it was adopting
```

The item must also carry the refs (`pre_adoption_ref`, `adopted_ref`,
observed HEAD) so the client can show a person exactly what to check. This is
the one place where the honest UI is "we do not know; here is how to find out",
and inventing a recovery action would be worse than saying nothing.

`adoption.failed` (phases `precondition`, `base_transition`, `reconciliation`)
needs the same treatment at lower severity: a failed ship currently folds back
into `exactReview = false`, so the bar silently reverts to "Fresh checks passed;
review the change set" with no mention that the previous attempt failed. A
`needs_you` item with the failure reason and a `verification.rerun` action would
close it.

#### `scheduler.run_cancel_failed` — Stop that half-worked

`src/manager.ts` emits this when some workers refuse to stop, carrying
`failures`, `stopped_task_ids` and `retryable: true`. Nothing surfaces it. The
run.stop call returns `{ok: false, reason: "run cancellation incomplete and
retryable: …"}`, and `plainActionError` pattern-matches `/already terminal/`
inside that aggregate string — so a partial run-level failure can report the
per-task message "This task has already finished and cannot be stopped again."
Wrong, and it hides that workers are still alive.

Needed from Core:

```
kind:   "run_stalled"                     // existing kind is a fine fit
title:  "Some work could not be stopped"
detail: which tasks, and why each refused
action: { type: "run.stop", payload: { session_id, reason } }   // retryable
```

Separately, `plainActionError` must stop matching patterns inside aggregated
reasons. The durable fix is the plain-language field on the daemon error noted
below; until then the client should not infer meaning from a substring.

## First run, and why it still needs a terminal

Nobody had walked a clean install. What actually happens:

1. The app opens on `.`, `select_project` canonicalises a git root, and
   `desktop/src-tauri/src/project.rs` refuses with **"selected repository is not
   initialized for Hivemind"** unless `.hivemind/config.json` already exists. The
   desktop cannot initialise a project. A first-time user must run
   `hivemind init` in a terminal before the app is of any use.
2. `initProject` writes no tier globs and no adapter profiles.
3. The Work tab asks Core for two tools **by name** — `plan.prepare` sends
   `tool: "planner"`, `manager.start` sends `tool: "manager"` — and Core resolves
   each with `loadAdapterProfile`, i.e. `.hivemind/adapters/<tool>.profile.json`.
   Neither file exists after init, so the first prompt fails on a missing adapter
   profile with no UI anywhere that explains which files are wanted.

The setup screen and the agent dialog make steps 2 and 3 comprehensible and hand
over the exact files, but the app still cannot apply them. Everything below is
what Core would need for a first run without a text editor.

### The cost defect in an unconfigured project

`inferScopeTier` (src/routing.ts) returns **`"high"`** for any path matching no
configured glob, and `initProject` configures none. `minimumProviderRank.high`
is `providerTierRank.strong`, and `checkTierEligibility` **refuses** any
candidate below that floor — so on a fresh project cheaper providers are not
merely deprioritised, they are ineligible. Every task routes to the strongest,
most expensive provider, and `compareCandidates` sorts high/critical by provider
rank descending, so it picks the strongest of those too.

A new user's first run is the worst-case configuration, and nothing in the
product tells them. The fix is one change in `initProject`: write ordinary
default globs so that documentation is low, source and tests are medium, and
build/CI/auth paths are high or critical. `COST_DEFAULT_GLOBS` in
`desktop/src/lib/providers.ts` is the set the setup dialog hands to people today
and is a reasonable starting shape.

### Core actions the settings surface needs

Named to match the existing dispatcher style. All would be additions to
`workspaceActionTypes`.

**`config.inspect`** — read. Unblocks everything else; without it the client
cannot show what is configured, only what it was told at runtime. Should return
the resolved `HivemindConfig` (tier globs, `test_command`, `base_branch`,
`execution`, `resource_policy`, `verification`) plus, for each file in
`.hivemind/adapters`, the validated profile and any problems
`validateAdapterProfile` found. Read-only; no secrets are involved because
Hivemind never holds provider credentials.

**`config.set`** — write, narrow. Accept only a whitelist —
`low_globs`/`medium_globs`/`high_globs`/`critical_globs`,
`resource_policy.run_ceiling.tokens`, `resource_policy.session_ceiling.tokens`,
`execution.max_concurrent_workers` — and validate through the existing
`validateConfig` before writing. Refuse anything else rather than merging
arbitrary JSON.

**`project.init`** — write. Wrap `initProject` so the desktop can set up a folder
it has been pointed at, and in the same call:

- write the default tier globs above, so the project does not start in its
  most expensive configuration;
- write `.hivemind/adapters/planner.profile.json` and
  `.hivemind/adapters/manager.profile.json` for the chosen provider, because
  those two names are what `plan.prepare` and `manager.start` resolve and a
  project without them cannot take a first prompt.

This is the single change that removes the terminal from first run. Queued
second, after `config.inspect`, because the client should be able to read the
result of what it just wrote.

**`adapter.connect`** — write **and verify**. This is the one that must not be a
declaration. Accept `{ role, provider_id }`, build the profile server-side, run
`validateAdapterProfile` and `findDangerousAdapterArgs`, then **probe** before
recording anything.

The probe must read back what the provider reports **at startup**, and compare it
to what was asked for. A flag being accepted is not evidence it took effect —
both known regressions were exactly that shape: `--ignore-user-config` silently
forced a read-only sandbox, and separately silently pinned an old model. So:

| Capability | What the probe must confirm |
| --- | --- |
| Runs one exact model | the model the provider *reports running* equals the pinned one |
| Stays inside the project | the sandbox mode the provider *reports* is the workspace-write one, not a silently downgraded read-only |
| Runs without prompting | a trivial prompt exits without waiting on input, within the profile timeout |
| Reports usage | the configured `usage_parser` finds real token counts in that run's output |
| Carries no bypass flags | already enforced; keep refusing at preflight |

Connection should fail with the specific missing capability, not a generic error,
and nothing should be written when the probe fails. The desktop already renders
this list — `CAPABILITIES` in `providers.ts` — so a probe result maps onto it
directly.

**Role names.** The client hardcodes `planner` and `manager`. Either Core should
report the roles it expects in `config.inspect`, or config should carry a
role→tool mapping. Today the only thing tying them together is a desktop test.

### Core-side copy the client cannot repair

Found by replay: the client is not the only thing writing user-facing text, and
what Core writes is gate output. Three fixes, all in Core.

**Gate reasons need a plain-language field.** These strings render verbatim today,
in the attention bar and in the task row:

| Recorded reason | What it means to the person |
| --- | --- |
| `rejected add src/ledger.js` | it tried to create a file that is not its to create |
| `escalated modify package.json` | the change reaches a file that needs your say-so |
| `empty patch: no changes to analyze` | it finished without changing anything |
| `path is read-only under the granted lease` | it tried to edit a file another task owns |
| `adapter timed out before producing a patch` | the agent stopped responding before it finished |

The durable `reason` must stay exactly as it is — it is evidence. The fix is a
sibling field, `plain_reason`, written where the reason is produced, carrying one
sentence in the second column's voice. `plainEvidence` in
`workspace-inspection.ts` already prefers `plain_reason` when present, so queue
items light up as soon as the producers write it; `plainTaskIssue` in the client
should then be deleted rather than extended. This is the third time this has come
up. More regex in the client cannot work: the client is guessing at strings it
does not own.

**`taskAttentionTitle` must stop leading with IDs.** It composes "T-001 needs a
revision" while the row beside it reads "Initialize CLI package metadata and usage
docs". Core has the title in the contract it just loaded. Lead with it, and keep
the ID as secondary detail — the same rule the client follows.

**Core should adopt the client's vocabulary.** Core-composed copy says *merge*
("This change needs fresh checks before it can merge"); every client surface says
*ship*. Both appear on screen at once. The language pass settled on *ship*
because it is what a non-technical person calls the decision, and the client
cannot rewrite Core's sentences without guessing at their meaning.

### Actions with no way to reach them

Four audited workspace actions have no control anywhere in the desktop. Not
bugs, but a real product gap:

- `manual_task.review` / `manual_task.authorize` — manually authored tasks have
  no surface at all.
- `verify.characterize` — no way to ask for a characterization test.
- `quality.best_of_n` / `quality.draft_refine` — no way to start a second
  attempt from anywhere. `quality.cancel` used to be reachable from the tree
  tab, which was the wrong half to expose on its own; folding that tab in
  removed it rather than pairing it, so this is now a clean gap in both
  directions instead of a lopsided one. A second attempt shows on its task's
  card in the map, so when a start control exists it has an obvious home.

### Waiting on Core

- **Durations.** There is no elapsed time anywhere, and "how long will this
  take" is the first thing a person asks during a run. A client-side ticking
  clock would be ambient motion and derived state; the clean version is Core
  emitting durations on events it already sends.
- **Raw error text leaking into a polished surface.** `plain-language.ts` maps
  known Core failures to plain sentences with a fixed regex list. Anything
  unmapped renders raw. The correct fix is a plain-language field on the daemon
  error, not a longer list of regexes here.

### The command palette needs a command registry

⌘K currently covers navigation, opening a project, and jumping to the composer.
The commands people would actually want — ship it, stop the run, review the plan
— live in the Work tab's state, and the palette lives in the shell above it.

Wiring them needs a small registry: the shell owns a command list, and each tab
registers and deregisters its commands as its state changes. That is the right
shape, and it is worth doing deliberately rather than reaching down into a
child's state from the shell. Until it exists, the palette should not pretend to
offer actions it cannot perform.

### Core tests must not assert desktop copy

`test/workspace-actions.test.ts` reads desktop source and, until recently,
asserted literal UI labels. That coupling is brittle in three separate ways:

- it breaks on every language pass, which is exactly the work this client needs
  most and the one thing the brief keeps asking for;
- when it breaks it *looks* like a Core regression, because it fails in Core's
  suite under a Core test name;
- it went undetected across three commits, because it lives in a suite the
  desktop work never runs — desktop iterates on `npm test` inside `desktop/`,
  and the Core suite takes eleven minutes.

The split that holds: **Core asserts behaviour** — that the client dispatches
only audited action types, that an affordance exists and is wired to the right
handler, that no mutation route or Core import crosses the boundary. **Desktop
asserts its own copy** — labels, plain language, and the absence of internal
vocabulary, in `desktop/test/thin-client.test.ts` where a language change and
its test move together.

If a Core test needs to know a control exists, it should match the condition and
the handler, never the words on the button.

### Verification debt

Every design judgement through five passes came from a fixture harness that
stubs the Tauri IPC and the SSE transport. `tools/collect-replay.mjs` now closes
part of that gap: it reads captured trails out of `docs/evidence` (never writing
to them), replays each into a scratch repository, and runs Core's real
`inspectWorkspace` over it, so `replay.html` drives the app against a projection
Core actually produced. That is still not a live daemon — no worker output, no
live leases, no spend — so treat both harnesses as instruments, never as
verification.

The harness can now be driven to a surface that needs a click, so a headless
capture can reach the map and the project record:
`/replay.html?scenario=<id>&view=map`, `&tab=project`. That lives entirely in
`tools/replay.tsx` — the app has no test hooks of its own. (Radix's tab trigger
activates on mousedown and focus, not on a bare programmatic `.click()`, which
is why the harness dispatches the whole sequence.)

#### What the evidence corpus does not contain

Across all eight replayable trails there is **no `plan.*` event, no `adoption.*`
event, and no routing, quota or resource event**. `task.started` appears exactly
once. So the two decisions the whole redesign is built around — approving a plan
and shipping a verified change — have never been rendered from real data, and
the spend meter reads zero for runs that cost real money.

The M10.8 concurrent run and the M8 end-to-end runs were retained as screenshots
and prose. Their durable trails — the 52-record M10.8 log, the 9-task E2E plan —
are not in the repository, so they cannot be replayed. Whatever process captures
evidence should keep the JSONL alongside the PNGs; a screenshot cannot be
replayed into a different UI, and the trail can.

**So these surfaces have still never been drawn from real data**, and this pass
did not change that: the populated **Project** surface (past runs, remembered
guidance, items waiting for review), the **plan review**, and the **ship bar**.
Their layouts were checked against a scratch fixture injected into
`replay-data.json` and then discarded — which is a layout tool, not evidence,
exactly as the standing rule above says. Treat them as unverified until a trail
carrying `plan.*`, `adoption.*` and a completed run exists.

`task.created` records `title`, `agent_role`, `base_commit`,
`acceptance_criterion` and `allowed_files`, but **not** `required_tests`,
`deterministic_validity_check` or `routing_task_type`. Core's own contract
validation refuses a contract rebuilt from the trail without them, which means
the durable log is not sufficient to reconstruct the workspace state it
describes. The collector fills only `required_tests`, from the command the
acceptance criterion names, and marks it.

### Client-side, not yet done

- **Responsive behaviour outside 1440×900.** Partly done: the rail is 300px
  below ~1100, 360px to ~1600, and 420px above it, and it disappears entirely
  when a run has no tasks. It is deliberately **not** hidden at narrow widths —
  the first attempt hid it below 1100, which takes the live output, the guide
  control and the stop control off the screen. That is a capability loss
  dressed as responsive behaviour. Still outstanding: at the 820px minimum the
  rail is cramped rather than collapsible, and a real collapse would need the
  inspector to have somewhere else to go.
- **Accessibility beyond the basics.** The task list is buttons inside sections;
  a listbox with roving focus is probably more correct. Keyboard traversal and
  screen-reader flow have not been tested on the redesigned markup.

## Styling

Tailwind v4 (CSS-first, no config file) with the shadcn token set mapped onto
the logo palette in `src/styles.css`, so `npx shadcn add <x>` lands on the
palette with no edits.

### The token contract, and why it has a test

A shadcn component is styled *entirely* through the semantic token names. A
token that is missing does not fall back to something reasonable — it generates
**no CSS at all**, and the element renders unstyled. That failure is silent:
the class is on the element, it just does nothing.

This had already happened. `--muted-foreground` was declared in `:root` but
never exposed in `@theme inline`, so `text-muted-foreground` — the most common
text utility in generated components — emitted nothing. It was live in three
components already shipped: the command palette's group headings, input
placeholder and shortcut hints; the dialog description; the dropdown menu's
icons and shortcuts. All of them rendered at full `--ink` instead of muted.

The cause is a name collision worth remembering. shadcn's `muted` is a **pair**
— `--muted` is a *surface*, `--muted-foreground` is *text*. The logo palette's
Muted (`#667085`) is a text colour, and it had taken the surface's name. So
`bg-muted` resolved to a dark grey block, and the text half was never mapped.
The fix maps them separately (`--color-muted` → Surface, `--color-muted-foreground`
→ Muted) and renames the app's own `text-muted` to `text-muted-foreground` —
87 occurrences, identical rendered colour, and it aligns the app with the
vocabulary the CLI emits rather than fighting it.

`test/design-tokens.test.ts` asserts every token a generated component can
reference is present in `@theme inline` **and** resolves to the palette value it
should. Adding a token to `:root` alone will not satisfy it, because that is
exactly the mistake that was made.

**Chart tokens are deliberately absent**, and the test asserts their absence so
it stays deliberate. `--chart-1` through `--chart-5` need five mutually
distinguishable hues; the palette has two colours that carry meaning and none
that are decorative. A chart component needs a palette decision first, and
should fail visibly rather than silently pick something.

- **Panels on a canvas.** Content lives in rounded panels with real padding on a
  `--canvas` ground. Grouping comes from the container, not from a grid of
  full-bleed rules.
- **Palette.** Navy and charcoal are the identity. Amber and clay appear *only*
  where they carry meaning (needs attention, failed). No other hues, no
  gradients.
- **Motion reflects real events.** The run-progress rule moves when a task
  finishes. `.artifact-marker` is the only animation in the app: it fires when
  the live stream reports a change clearing a phase, plays once, and is an
  *overlay* on an already-filled segment — which is what lets reduced motion
  hide it outright and leave the segment underneath still correct.
- **`src/legacy.css` is gone.** It served the three tabs that no longer exist,
  so the `@layer legacy` quarantine went with them. Every surface is
  utility-only; there is no longer anywhere to put a hand-written rule.

### The acceptance test, re-run this pass

`npx shadcn@latest add alert` produced a component that rendered styled with
**zero manual class conversion and zero config edits**, and every utility it
referenced compiled to real CSS resolving to a palette value (`--destructive` →
`--clay` → `#b65b4f`, `--muted-foreground` → `--muted` → `#667085`). The probe
was removed. `empty` was added the same way and **kept**, so the app now carries
a verbatim CLI-generated component as standing proof of the contract — if the
token mapping regresses, it renders unstyled and `test/thin-client.test.ts`
fails.
