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

This has now bitten five times:

1. a checkpoint that could not be resumed from,
2. a pre-M8.7 verification that could not be adopted from,
3. `plan.prepared` storing the request as a hash, so the run could not say what
   was asked for,
4. `task.created` omitting `required_tests`, `deterministic_validity_check` and
   `routing_task_type`, so **Core's own contract validation refuses a contract
   rebuilt from Core's own log** — found by replaying the trail through the UI.
5. `adoption.completed` omitting `changed_files`, so the trail could prove a
   commit landed but not say what it carried. The shipped card read **"0 files
   changed" over a commit that changed eight** — found by shipping a real run
   through the app on 2026-08-11. `adoption.reviewed` had recorded the files all
   along; the started/completed pair had not.

The fourth is the sharpest statement of the rule: the system cannot reconstruct
its own state from its own durable record. The fifth is the cheapest to have
prevented — the data was one scope away, already in hand.

The rule keeps catching things because it is asked too late. Ask it of the
event when the event is written, not when a surface finally needs it.

## Standing rule: capture the trail AND the project state

Every verification run keeps its JSONL trail alongside its screenshots. A
screenshot cannot be replayed into a redesigned UI; the trail can, and it is the
only artefact that stays useful after the surface changes.

The M10.8 concurrent run and the M8 end-to-end runs are lost to replay because
only PNGs and prose were kept. Their durations, their nine-task plan and their
adoption refs exist as numbers in a README and cannot be rendered by anything.

### The rule as first written was incomplete, and quietly so

"Capture the trail" was not enough, because **a run's state is not all events**.
The plan, the spend ledger, the manager session, the spec and the contracts are
*files*. A trail replayed on its own therefore comes back with a null plan and
zero spend — and says so nowhere. It projects, it renders, it looks right.

The cost of that was not hypothetical. The plan review and the spend meter were
listed as "waiting on a real trail" for five passes. A real trail arrived on
2026-08-11 and **still could not draw them**, because the missing pieces were
never events to begin with. Every replay verification done before that date was
partial in a way nobody could see: the surfaces that depend on file state were
being checked against nulls and called verified.

An evidence folder now carries `project-state/` mirroring `.hivemind/`, and the
collector restores it beside the trail. Captured, never invented — a folder
without one replays exactly as before.

The generalisation worth keeping: **ask what the surface reads, not what the
system emits.** A capture is complete when every input to the surface is in it,
and events are only one class of input.

### And: every trail projects only to its end

The second gap in the same rule. A captured trail replays to its final state, so
a *finished* run is the only state a trail could ever draw. Mid-flight — three
agents working at once, which is the thing this product exists to do — stayed
fixture-only even after real trails existed.

The two live screenshots of it are the proof: both landed inside an
inspection-lag window and show "Waiting to start" beside three running tasks.
Nobody caught it, because a screenshot is whatever the UI happened to be showing
when a human pressed a key.

`tools/collect-replay.mjs` now also emits `<id>@midrun`: the trail cut at peak
concurrency and projected by Core, which draws the honest mid-run state. For a
run that reaches a ship it emits a full `timeline` — one Core projection at each
point the run visibly changed — so playback can move the rail with the story
instead of serving the finished projection over an unfinished thread.

A finished run is the easy state to render. The states that have been wrong five
times are the ones in the middle.

## Playback: the demo comes out of the capture

`/replay.html?scenario=<id>&play=6` replays a run on its own clock: events on
their real relative timing, worker output on the same clock, and the projection
stepping through the captured `timeline`. 4× is 43s, 6× is 29s, 8× is 22s.

Everything it plays is captured. Two liberties, both about time and neither
about content: gaps are clamped at 20s before scaling, so the 24 minutes between
a settings change and the prompt do not become 24 minutes of demo, and a worker
thinking for 90 seconds still reads as work. Output uses the events' clock
rather than its own — its first version drifted, because it restarted timing
whenever the app happened to open the stream.

This exists because the alternative was a screen recording, and a screen
recording would have re-captured the same inspection lag that spoiled the two
live mid-run screenshots.

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

**Walked again on 2026-08-11, and step 3 is not the last wall.** With adapter
profiles and tier globs in place, the first prompt still fails:

> `no active spec; create and ratify a spec before planning, leasing, or running workers`

Reaching a first prompt took four terminal commands and a hand-written document,
none of which appears on any surface in the app:

```
hivemind spec S-001 --create --title "…"     # then fill nine sections by hand
hivemind ideate S-001 --start --title "…" --goal "…"
hivemind ideate S-001 --round round.json     # ≥2 alternatives with tradeoffs,
                                             # plus a self-critique round
hivemind spec S-001 --ratify
```

The spec gate is doing real work — it refuses a spec with empty non-goals, and
it refuses ratification without genuine alternatives and a self-critique. The
problem is not that the gate exists, it is that the product's whole promise is
"type what you want" and the first thing it does is refuse until you have
written a nine-section document in a text editor. `project.init` in the list
below is necessary but not sufficient: a first run also needs a way to get from
a sentence to a ratified spec.

That error is also raw Core text on a primary surface, and it says *spec*,
*leasing* and *workers* — the client's guard suppresses it and falls back to the
kind-based sentence, which is correct but loses the one detail that would tell
somebody what to do.

A proposal for this is written up under **"Proposal: the front door"** below,
after the Core actions it depends on.

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

### Invariant change: planning no longer requires a ratified spec

Taken deliberately on 2026-08-11. Recorded here because it inverts a gate three
Core tests named, and someone should be able to find out why.

**What changed.** `checkPlanningAllowed` required the active spec to be
*ratified*. It now requires the active spec to be *valid*. `plan.prepare` will
run against a draft.

**Why.** A plan is a proposal: planning reads the repository and writes a
tentative plan. Nothing in it touches the repo. The invariant that matters is
that **execution** requires a ratified spec, and `requireActiveSpecRatified`
still guards contracts, leases, worktrees, workers, scouts, integration and
checkpoints. The original gate was written when nothing generated a spec, so
requiring ratification before planning was free — it protected against wasted
planner tokens, not against repo mutation. Once the app drafts a spec from a
prompt, that same gate makes it impossible to show anyone a plan before they
commit to the document it came from, which is precisely what a first run needs.

**What it costs.** Planner spend on a spec that may never be ratified. A person
can now prompt, see a plan, and walk away, having paid for a planning call
against a document nobody adopted. That is the deliberate price of showing
someone a plan before they sign, and it is a real cost: on the 2026-08-11 run a
planning call was 23.3K tokens.

**What makes it safe, and where that is proved.**
`test/unratified-spec-gate.test.ts` asserts both halves: an unratified spec
permits planning, and then *tries* contract creation, lease grant, worktree
creation, worker run, scout run and checkpoint against it and confirms each
refuses, and refuses **because** the spec is unratified rather than incidentally.
Integration is the one path that cannot be reached from an empty repository — it
refuses for want of a queue before it consults the spec — so that one is
asserted structurally, and the test says so rather than fabricating a queue and
calling it behaviour.

**Nothing inferred ratification from a plan.** Audited before the change: every
execution surface calls `requireActiveSpecRatified` itself. `contract.ts` checks
the spec at line 180 *before* reading the linted plan at 196, so contract
creation never treats "a plan exists" as evidence a spec was ratified. That
shape — one gate standing in for another — is the one that has bitten this
project repeatedly, and it is not present here.

One ordering consequence for the UI: `ratifyPlan` itself requires a ratified
spec, so the single review must sign the spec before it ratifies the plan.

### The vacuity experiment, and what it found

Four real drafting calls on 2026-08-11, `codex-terra`, 4 calls / 79,137 tokens.
Verbatim output in `docs/evidence/spec-drafting-vacuity.json`.

| Prompt | Non-goals | Open questions | `assessNonGoals` |
| --- | --- | --- | --- |
| "make the text stuff better" | none | 1 | empty |
| "Add a titleCase(text) helper…" | 1 | none | 1 substantive |
| "…reads a config file from disk…" | none | 1 | empty |
| "make the text stuff better" (again) | none | 1 | empty |

**Zero vacuous entries.** The drafter never wrote "None recorded" or "Anything
else". When it had nothing to decline it returned an empty list, which is what
the prompt asked for and is the honest answer.

**It asks rather than guesses.** Both vague runs invented no constraints and
raised a question instead — "Which text utility or utilities should change?" —
and did so consistently across two runs. That is the behaviour that matters
most: open questions block ratification, so a drafter that guesses is worse than
one that returns nothing.

**It did not decline the tempting scope.** The config-reader prompt has obvious
adjacent scope — writing config, schema validation, caching, watching for
changes — and the drafter declined none of it. It asked about file format
instead, which is a legitimate question, but the temptation went unaddressed.
On the specific thing this experiment was designed to test, the answer is no.

**The one substantive non-goal is real but mild.** "Does not change the
behavior of existing text helpers" is derived from the project's file list
rather than from the prompt's own phrasing, and a person might well have written
it. It is not padding. It is also the kind of thing a builder would probably
have respected anyway.

#### The finding that matters: the gate refuses the honest answer

`ratifySpec` requires Non-goals to be non-empty. Three of four drafts produced
**zero** non-goals — correctly, by the prompt's own instruction. Those specs
cannot be ratified.

For these three it does not bite, because each also raised an open question and
would have blocked anyway. But a prompt that is specific enough to need no
question and has no tempting adjacent scope would produce an unratifiable spec,
and the person would be blocked by a rule nobody meant to apply to them.

So the collision is real and currently latent. The options, none of which should
be chosen quietly:

- **Let a drafted spec ratify with empty non-goals**, treating "nothing to
  decline" as a legitimate answer and losing the gate's forcing function.
- **Require the drafter to always produce one**, which is how "None recorded"
  gets invented and the gate becomes theatre — the outcome this experiment was
  run to detect.
- **Ask the person**, making "is there anything this should not do?" part of the
  one review. Keeps the gate honest and costs a field on a screen.

The third is the only one that preserves what the gate is for. It is not built;
`assessNonGoals` was deliberately not loosened to accommodate any of them.

### The one review, built

`src/components/workspace/spec-review.tsx`, inside the existing plan takeover.
One screen; the person acts once. `spec.adopt` signs the spec, then
`plan.ratify` ratifies the plan, because ratifying a plan requires a ratified
spec — ordering, not a second decision.

**Non-goals is an input, not a display.** Drafted entries arrive prefilled and
marked *Suggested*; anything typed is marked *Yours*. The heading asks the
question — "Anything this should NOT do?" — rather than presenting a default,
and an empty drafted list says "Nothing was suggested" instead of hiding the
field. The person's answer is what gets written to the spec. This follows the
experiment: the drafter left writing, validation, caching and watching all
undeclared on the config-reader prompt, so drafted non-goals cannot be the
forcing function. They are a bonus; the person is the author.

**Open questions block, visibly.** The refusal is the first thing on the screen,
in clay, with the question quoted and the remedy stated, and the approve button
is disabled with the reason beside it. Core refuses this too — the UI only
explains the refusal before somebody hits it.

#### What this was verified against

`16-review-blocked.png` and `17-review-ready.png` in
`docs/evidence/e2e-2026-08-11-textkit`, replayed from **real** data: the plan is
the real four-task plan from the 2026-08-11 run, and the spec is a **real
drafted spec** from the vacuity experiment — the config-reader draft with its
one genuine blocking question, and the titleCase draft with its one suggested
non-goal.

**One thing is synthesized, and only one:** no captured trail contains a plan
*awaiting* ratification — the real run's plan was ratified during it — so the
scenarios present the real plan as pending. Per the standing rule: the plan
content, the spec content, the question and the suggestion are all real; the
pending state is not. A trail captured before ratification would close that,
and is worth taking on the next run.

### Proposal: the front door

Not built. Written down because the design choice is real and worth settling
before code.

#### What the spec is actually load-bearing for

Read the enforcement rather than the convention, and the answer is narrow.

| Enforced | Where | What it demands |
| --- | --- | --- |
| `# Spec: <title>` | validate | non-empty title |
| exactly one `status:` line | validate | `draft` or `ratified` |
| nine `##` headings present | validate | **headings only — bodies may be empty** |
| Non-goals non-empty | ratify | some text |
| Open questions empty | ratify | no text |
| ≥2 alternatives with tradeoffs | ratify | recorded in the ideation session |
| ≥1 round, each with a self-critique | ratify | recorded |
| `convergence.orchestrator` | ratify | a sign-off |
| `convergence.user` | ratify | **a separate sign-off** |

What consumes the document: `buildPlanningGenerationPrompt` passes the whole
markdown to the planner as context, and the title becomes
`active_spec_title`. That is all.

What does **not** read it: grounding (base commit and per-task evidence against
the repo), all eight plan-lint rules (parallel safety, scope overlap, dependency
cycles, critical approval, right-sizing, skeleton-trap acceptance), file scope
(the plan's `allowed_files`) and conformance (the plan's
`deterministic_validity_check`). Scope and conformance derive from the **plan**,
not the spec.

So **seven of the nine sections are conventional** — a thinking scaffold for the
person and context for the planner. Non-goals and Open questions are
load-bearing as *gates*, not as data. And the gate's real work is not the
document at all: it is forcing alternatives, a self-critique, and **two distinct
signatures** before any work starts.

That reframes the problem. The gate is not protecting scope derivation. It is
protecting intent quality, and it already distinguishes "a model converged" from
"a person converged".

#### The authorship line

A model may **draft**; only a person may **converge**. Core already models this:
`convergence.orchestrator` and `convergence.user` are separate booleans, and
ratification requires both. Any first-run flow that writes `convergence.user`
without a human act is forging the one signature the gate exists to collect.
That rules out the obvious shortcut — scaffold a spec, auto-ratify it, never
show it — however tempting its simplicity.

The sharp edge is Non-goals. A non-goal is a *constraint on what gets built*. A
generated non-goal is a generated constraint, and one nobody read can silently
narrow the work. If the app drafts non-goals, it must show them. That single
consideration, more than anything about document structure, decides the flow.

#### Recommended: one review, and it is the plan review

```
prompt → drafted spec (orchestrator-converged) → plan → ONE review → work
```

The person's single approval carries both signatures, because the review shows
the things both gates are actually checking:

- **what will be built** — the plan, as today: steps, file scopes, how each
  result is checked;
- **what will not** — the drafted non-goals, stated plainly, because they are
  constraints the person is adopting;
- **anything the drafter could not resolve** — open questions, which **block**.
  Core already refuses ratification while any remain, so they cannot be a
  footnote; answering them belongs on this screen, and an unanswered one means
  the run does not start.

This stays inside the two-decision model: type what you want, approve the plan.
It does not bypass the gate — it collects the same signature against strictly
more information than a nine-section document read in isolation would give,
because the plan is concrete where the spec is prose.

What it costs: one more model call before planning, and a review screen that
grows a "what this will not do" section. What it must not become: a spec
displayed for form's sake. If the drafted non-goals are always "None recorded",
the gate is vacuous and we have built theatre.

#### The smaller version, and why it is not as small as it looks

"Have `project.init` write a valid scaffold the user never sees" does not
actually unblock a first run. The scaffold satisfies *validate*; it does not
satisfy *ratify*, which needs the ideation record and both signatures. Getting
past that without a human act means auto-signing `convergence.user` — the one
thing ruled out above.

If a smaller step is wanted first, the honest one is a Core change rather than a
client trick: let a **short spec form** be first-class — title, goal, non-goals,
acceptance — accepted by `plan.prepare` on equal terms, with the nine-section
document reserved for deliberate work. That says "a one-line intent is a
legitimate spec shape" instead of pretending a placeholder is a document. It is
a smaller change than it sounds, because nothing parses the nine sections.

#### Open question for the human, not for this file

Whether a drafted spec should be *kept* as the project's spec, or treated as
scaffolding for the plan and discarded. Keeping it means the project accumulates
documents nobody wrote. Discarding it means `active_spec_title` and the run
history lose their subject line. I lean toward keeping it, marked as drafted,
because the ideation record already distinguishes who converged — but this is a
product call about what the project's memory should contain.

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

### Core-side copy — done

Three fixes, all in Core, all shipped on 2026-08-11.

**`plain_reason` is written where the cause is known.** The cause was being
thrown away at the point it was known: `decideOp` returned only a verdict, so by
the time anything wanted to explain a refusal the only material left was the
operation and the path. `decision.ts` now carries a typed `DecisionCause`
alongside the verdict, `plainDecisionReason` turns it into one sentence naming
the file, and `analyze.ts` writes `plain_reason` onto `patch.rejected` /
`patch.accepted` beside an untouched durable `reason`.

The real run on 2026-08-11 produced 11 events carrying both halves:

```
reason      : "all changes are within scope"
plain_reason: "Every file it changed was one this task was given."
```

That run was clean, so only the accept path was exercised on real data. The
refusal sentences are covered by `test/plain-reason.test.ts`, which asserts every
cause has a sentence, that it names the file, and that it contains none of the
vocabulary the client would refuse to render.

`plainTaskIssue` is **deleted**, not extended, and a desktop test asserts it
stays deleted. Note the shape of this by construction: `plain_reason` is written
when an event is produced, so the eight older trails in `docs/evidence` cannot
gain it retroactively, and they correctly still replay with the raw reasons.

**`taskAttentionTitle` leads with the title.** It only ever looked the title up
in the plan, so a run whose plan is not loaded composed "T-001 needs a revision"
beside a row reading "Initialize CLI package metadata and usage docs". The
durable status carries the title too, and is the wider source of the two. Where
neither knows a title — a trail with no `task.created`, which the m7-4 evidence
is — leading with the identifier is correct, because anything else is invention.

**Core says *ship*.** The language pass settled on *ship*; Core said *merge* in
the adoption readiness sentence, the run outcome detail and the failed-adoption
title. All three now say ship, and the readiness sentence no longer puts
"verified-set provenance" and "adoption" on the attention bar.

The client's containment guard (`src/lib/vocabulary.ts`) stays exactly as strict
as it was. It declines an unsayable sentence and falls back to wording chosen by
the item's typed `kind`; it never rewrites one. Core's copy improving is what
stops the guard firing — the guard does not relax to meet it.

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

**Closed on 2026-08-11.** `docs/evidence/e2e-2026-08-11-textkit` is a real run
driven end to end through the desktop app: one prompt, a plan review, an
approval, three workers in parallel, a dependent fourth task, and a ship. Its
trail carries `plan.*`, `adoption.*`, `routing.observed` and a completed run —
all four things this corpus had never contained — and it replays:

```
npm run replay:collect
/replay.html?scenario=e2e-textkit-parallel-run
```

So the plan review, the ship confirmation and the populated Project surface have
now each been rendered from real data. Two of the three were right the first
time; the ship card was not, and that is recorded above as the fifth instance of
the rebuild rule.

### Closed: a trail alone was never enough

The first replay of that run projected a **null plan and zero spend**, because
the plan, the ledger and the manager session are *files, not events*. That is
the whole reason the plan review and the spend meter had stayed fixture-only:
the corpus could not have drawn them however carefully it was replayed.

An evidence folder may now carry `project-state/`, mirroring `.hivemind/`, and
the collector restores it beside the trail. Captured, never invented — a folder
without one replays exactly as before. `config.json` is the one file merged
rather than copied, and only `resource_policy` and `execution`: `repo_root` and
the base branch belong to the machine that ran it.

Two things this immediately caught, both the "silently wrong UI" shape:

- **Spend rendered amber against the wrong ceiling.** 622.6K of real usage
  compared to init's 500K default, for a run whose real ceiling was 2.5M. A run
  comfortably inside budget drawn as nearly out of it.
- **No mid-run state existed anywhere in the corpus.** Every trail projects only
  to its end, so "three agents at once" — the thing the product is *for* — had
  only ever been a fixture, or a live screenshot caught at whatever instant
  somebody pressed the button. Both live captures of it landed inside an
  inspection-lag window and show "Waiting to start" beside three running tasks.
  The collector now also emits `<id>@midrun`: the trail cut at peak concurrency
  and projected by Core, which draws the honest state.

The mid-run cut is worth more than a screenshot. A finished run is the easy
state to render; work in flight is the one that has been wrong five times.

Still not drawn from real data: **populated memory** (this project learned
nothing), the **refusal half of `plain_reason`** (nothing was rejected), and
**mid-run lease state** (leases are released at adoption, so a post-run capture
cannot hold them).

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
