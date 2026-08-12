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

## Standing rule: when you loosen a gate, audit what GRANTS the thing it guarded

The most serious hole found in this project, and the audit that missed it.

**What happened.** Moving the planning gate — planning may run against an
unratified spec, execution may not — silently widened a second gate that
depended on it. Autonomy's policy branch reached plan ratification against an
*unsigned* spec and ratified it: `.hivemind/plans/ratified/S-001/` existed on
disk while `convergence.user` was `false`. **The human signature was bypassed on
the path that leads to writing to the user's branch.** Not a near miss: the
artifact was written, and only the adoption gate downstream stood between that
and a merge.

**Why the audit missed it.** Before the change I audited for anything that
*infers* ratification from a plan's existence — does any code treat "a plan is
here" as evidence a spec was signed? That audit was clean, and it was the wrong
question. It asked about **consumers** of the invariant and never about
**producers** of it. Nothing inferred ratification from a plan; something
*granted* ratification without the act that produces it.

So, alongside *the trail must rebuild the state* and *capture the trail and the
project state*:

> **When you loosen a gate, audit what grants the thing that gate guarded.**
> Listing the readers of an invariant is half an audit. The other half is every
> writer: which code paths can produce this state, and does each still require
> the act that is supposed to produce it?

### The full audit, run 2026-08-11

Every state in the system that is *granted* rather than derived, and what grants
it. This is the audit that should have been run the first time.

| Granted state | Written by | Reachable without the act? |
| --- | --- | --- |
| Spec ratified | `ratifySpec` — CLI `--ratify`, `adoptSpec` | **No.** Both go through `checkIdeationRatifiable`, which requires both convergence signals, and `convergence.user` needs a challenge-bound authorization. |
| Plan ratified | `ratifyPlanWithSource` — human via `plan.ratify`, policy via the `auto` branch | **No, after the fix.** Both callers now pass through `requireActiveSpecRatified` inside the granting function, before anything is written. This is the hole. |
| Change adopted | `appendAdoptionCompletion`, only inside `adoptVerifiedSet` | **No.** Requires a pending authorization matching a durable recorded review, refused if already consumed. |
| Canon promoted | `writeJsonAtomic(canonPath, …)` — one writer, in `memory-review.ts` | **No.** Behind a TTY check and a typed confirmation. |
| Quality admission | `value-quality.ts` | **N/A.** Refuses; grants nothing. |

The pattern that made the plan case dangerous and the others safe: **the check
lives inside the granting function, not at its call sites.** `adoptVerifiedSet`
verifies its own authorization; `ratifySpec` runs its own gate. Plan
ratification had its spec check at one call site and not the other, so a second
caller was one edit away from skipping it. It is inside
`ratifyPlanWithSource` now.

**Design rule that falls out:** a function that grants a privileged state should
verify its own preconditions. A caller that has to remember is a caller that
eventually forgets.

## Standing rule: walk the journey, do not only test the units

Three defects, all in the first-run seam, all invisible to 634 passing tests,
all found by clicking through the product rather than by testing it. Together
they are the strongest evidence this file has for the rule.

1. **`prepareWorkspacePlan` kept a duplicate ratification check.** The planning
   gate was moved in `checkPlanningAllowed`; this path called
   `requireActiveSpecRatified` directly, so the first prompt still refused a
   drafted spec. Found by typing a prompt.
2. **Autonomy signed for the person.** With planning loosened, `auto` ratified a
   plan against an unsigned spec. Found by looking at what was on disk after the
   first defect was fixed.
3. **The dispatcher and `adoptSpec` disagreed about a field.** An edit landed
   `nothing_to_decline` in one and not the other, so Approve — the single action
   a first run depends on — failed with "payload contains an unsupported field".
   Found by clicking Approve.

What they have in common is not carelessness; each was a reasonable edit. It is
that **no test walks the journey**. The suite tests units richly and the seams
between them not at all, and all three defects lived precisely in a seam: a gate
moved in one place and duplicated in another, a policy branch downstream of a
changed precondition, a payload contract split across two files.

The rule:

> **Walk the journey before claiming it works.** A suite that passes tells you
> the units are right. Only using the product tells you they are connected. For
> any flow the product actually sells — first run, prompt to shipped — walking
> it is part of the definition of done, not a verification afterthought.

The cost of not doing it is visible in the history: the front door was claimed
finished three times, and each time walking it found something a test could not
have. The cost of doing it is one paid run.

### The fourth walk, which reached shipped and still found four more

`docs/evidence/e2e-2026-08-11-walk4/` is the first walk to get from prompt to
shipped with no terminal. It also found four defects against 646 passing tests,
which is the point worth keeping:

1. **A byte-order mark silently cost the project its checks.** `init` parses
   `package.json` to find the test command; a BOM makes `JSON.parse` throw and
   the catch returned `""`. Setup reported success, and the run failed at
   *integration* — after the worker was paid for — naming a config key.
2. **The cost readout undercounted by a third of the calls.** Drafting bills to
   the spec and everything after it to the run, and the readout summed one
   session. 2 calls shown, 3 spent.
3. **The setup screen told people to paste files it had already written.**
4. **"restart the daemon before using this project"** — an instruction with no
   control anywhere in the app to carry it out.

Two of these are worth generalising beyond the seam rule.

> **A catch that returns a default is a decision to be silent.** Absent and
> unreadable are different facts, and collapsing them hides the second one
> until it costs something. Distinguish them or say so.

> **A number a person spends money against must be reconciled to the ledger,
> not to one of its sessions.** Any per-session view will eventually miss a
> session, and the miss always flatters us.

Note also what caught defect 1: the fixture was written with PowerShell, which
writes BOMs. The walk was one accident away from measuring my own setup instead
of the product. Walking is not a guarantee — it is only better odds than not
walking.

## Standing rule: capture the trail AND the project state

Every verification run keeps its JSONL trail alongside its screenshots. A
screenshot cannot be replayed into a redesigned UI; the trail can, and it is the
only artefact that stays useful after the surface changes.

The M10.8 concurrent run and the M8 end-to-end runs are lost to replay because
only PNGs and prose were kept. Their durations, their nine-task plan and their
adoption refs exist as numbers in a README and cannot be rendered by anything.

### The capture procedure, and why it snapshots at the pauses

**Capture `project-state/` at every point the run stops for a human, not only
when it ends.** A run pauses exactly twice on a clean path — at the plan review
and at the ship bar — and those two pauses are the only moments the two most
important states in the product exist. A single end-of-run snapshot has neither,
which is why the plan review, the ship readiness and the mid-run spend all had
to be synthesized or corrected after the fact.

For the next real run, alongside the trail:

```
# 1. the moment the plan review appears, before pressing Approve
cp -r .hivemind docs/evidence/<run>/project-state-at-review/

# 2. mid-run, while more than one agent is working
cp -r .hivemind docs/evidence/<run>/project-state-at-midrun/

# 3. the moment the ship bar appears, before pressing Ship it
cp -r .hivemind docs/evidence/<run>/project-state-at-ship/

# 4. after adoption, as today
cp -r .hivemind docs/evidence/<run>/project-state/
```

Each is a few hundred KB and takes a second. What each one retires:

| Snapshot | Retires |
| --- | --- |
| at-review | the `@review-*` pending-plan boolean, and gives a real unratified spec |
| at-midrun | the mid-run **spend ledger**, which is the last synthesized value left in the set — the whole run's bill currently shows over a trail cut at three of five calls, and unlike the lease store it cannot be rebuilt because no per-call resource event exists |
| at-ship | the `@ship` readiness boolean |

The collector should prefer a snapshot whose name matches the cut it is building
and fall back to `project-state/` — which is what it reads today, and is why
every cut is currently served state from after itself.

**The generalisation, which is the third correction to this rule:** the rule
first said *keep the trail*, then *and the project state*, then *and the state
is later than the cut*. All three are the same question asked at different
times — **what does this surface read, and when was it true?** A capture is
complete when every input to the surface is in it **and dated at the moment the
surface is being replayed at.**

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

### spec.draft, and what is left of the front door

`spec.draft` is one adapter call that turns a prompt into a short-form spec,
opens its ideation session, and records the drafter's own alternatives and
self-critique as the orchestrator's round. What comes out is a drafted,
orchestrator-signed spec that `plan.prepare` can plan from.

The round is the drafter's real material. The drafting prompt asks for two
genuinely different ways to satisfy the request with real tradeoffs, and says
that if the request is too thin for two honest alternatives it should raise an
open question rather than invent a second one. A round assembled to satisfy a
validator would be the same theatre as a placeholder non-goal.

**It cannot sign for a person.** `spec.draft` writes
`orchestrator_calls_convergence` and nothing else, and
`test/spec-convergence.test.ts` now names it as another caller that must not
reach `convergence.user` — 7/7, alongside the direct module call, the invented
authorization, the replay, the spec edited after presentation, the CLI without a
TTY, and the four automated surfaces.

#### "Nothing to decline" is an answer

The rough edge is closed. The review offers "There is nothing this should leave
alone" as an explicit choice, which satisfies the Non-goals section. It is never
the default and never prefilled — it has to be chosen — because the gate is
collecting a person's judgement about scope, and "I considered it and there is
nothing" is a judgement. `assessNonGoals` is unchanged: it measures *drafted*
output quality, where a vacuous entry is still theatre.

### The drafter was too eager

Product call, taken 2026-08-11 after the first-run walk. "Add a way to validate
email addresses" blocked on whether validation means practical syntax or the
full standards range. The ambiguity is real, but a reasonable implementer picks
practical syntax and ships, and the person corrects it if wrong.

**Non-blocking ambiguity is the normal condition of software work.** If every
ordinary request stops at a questionnaire, this is a requirements-gathering tool
rather than a build tool.

So the drafter now distinguishes two things:

- **A stated assumption is the default.** Where the request leaves a choice open
  and a competent person would just decide, decide — and record it. The review
  shows "Decisions made for you", and the person can reject any of them.
- **A blocking question is rare and expensive.** Only where no reasonable
  default exists and choosing wrong wastes the whole run. *"Which of the three
  services should this live in"* blocks. *"How strict should validation be"*
  does not.

Assumptions are shown as prominently as non-goals, for the same reason: the
person is accepting a decision they did not make. Drafted non-goals are
constraints somebody else wrote; assumptions are choices somebody else made.
Both have to be visible or the review is a rubber stamp.

The test of whether this worked is the same prompt, unchanged, reaching a plan
with a stated assumption instead of a question.

### A quota-paused run has no way back

Found finishing the first-run walk. When a run pauses on `quota_exhausted` the
manager session reads `stopped`, `continuation_available` is false, and the
queue item carries `action: null`. The person is told "waiting for capacity" and
given nothing to do about it — the same class as the `run_stalled` and
`adoption.indeterminate` silences already listed here: Core records the state,
and the app can only describe it.

What is needed from Core is a resume that does not re-plan: the task's contract,
lease and worktree all survive the pause, so the work is one worker call from
continuing. Today the only way forward is a new prompt, which throws away a plan
the person already approved and pays for planning twice.

### Fresh install pins everything to the flagship

Logged here, belongs in the settings / bring-your-own-keys work.

`init` writes tier globs correctly, so the routing floor computes the right tier
for each task. But it writes only three adapter profiles — `planner`, `manager`,
`worker` — all pinned to `gpt-5.6-sol` at `routing_tier: "strong"`. The floor
has nowhere to fall: there is no cheap or standard provider to route down to, so
every role runs on the most expensive model available.

Measured on the first-run walk: 3 calls, 194,810 tokens, all `gpt-5.6-sol` --
planner 20,469 and 22,112, worker 152,229.

**The defaults are internally inconsistent.** `init` writes a 150,000-token run
ceiling, and one flagship worker call cost 152,229. Either number alone is
defensible; together they guarantee a first run stops on quota *after* the money
is spent. Whatever fixes the provider defaults has to fix the ceiling in the
same change, or the fix is not a fix.

Fixing it today means hand-writing `codex-terra` and `codex-luna` profiles,
which is the terminal again — so it is not a first-run fix, it is the settings
surface's job. `adapter.connect` in the Core-actions list below is where it
belongs.

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

### Built: the settings surface, and a probe instead of a declaration

All four actions below exist now, and the screen that needed them replaces
"Hivemind cannot read these from here yet" with the values themselves. What
follows is what changed against the spec and why, then the part that matters.

**Positioning, so the copy is coherent.** Hivemind is an agent development
environment; a coding agent is a *harness* that runs inside it, paid for by a
subscription the person already has. The screen therefore asks *which coding
agent do you have* and the answer is a harness plus a subscription. Hivemind
holds no provider credential, and a desktop test asserts no input on that screen
asks for one. (The first version of that test banned the *words* — and caught
"Auth, secrets, migrations", which is the plain-language name of the most
dangerous file scope. Banning the vocabulary would have banned the sentence that
protects it. It checks inputs now.)

#### One deviation from the spec, taken deliberately

The spec has `project.init` write `planner` and `manager` profiles for the
chosen provider. It does not, and it should not: **a profile written there is a
declaration no probe has checked**, which is the exact thing `adapter.connect`
exists to replace. `project.init` writes the tier globs and stops; connecting an
agent is the next call and it is one click per role.

`initProject` does still write its own default profiles, so a first prompt has
something to resolve. Those are declarations too, and `config.inspect` now says
so: they come back `installed` with `connected_at: null`, and the screen reads
*"Installed before Hivemind could check it — reconnect to verify what it can
do."* That sentence is the whole difference between this build and the last one.

#### The probe, and what a real agent actually reports

There was no capability probe anywhere. `validateAdapterProfile` is static field
validation and `findDangerousAdapterArgs` refuses bypass flags at spawn; neither
had ever confirmed that a flag TOOK EFFECT — and this project has shipped that
failure twice, with `--ignore-user-config` silently forcing a read-only sandbox
and, separately, a model pin silently ignored for months.

So connecting runs the agent once and compares what it reports against what was
asked for. Designing that meant finding out what a real agent actually says,
which took three live runs against codex-cli 0.147.0:

1. `codex exec --json` emits `thread.started`, `turn.started`, `item.*` and
   `turn.completed`. **It names no model and no sandbox anywhere.** Reading the
   stream alone, four of five capabilities would be unverifiable.
2. Codex writes a session rollout file per run — but `--ephemeral`, which every
   profile carries, suppresses it.
3. Dropping only `--ephemeral` produces a rollout whose **`turn_context`** record
   states `model`, `sandbox_policy.type`, `approval_policy`, `workspace_roots`
   and `multi_agent_version`. That is a genuine startup readback of what
   resolved, not what was requested.

The probe therefore runs **the profile's own argv with exactly one flag
removed**, and finds the rollout by the `thread_id` the run prints on its own
stdout — so it never guesses which file belongs to which run. Probing a
different invocation would prove nothing about the one that runs real work;
dropping that one flag changes only whether the session is persisted.

| Capability | How it is verified |
| --- | --- |
| Carries no bypass flags | static, before anything spawns; a refused profile is never executed |
| Runs without asking anything | exits on its own inside the timeout, and `approval_policy` is read back |
| Can write in this project | `sandbox_policy.type` read back **and** the file it was told to write is on disk — two independent proofs, because a silently read-only sandbox reports success and writes nothing |
| Runs the one model you chose | `turn_context.model` compared to the `--model` argument |
| Reports what it spent | the configured parser has to find real tokens in **this run's own output** |
| Does not start agents of its own | **unverified.** It reports a sub-agent capability; whether it is off is not something it reports |

A live connect on 2026-08-11 verified the first five and reported the sixth as
unverified. `docs/evidence/adapter-probe-2026-08-11/` holds the profile and the
connection record it wrote.

**What is proven live and what is proven by test.** The readback *mechanism* is
live: a real run, a real rollout, real values compared. The *mismatch branches*
are covered by `test/adapter-probe.test.ts` with a stubbed readback, because
making Codex genuinely ignore its own `--model` is not something a test can
arrange. Both regressions have a test named after them.

**Cost, stated before the click.** A connect is one real model call — about 40K
tokens and ten seconds on Codex. The button says so.

**Unverified never becomes supported.** A capability with no readback is
reported `unverified`; only a *failed* required capability refuses. Nothing is
written when a probe fails, so a project can never hold a profile whose
capabilities were assumed.

#### Honest about what works

The catalogue is Core's now, and the client reads it rather than carrying its
own. Three Codex tiers are `supported` — one harness, three models, which is
what tier routing needs. Claude Code is `unverified` and **not connectable**: its
usage parsing has only been checked against recorded output, and its old profile
carried `bypassPermissions`, which this build refuses. OpenCode is
`unsupported`: no argv, no usage parsing, no run. Both carry the specific reason
on screen. A test asserts exactly one harness is supported and that every other
entry has a caveat and no invocation — so the catalogue cannot grow a button
that cannot work.

#### Everything that used to need a text editor

Found by reading Core's config rather than from a list: tier globs (as *Simple /
Ordinary / Risky / Dangerous*, never "tier" or "glob"), both token ceilings, the
worker concurrency limit, the test command, and the interruption level. The run
ceiling shows the measured reality beside it — one real worker call cost between
106,792 and 179,698 tokens on this project's own runs, so a ceiling below that
stops the run *after* the money is spent. The number comes from Core so the
warning cannot drift from what a call costs.

`config.set` takes a fixed key list and refuses anything else rather than
merging it; every write goes back through the same `validateConfig` the loader
uses. It cannot lower a routing floor, because floors are derived from tier and
only the lists that *assign* a tier are writable.

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

### The two synthesized booleans, and what retires them

Everything in a replayed scenario is captured except two flags. Both are marked
in the scenario's own `source` field so the data admits it, and both are listed
here with the capture that would remove the need for them.

| Scenario | Synthesized | Everything else | Retired by |
| --- | --- | --- | --- |
| `<id>@ship` | that `inspectLatestAdoptionReadiness` would answer **ready** | the queue item is rebuilt field-for-field from the run's own `adoption.reviewed`: tasks, files, branch, base commit, both identifiers | a trail captured **while the ship bar is on screen** — i.e. an evidence folder whose `project-state/` is taken between `adoption.reviewed` and `adoption.execute`, rather than after the run |
| `<id>@review-*` | that the plan is **pending** rather than approved | the plan is the run's own ratified plan; the spec is a real drafted spec from `spec-drafting-vacuity.json`, with its real open question and real suggested non-goal | a capture taken at the plan review, before Approve is pressed — the state every first run passes through and no capture has yet stopped in |

Both have the same root cause and the same one-line fix on the next real run:
**capture `project-state/` at the decision, not only at the end.** A run that
pauses for a human is the only moment those two states exist, and the person
sitting at that pause is the one who can take the snapshot.

Neither flag can conjure an affordance. `@ship`'s item carries the real
`adoption.execute` payload it was recorded with, and `@review-*` leaves
`needs_you` empty; nothing in either invents a control or an authorization.

### Two states the corpus could not draw, and now can

Both were added to `tools/collect-replay.mjs` during the visual pass, because a
surface the brief asked to be judged could not be rendered from real data at
all. Both are marked in the scenario's own `source` field.

**`<id>@ship` — ready to ship.** `inspectLatestAdoptionReadiness` compares the
verified set against the *live* repository, and a scratch repository is not the
repository the run happened in, so a trail cut just before `adoption.completed`
projects as "the checks are stale" rather than "ready". The live run showed the
ship bar; the replay of the same trail could not. The queue item is now rebuilt
from the run's own `adoption.reviewed` event, field for field as `buildQueues`
builds it — real tasks, real files, real branch, real base commit. What is
synthesized is the *state*, that readiness would say ready.

**`<id>@review-blocked` / `@review-ready` — the one review.** No trail holds a
plan *awaiting* ratification either. These pair the run's real plan with a real
drafted spec from `docs/evidence/spec-drafting-vacuity.json`, including its real
blocking question and its real suggested non-goal. One boolean is synthesized:
pending rather than approved. `assumptions` is left empty because that
experiment predates the drafter writing them, and an invented assumption would
be exactly the theatre the experiment was run to detect.

**`empty-project`.** A real projection with its run-shaped fields cleared — the
same emptying `replay.html` already does before a playback's first frame. The
first thing anyone sees had never had a scenario.

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
- **Spacing drift has no guard, and needs a different instrument.**
  `design-tokens.test.ts` covers colour, token resolution and — since the
  mutation experiment — radius, because all three are declared as literals in
  `@theme inline`. Spacing is not declared anywhere: it is Tailwind's default
  scale, spent as utilities in TSX, so `px-3` against `px-3.5` is invisible to a
  CSS assertion no matter how it is written. Catching it needs **a lint over the
  markup** — scan the TSX for spacing utilities outside an allowed set, and for
  arbitrary values like `p-[13px]` — which is a different kind of test from a
  token contract and should not be bolted onto that file. Worth building if
  spacing starts drifting; recorded now so the gap is deliberate rather than
  assumed covered.

## Styling

Tailwind v4 (CSS-first, no config file) with the shadcn token set mapped onto
the logo palette in `src/styles.css`, so `npx shadcn add <x>` lands on the
palette with no edits.

### The design system, stated once — 2026-08-11

The whole system, so a future surface has something to conform *to* rather than
a set of examples to imitate. Everything below is enforced by tokens or by a
shared primitive; nothing is a convention held in someone's head.

**Radius.** 2px marks · 3px chips, inputs and keycaps · 4px controls and cards ·
5px panels · 6px overlays. Nothing above 6, and nothing is a pill. The scale
lives in `@theme inline` as `--radius-xs` … `--radius-3xl`, so `rounded-md` means
4px everywhere including in a component the CLI generates.

**Elevation.** Two shadows, and both belong to things that genuinely float
*above* the app: `--shadow-raised` (popovers, tooltips) and `--shadow-overlay`
(dialogs). **There is deliberately no `shadow-panel`.** A panel is separated by
its 1px rule and the canvas behind it. Deleting the token rather than agreeing
not to use it is what makes this hold: reaching for elevation in a layout now
requires inventing a shadow, which is visible in review.

**Rules.** One rule colour, `--rule`. There used to be a second lighter
`--rule-soft` for "inner" borders, which meant every surface had to decide which
weight it was — and they disagreed. It is deleted.

**Type.** 10px (segment names only) · 11px labels, counts, metadata · 12px
secondary · 13px body and controls · 14px primary rows and prompts · 15px panel
headlines · 17/20/22px dialog and surface headlines. Three tracking values are
tokens — `tracking-label` (0.07em), `tracking-tight`, `tracking-tighter` — so the
21 hand-written `tracking-[-0.015em]`-style values are gone.

**The label voice.** 11px, medium, `tracking-label`, uppercase, muted. Panel
headers, lane headings, field names. If a piece of text is a *heading* rather
than a label it is sentence case at 13px or larger. Setting the run's subject —
a sentence somebody typed — in the label voice shouted it, and that was caught
by looking at it.

**Figures.** Mono, and tabular by default: `code, pre, kbd, time, .font-mono`
carry `font-variant-numeric: tabular-nums` in the base layer, because every
figure in this app is read against another one. Hairlines separate readings on
an instrument line, not middots — a middot at 12px reads as punctuation inside
the number.

**Focus.** One treatment, declared once on `:focus-visible`: a 2px navy outline,
1px clear. No component brings its own ring. The one exception is the section
tab, which insets it, because a full-height tab outlined outside itself reads as
a floating box.

**Icons.** **lucide-react, and nothing else.** Its default stroke of 2 is drawn
for 20–24px icons and reads a weight too heavy beside 13px Geist, so
`svg.lucide { stroke-width: 1.75 }` normalises it once in the base layer. That
rule is the only hand-written rule in the app and it is deliberately a
normalisation of a third-party default, not a rule about a surface. It also
enforces the set: an icon from another library carries no `.lucide` class, so it
renders at the wrong weight and shows itself.

**The shared primitives.** `src/components/ui/panel.tsx` — `Panel`,
`PanelHeader`, `PanelLabel`, `PanelCount`. A panel used to be a class string
repeated in three files, which is three chances to disagree, and they did: the
Work rail, the Project record and the plan review each had their own padding,
header height and label style.

### What 21st.dev gave, and what it did not

Used as a source of proven structure, never as a style donor. Every component
was rewritten onto the tokens above before it shipped.

**Taken: `@originui/command`.** Two shapes this palette did not have — the search
row as a ruled header with a leading icon, and `CommandShortcut` as a real
`<kbd>` pushed to the right of a row, so the palette teaches its own shortcuts.
What had to be conformed:

| Arrived as | Shipped as |
| --- | --- |
| `@radix-ui/react-icons` magnifier — **a second icon set** | lucide's `Search` |
| `rounded-lg`, `shadow-black/5` | 4px/6px corners, one rule, no shadow |
| `ring-[3px]` focus | the one navy `:focus-visible` outline |
| `opacity-60` on icons | `text-muted-foreground` |
| 14px rows, `tracking-widest` shortcut text | 13px rows, mono keycap |

**Rejected: every tabs component in the catalogue**, including `@originui/tabs`.
They are all the lifted-pill shape this app already had, so taking one would
have changed nothing except which file the opinion came from. The section tabs
are hand-built as a navy underline on the chrome's own edge — four utilities,
and the toolbar reads as chrome rather than as a widget sitting on chrome. This
is the rule working as intended: a hand-built element that matches beats an
imported one that does not.

**Not searched for at all:** the agent tree, the four-phase task cards, the plan
review and the ship confirmation. Those are the product. No registry has them,
and a component that nearly fits one of them would be worse than nothing.

### What the audit had to fix

Run over every surface at the end of the pass, looking for anything that came
from somewhere else.

- **`shadow-panel` on 14 elements**, including every panel, the two header
  buttons and the plan cards. Removed with the token.
- **`--rule-soft` as a second border weight** in 9 places. Deleted.
- **Three `rounded-full` pills**: the connection dot, and both halves of the
  routing weight bar. The dot is a 6px square now, matching the task marks; the
  bar is a 3px square gauge, matching the spend meter.
- **Radii spread across 6, 8, 10 and 14px.** Now 2/3/4/5/6.
- **Two segmented controls with different mechanics** — the Story/Map toggle and
  the Highlights/Everything toggle were a tinted tray with a raised active chip;
  they are now one bordered, divided group with a navy-wash active cell.
- **Panel headers at three different heights** with three label styles. One
  `PanelHeader`, 36px.
- **`text-sm` (14px) inside the dropdown menu** against 13px everywhere else,
  plus Tailwind's default `shadow-md`/`shadow-lg`, plus 16px icons.
- **Two dialog header paddings** (`px-8 py-6` and `px-6 py-5`) across four
  dialogs. One.
- **A leading hairline** on the run header's instrument line whenever the first
  reading was absent — each reading carried its own separator. `MetaLine` now
  collects what is present and interleaves after.
- **The task row's phase gauge sat directly under the title**, where it read as
  an underline of the title rather than as a gauge. It is at the foot of the row.
- **The map card said its phase twice** — once in the named segments, once in a
  summary line underneath. The line is gone and the count moved to the footer.

### The three surfaces that changed shape, and why

Structure is unchanged; these are the same components rendering the same data.

**The run thread is no longer a chat.** The request was a right-aligned bubble,
which put the one thing the person actually wrote on the far right of a 900px
column and left the left half of the panel empty. It is a quoted block on the
same left edge as everything else, marked by a navy rule. Milestones are a log:
a fixed mono time gutter, a continuous hairline, a square node. The Work tab is
a record of a run, and it should not have looked like a messaging app.

**The idle board is no longer a hero.** A 32px headline broken across two lines
over a paragraph is a marketing page. It is 22px, and the product's whole shape
is stated as two numbered steps against a rule — which is more information in
less space, and is the thing a first-time user actually needs.

**Project runs are a record, not cards.** Rows are flush to the panel, separated
by one rule, with the date fixed in a mono gutter so a stack of runs reads down
a single column.

### Deliberate exceptions

- **`ui/empty.tsx` stays verbatim and stays centred.** It is the standing proof
  that a CLI-generated component lands styled with no manual conversion, so
  editing it would destroy the thing it exists to prove. Its centred block is
  also the right shape for a single empty state inside a panel — the ban on
  centred symmetry is about page layouts, not about one block.
- **The brand mark is drawn, not iconographic.** Two interlocking hexagons in
  the two identity colours, reduced from `Branding/Icon Only White Backround.png`.
  It replaced four rounded squares in a grid, which was both generic and,
  literally, four cards in a grid.

### Round two: four things that looked like style and were arithmetic

Every one of these was reported as "this looks wrong". Three were, and the
fourth was a capture serving state from the wrong moment. Recorded because the
shape keeps repeating: **a surface that looks broken is worth diagnosing before
it is worth restyling.**

**The run's duration was measuring the buffer, not the run.** `runSpanMs` took
the first and last timestamps in the replayed event buffer. The textkit trail
opens with an `autonomy.level_changed` twenty-six minutes before anybody typed
anything, so a six-minute run reported **"took 30m 43s"** and its mid-run cut
reported **"took 26m 27s"** — numbers made almost entirely of the time somebody
spent in settings. The window now starts at the newest `plan.prepared`, which is
the event carrying the request the thread leads with; a trail with no plan keeps
the whole window rather than inventing a boundary. Three tests cover it,
including a trail carrying two runs.

**"Took" on a live run was the capture, not the clock.** The client reads
Core's `manager_session.status` to decide whether a run is live, and
`project-state/` is captured *after* the run — so a trail cut mid-run was served
a session reading `complete`. Core derives that status from the session's own
pending actions, so rewinding the file would mean inventing a scheduled action,
and an invented action can surface an approval control. The enum is corrected on
the projection instead, only for a cut that reaches no terminal event, with
`pending_action` and `continuation_available` untouched. See "the capture is not
wrong, it is later" below.

**"0 files changed" over a commit that changed eight was real, and the trail was
right.** `adoption.completed` in that trail genuinely has no `changed_files` —
it is the pre-fix shape, exactly as the evidence README says. The defect was the
client's: `readStringArray(...) ?? []` collapsed *absent* into *empty*, and the
card stated the second. This is the standing rule about silent catches, arriving
through a `??` rather than a `try`. `changedFiles` is now `string[] | null` and
the card says the record does not list them. The ship bar was always right
because it reads `adoption.reviewed`, which does carry the field.

**"Files being edited — 0" beside three agents holding two files each** was the
same capture problem as the manager session, and this half *was* reconstructible.
See below.

### Standing rule extended: the capture is not wrong, it is LATER than the cut

"Capture the trail AND the project state" was written for state that was
*missing*. The mid-run cuts found the other direction: state that is **present,
captured, and from after the moment being replayed**. A finished manager session
and an emptied lease store were both rendered as fact over a live run.

> **A cut trail must not be handed the run's final file state.** Ask of every
> restored file: is this the same at the cut as at the end? If not, either
> rebuild it from the trail or say the scenario cannot draw it.

The lease store rebuilds cleanly, because `lease.approved` records what was
granted and `lease.released` gives it back — replaying the pair to the cut point
reconstructs exactly who held what. It is written to
`.hivemind/leases/active.json` and read back through Core's own
`readActiveLeases`, so the reconstruction has to satisfy Core's validation to
appear at all. `@midrun` now shows three agents holding two files each, which is
what the live run showed and what the corpus never could.

That is the *trail must be able to rebuild the state* rule paying out: the
events carried enough, so the state came back.

**Still later than the cut, and not rebuildable: the spend ledger.** `@midrun`
shows "5 calls · 622.6K", which is the whole run's bill on a trail cut when
three of five calls had been made. Unlike leases, this cannot be reconstructed:
`resource/ledger.json` is a file and the trail carries no per-call resource
event to replay. Retired by the same capture that retires the two synthesized
booleans — `project-state/` taken at the pause rather than at the end — or by
Core emitting a durable event per call, which would make the ledger rebuildable
the way the lease store now is.

### The rail now draws the map's gauge, because it is the same fact

The rail's four segments were unlabelled grey underlines. The map's are named —
Queued / Editing / Checked / Ready — with the current one in the standing's
colour. Same data about the same task, told worse on the surface people look at
most, and it read as a rendering bug.

`PhaseSpine` is exported from `agent-map.tsx` and the rail renders it, with the
count beside the identifier exactly as the map's card footer does. One
component, so the two cannot diverge again. Note the colour source: the spine is
coloured by `phase.standing` and never by the queue, which is the rule already
recorded above — how far a task *got* is its state and nothing else.

### The empty state was the largest thing on screen

During a live run the inspector held "Nothing from this agent yet" over ~450px
of white, in the exact place the product's claim is strongest. The rail's grid
gave the task list `auto` and the inspector `1fr`, so the panel with nothing to
say got all the leftover height.

Inverted: the list takes the height, the inspector hugs what it has. And an
agent that has said nothing is not an agent doing nothing — with leases restored
the panel now says what it is holding, and opens the file list by default when
it holds anything.

### Progress through phases, not through finished tasks

The rule under the run header was driven by completed count, so it sat at 0% for
the whole first wave of a run — three agents working, and the one ambient-free
progress signal in the app showing nothing having happened. It is now the sum of
cleared phases over the total, which moves every time any task clears one. The
`n/m done` figure beside it is unchanged and still correct; what was missing was
motion, not a different number.

### A disabled control is never filled

"Start building" sat over an empty box as a filled navy button at 45% opacity,
which still reads as pressable. The filled variants now drop to the canvas with
a rule when disabled; the quiet variants keep fading. One rule in
`buttonVariants`, so no surface decides this for itself.

### Confirmed, not fixed: `rejected add src/ledger.js`

Checked rather than assumed, because the client rewriting Core's strings is a
mistake this file already records three times.

- Core's `plainEvidence` (`workspace-inspection.ts`) reads
  `plain_reason` **first**, ahead of `report`, `reason` and `recommendation`.
- `analyze.ts` writes `plain_reason` beside the durable `reason` on
  `patch.rejected` / `patch.accepted`.
- The client renders `task.issue` and `item.detail` verbatim. The containment
  guard leaves this string alone correctly: it carries no banned vocabulary, it
  is simply terse gate output.
- `final-run-transcript-4`, the trail that produces this string, contains **zero**
  occurrences of `plain_reason`. It predates the field.

So the client is deferring correctly and will light up with no change the moment
a rejection happens on a current Core. It has not been *observed* doing so,
because no captured trail contains a rejection carrying the field — which is the
corpus gap already listed under "the refusal half of `plain_reason`".

### The guard that could not fail, and what the guard can actually reach

`test/design-tokens.test.ts` asserted

```js
expect(styles.indexOf("@layer theme, base, legacy, components, utilities;"))
  .toBeLessThan(styles.indexOf('@import "tailwindcss"'));
```

The `legacy` layer went with `legacy.css`, so `indexOf` returned `-1` — and `-1`
is less than any real index. **The assertion passed because the string it looked
for was gone.** Fixed: both halves are asserted now, that the declaration exists
and that it precedes the import.

**Then the whole file was mutation-tested**, because one vacuous assertion is
evidence about the file, not about one line. Each mutation was applied to
`styles.css`, the suite run, and the file restored:

| Mutation | Before | After |
| --- | --- | --- |
| `--amber` → `#ff9900` | fails | fails |
| `--color-muted-foreground` removed from `@theme` | fails | fails |
| `--primary` repointed to `--clay` | fails | fails |
| `@layer` declaration deleted | **passes** | fails |
| `--radius-md` 4px → 9px | **passes** | fails |
| `--radius-3xl` 6px → 24px | **passes** | fails |
| `--radius-sm` deleted | **passes** | fails |

So the answer to "can it catch radius drift" was **no**, and it is now yes: the
radius scale is declared as literals in `@theme inline`, which makes it exactly
as reachable as colour. Every `rounded-<x>` in the app resolves through one of
six names, so asserting those six is a complete guard, and the "nothing above
6px" check catches a pill arriving through a token rather than a class.

**Spacing is out of reach for this file, and should stay out of it.** Spacing is
not declared in CSS at all — it is Tailwind's default scale, spent as utilities
in TSX (`px-3` against `px-3.5`). A CSS assertion cannot see it. Catching that
drift needs a different instrument: a scan of the TSX for spacing utilities
outside an allowed set, which is a lint over markup rather than a token
contract. Worth building if spacing starts drifting; not worth pretending this
file covers it.

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
