# Visual pass — 2026-08-11

A look-only pass. No information architecture changed, no behaviour changed, no
defect was fixed. Two surfaces, the run thread, the task rail, the plan review
and the ship bar are exactly where they were.

Every image below is the real app at **1440×900**, driven by `replay.html`
against captured trails — not a fixture, and not a mockup.

```
npm run replay:collect
npm run dev   ->  /replay.html?scenario=<id>
```

| # | Surface | Scenario |
| --- | --- | --- |
| 01 | Work, a run in flight | `e2e-textkit-parallel-run@midrun` |
| 02 | Work, idle | `empty-project` |
| 03 | The one review, blocked on a question | `e2e-textkit-parallel-run@review-blocked&open=plan` |
| 04 | The ship bar | `e2e-textkit-parallel-run@ship` |
| 05 | Project | `e2e-textkit-parallel-run&tab=project` |
| 06 | The map, three agents at once | `e2e-textkit-parallel-run@midrun&view=map` |
| 07 | The approved plan, read-only | `e2e-textkit-parallel-run&open=plan` |
| 08 | Needs you | `final-run-transcript-4` |
| 09 | Command palette | `e2e-textkit-parallel-run&open=commands` |
| 10 | Settings | `e2e-textkit-parallel-run&open=settings` |
| 11 | The shipped card | `e2e-textkit-parallel-run` |

## What is real in each, and what is not

Per the standing rule, the synthesized parts are named rather than left to be
discovered.

- **01, 06, 07, 08, 09, 10** are entirely captured state. `@midrun` is the
  textkit trail cut at peak concurrency and projected by Core, which is the only
  honest rendering of three agents working at once this corpus can produce.
- **02** is a real projection with its run-shaped fields cleared — the shape of a
  project that has done nothing. Nothing is invented; the ceilings, the settings
  and the object shape are the run's own.
- **03** pairs the run's **real** four-task plan with a **real** drafted spec from
  `docs/evidence/spec-drafting-vacuity.json` — its real open question, verbatim.
  One boolean is synthesized: that the plan is *pending* rather than approved.
  No captured trail holds a plan awaiting ratification, because the real run's
  plan was ratified during it.
- **04** is the trail cut just before `adoption.completed`, with the readiness
  queue item rebuilt field-for-field from the run's own `adoption.reviewed`
  event. The tasks, the files, the branch and the base commit are all read out
  of that durable event. What is synthesized is the *state* — that the readiness
  check would say "ready" — because `inspectLatestAdoptionReadiness` compares
  against the live repository, and a scratch repository is not the repository
  the run happened in.

Both cuts are marked in the scenario's own `source` field, so a future reader
sees it in the data and not only here.

## What the mid-run cut can now show

`@midrun` restores the lease store by replaying `lease.approved` /
`lease.released` to the cut point, so **01** and **06** show the three agents
holding two files each — which is what the live run showed and what every
earlier capture reported as zero. The manager session's status is corrected to
live for a cut that reaches no terminal event, so the header says *running*
rather than *took*. Both are described in DESIGN-NOTES under "the capture is not
wrong, it is LATER than the cut".

## Known defects visible in these images

Core-side, predating this pass, preserved rather than hidden.

- **11 / "This project's record of the change does not list the files."**
  `adoption.completed` did not record `changed_files` when this trail was
  captured. The card used to read "0 files changed" over a commit that changed
  eight; it now reports the absence instead of asserting a zero. Core writes the
  field, so a fresh run renders "8 files changed".
- **08 / `rejected add src/ledger.js`** renders as Core recorded it. This trail
  predates `plain_reason`; the client defers correctly and needs no change when
  a current Core rejects a patch.
- **01, 06 / the spend meter reads "5 calls · 622.6K"** — the whole run's bill on
  a trail cut when three of five calls had been made. The ledger is a file and
  the trail carries no per-call resource event, so unlike the lease store it
  cannot be rewound. The same capture-at-the-pause that retires the two
  synthesized booleans retires this too.
