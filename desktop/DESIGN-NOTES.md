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

## Known gap: the original request is not recorded

Core records only `prompt_hash` (SHA-256) on `plan.prepared`. The text a person
typed to start a run is not durable anywhere:

- the planning proposal JSON holds only `tasks` and `execution_groups`
  (extra top-level fields are rejected),
- `manager.start`'s `message` derives the proposal and is never persisted into
  the session file.

So the thread cannot show you what you asked for. Mid-run **guidance** is fine —
`human.guidance_recorded.data.message` is durable, and `human.guidance_consumed`
tells us whether it has been used yet.

`buildRunThread` already reads `event.data.prompt` and renders the request entry
the moment Core emits it. The ask, mirroring the shape guidance already uses:

```
plan.prepared.data.prompt   // the normalized request text, same 20k cap as guidance
```

Do not reconstruct this client-side. A thread rebuilt from React state
disappears on reload, which is worse than not having it.

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

### Waiting on Core

- **Durations.** There is no elapsed time anywhere, and "how long will this
  take" is the first thing a person asks during a run. A client-side ticking
  clock would be ambient motion and derived state; the clean version is Core
  emitting durations on events it already sends.
- **Raw error text leaking into a polished surface.** `plain-language.ts` maps
  known Core failures to plain sentences with a fixed regex list. Anything
  unmapped renders raw. The correct fix is a plain-language field on the daemon
  error, not a longer list of regexes here.

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
