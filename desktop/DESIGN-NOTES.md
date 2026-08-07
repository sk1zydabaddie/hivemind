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

## Deferred, with reasoning

### Four tabs should probably become two

Work, Swarm, Memory and History were designed when the app asked for ~10
decisions. Three of them are inspection surfaces for a person who, by the
product model above, does not want to inspect anything.

- **Swarm should be a view toggle inside Work, not a tab.** It draws the same
  run the Work tab already describes, in tree form. At 2–3 tasks it is mostly
  orientation, which the thread and the rail now provide. As a toggle it earns
  its place at 8+ tasks without costing a permanent tab.
- **Memory and History should collapse into one "Project" surface.** Both are
  read-only records of what this project has learned and done. They are one
  concept — the project's past — split across two tabs.

That would take the shell to two tabs: **Work** (the run) and **Project** (its
history). Deferred because it is a larger IA change than the hole it fixes, not
because the reasoning is weak.

### A known class of bug: Core records it, the UI never shows it

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

### Actions with no way to reach them

Four audited workspace actions have no control anywhere in the desktop. Not
bugs, but a real product gap:

- `manual_task.review` / `manual_task.authorize` — manually authored tasks have
  no surface at all.
- `verify.characterize` — no way to ask for a characterization test.
- `quality.best_of_n` / `quality.draft_refine` — you can **cancel** a quality run
  from the Swarm tab but you cannot **start** one from anywhere, which is the
  wrong half to expose.

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

Every screenshot and every design judgement so far comes from a fixture harness
that stubs the Tauri IPC and the SSE transport. The redesign has never been seen
against a live daemon. Long titles, real error text, 15-task plans, real
durations and real failures will find edges the fixtures cannot. Treat the
fixture harness as a layout tool, never as verification.

### Client-side, not yet done

- **Responsive behaviour outside 1440×900.** Above ~1600 the rail should widen;
  below ~1100 it should collapse to a toggle. Currently fixed with a 820px
  minimum.
- **Accessibility beyond the basics.** The task list is buttons inside sections;
  a listbox with roving focus is probably more correct. Keyboard traversal and
  screen-reader flow have not been tested on the redesigned markup.

## Styling

Tailwind v4 (CSS-first, no config file) with the shadcn token set mapped onto
the logo palette in `src/styles.css`, so `npx shadcn add <x>` lands on the
palette with no edits.

- **Panels on a canvas.** Content lives in rounded panels with real padding on a
  `--canvas` ground. Grouping comes from the container, not from a grid of
  full-bleed rules.
- **Palette.** Navy and charcoal are the identity. Amber and clay appear *only*
  where they carry meaning (needs attention, failed). No other hues, no
  gradients.
- **Motion reflects real events.** The run-progress rule moves when a task
  finishes. Nothing loops for decoration.
- `src/legacy.css` serves the untouched Swarm/Memory/History tabs from an
  `@layer legacy` declared below Tailwind's utilities, with the old variable
  names aliased to the new palette. Nothing new should be added there; each tab
  drops its share when it gets redesigned.
