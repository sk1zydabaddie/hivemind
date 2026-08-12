# UI pass — 2026-08-12

Four things: internal identifiers removed from every user-facing surface, the
agent graph restored as a first-class view, the comprehension problems fixed,
and honest progress feedback added.

Every image is the real app at **1440×900**, driven by `replay.html` against
captured trails — not a fixture, and not a mockup.

```
npm run replay:collect
npm run dev   ->  /replay.html?scenario=<id>
```

| # | Surface | Scenario |
| --- | --- | --- |
| 01 | Work, a run in flight | `e2e-textkit-parallel-run@midrun` |
| 02 | Work, idle | `empty-project` |
| 03 | The plan record, with HOW IT IS CHECKED | `e2e-textkit-parallel-run&open=plan` |
| 04 | The ship bar, first state | `e2e-textkit-parallel-run@ship-review` |
| 04b | The ship bar, confirmed state | `e2e-textkit-parallel-run@ship` |
| 05 | Project, with what has accumulated | `e2e-textkit-parallel-run&tab=project` |
| **06** | **The agent graph, three agents at once** | `e2e-textkit-parallel-run@midrun&tab=agents` |
| 06b | The agent graph, finished | `e2e-textkit-parallel-run&tab=agents` |
| 07 | The approved plan, read-only | `e2e-textkit-parallel-run&open=plan` |
| 08 | Needs you | `final-run-transcript-4` |
| 09 | Command palette | `e2e-textkit-parallel-run&open=commands` |
| 10 | Settings | `e2e-textkit-parallel-run&open=settings` |
| 11 | The shipped card | `e2e-textkit-parallel-run` |

## What changed, and where to look

**06 is the restored view**, on `@midrun` — the textkit trail cut at peak
concurrency and projected by Core, which is the only honest rendering of three
agents working at once this corpus can produce. Three agents hang off one
branch under `3 AT THE SAME TIME`; a fourth sits below under `THEN`, dashed and
faint, naming the three titles it waits for. The parallel/sequential structure
is the drawing, not the labels.

**08 is the sentence that was reported.** It read

> Initialize CLI package metadata and usage docs
> **Initialize CLI package metadata and usage docs needs a revision T-001**

and now reads

> **Initialize CLI package metadata and usage docs**
> Needs a revision
> rejected add src/ledger.js

Nothing on any of these thirteen images contains `T-`, `G-`, `S-` or `V-`
followed by a number. `test/identifiers.test.ts` renders the same surfaces
against the same trails and asserts it, and the assertion was mutation-tested:
putting the identifier back in the rail row fails 12 render assertions, and
putting the stage identifier back in the plan review fails the source scan.

**01 and 06 carry the new header.** *What you asked for* is labelled as such,
the headline says what is happening now, and the progress bar underneath is
cleared phases over total phases with the figure beside it. The interruption
control is labelled **Interruptions** instead of rendering its own value, which
is what made the old header read as three competing statuses.

**05 carries the accumulation**, and the line under it is the point:

> Not counted here, because this project's record does not carry it: how many
> files all of this changed, and how much time it saved you.

**11 is the ship moment.** Navy band, the real task count, the real branch, the
real commit. Every figure is from `adoption.completed`.

## What is real in each, and what is not

Per the standing rule, the synthesized parts are named rather than left to be
discovered. Unchanged from the previous pass:

- **01, 06, 06b, 07, 08, 09, 10, 11** are entirely captured state.
- **02** is a real projection with its run-shaped fields cleared — the shape of
  a project that has done nothing. Nothing is invented.
- **03/07** show the run's **real** ratified four-task plan.
- **04** is the first ship state, from a trail cut before `adoption.reviewed`.
  **04b** synthesizes exactly one boolean — that readiness would answer *ready*
  — over a queue item rebuilt field-for-field from the run's own
  `adoption.reviewed`.

**The completion animation cannot appear in any of these.** It fires on
artifact movements, which `recordArtifactMovements` writes only from the live
stream — a replayed trail produces none. That is deliberate: reading an old run
should not celebrate. It is therefore the one thing in this pass verified by
test and by construction rather than by screenshot.
