# End-to-end run — textkit, 2026-08-11

The first captured run in this repository containing `plan.*` events,
`adoption.*` events, routing observations and a completed run. Every earlier
trail in `docs/evidence` stops short of all four, which is why the plan review,
the ship confirmation and the populated Project surface had only ever been
rendered from fixtures.

**The trail is the artefact.** `e2e-textkit-parallel-run.jsonl` replays into the
current UI and will replay into the next one; the PNGs will not.

```
npm run replay:collect
/replay.html?scenario=e2e-textkit-parallel-run
```

## What was run

A scratch repository (`textkit`, plain ESM JavaScript, `node --test`) holding one
helper, `capitalize`. One prompt through the desktop app asked for three more
helpers, each in its own file with its own tests, plus README documentation.

Driven entirely through the desktop app: prompt, plan review, approve, real
workers, ship. The app was the real Tauri shell talking to the real daemon over
its real IPC; only the clicking was synthetic, through the WebView2 debugger.

## What happened

| | |
| --- | --- |
| Prompt submitted | 05:45:34Z |
| `plan.prepared` | 05:46:16Z (~42s) |
| `plan.ratified` | 05:47:50Z |
| Wave 1 — T-001, T-002, T-003 **in parallel** | 05:47:53 → 05:49:30 |
| First `integration.passed` | 05:49:38Z |
| Wave 2 — T-004 (depends on all three) | 05:49:40 → 05:50:33 |
| Second `integration.passed` | 05:50:41Z |
| `adoption.completed` | 05:52:12Z |
| Wall clock, prompt to shipped | **6m 38s** |

The planner produced 4 tasks in 2 stages: three independent helpers that ran at
the same time, then one dependent task exporting and documenting them.

**No task was rejected and no task failed.** Every patch was accepted on its
first attempt, both verification passes were green.

## What it cost

| Provider | Model | Calls | Effective tokens |
| --- | --- | --- | --- |
| `planner` | gpt-5.6-terra | 1 | 23,272 |
| `codex-terra` | gpt-5.6-terra | 4 | 599,311 |
| **Total** | | **5** | **622,583** |

Per task: T-001 106,792 · T-002 156,072 · T-003 179,698 · T-004 156,749.

Three things worth recording:

- **The manager made zero model calls.** On a clean run the orchestration is
  deterministic code, so the only calls are one planner call and one per task.
  The estimate for this run assumed 5–7 manager calls; the real number was 0.
- **Tier routing changed the price, not the volume.** ~124K effective tokens per
  call here matches the ~120K/call this project records on every tier. What
  routing bought was gpt-5.6-terra (standard) instead of gpt-5.6-sol (strong)
  for all five calls.
- **`codex-luna` (cheap) was never used, correctly.** The one documentation task
  also edits `src/index.js`, so its scope is Medium, and Medium's floor excludes
  a cheap-tier provider. A task is tiered by the riskiest file it touches.

## Verified against the repository, not the UI

```
before   1cf937fabc5483d612a8a48999d8b409d6c7a615   "Fix test script glob"
after    6b024f5c11938085e07389ace42796a74231a878   "Hivemind adoption V-dd2b132a…"
         8 files changed, 91 insertions(+)
```

`npm test` on `master` after adoption: **11 tests, 11 pass, 0 fail** — the
combined set. The pre-existing `capitalize` test survived alongside ten new
tests from three workers that never saw each other's files.

```
test/capitalize.test.js   1 test   (pre-existing)
test/slugify.test.js      3 tests  (T-001)
test/truncate.test.js     4 tests  (T-002)
test/wordCount.test.js    3 tests  (T-003)
```

## What this run proved about `plain_reason`

11 events in this trail carry `plain_reason` beside the untouched durable
`reason` — the first trail in which they coexist:

```
reason      : "all changes are within scope"
plain_reason: "Every file it changed was one this task was given."
```

The run was clean, so only the accept path was exercised here. The refusal
sentences are covered by `test/plain-reason.test.ts`, not by this trail.

## What this run found

**`adoption.completed` could not say what it shipped.** The shipped card read
"0 files changed" over a commit that changed eight. `adoption.reviewed` records
`changed_files`; the started/completed pair did not — a receipt rather than a
record, and the fifth instance of the standing rule in DESIGN-NOTES. Fixed in
`src/adoption.ts` after this run, so **this trail still shows the defect**;
`10-replayed-from-trail.png` preserves it.

**The desktop cannot start a run on a fresh project.** `plan.prepare` refuses
with `no active spec; create and ratify a spec before planning, leasing, or
running workers`. Reaching a first prompt needed four terminal commands with no
surface anywhere in the app:

```
hivemind spec S-001 --create --title "…"      # then fill 9 sections by hand
hivemind ideate S-001 --start --title "…" --goal "…"
hivemind ideate S-001 --round round.json      # ≥2 alternatives + a self-critique
hivemind spec S-001 --ratify
```

That error is also raw Core text on a primary surface, using three words the
product does not say.

**Observed inspection lag.** For roughly a minute after the wave started, the
Work tab read `0/4 done` and "Waiting on the next task" while the daemon already
reported tasks running, then verified. It resolved on its own. The run took 90
seconds end to end, so this is a fast-burst case; recorded as observed, not
diagnosed.

## Replay verification, 2026-08-11

The three surfaces that had only ever been drawn from fixtures were replayed
against this trail. A trail alone could not do it: the plan, the ledger and the
manager session are **files, not events**, so the run projected with a null plan
and zero spend. `project-state/` beside the trail now carries them, and the
collector restores it.

| Surface | Verdict |
| --- | --- |
| Plan review | **Correct.** 4 steps in 2 stages, real titles, real file scopes, real acceptance criteria, real conformance commands, plan hash `3d87a3cad249`. No defect. |
| Ship confirmation | **Defect reproduced and fix confirmed.** This trail renders "0 files changed"; the same trail with the field Core now writes renders "8 files changed". |
| Project surface | **One defect, fixed.** It reported what shipped and said nothing about what it cost. Spend was real but buried in a disclosure; it is now on the run's summary line. |

Two replay artefacts were found and fixed in the collector rather than lived with:

- **Spend read amber against the wrong ceiling.** The replay compared 622.6K of
  real usage to init's 500K default, so a run comfortably inside its real 2.5M
  ceiling rendered as nearly out of budget. `project-state/config.json` now
  carries `resource_policy` and `execution` only — never `repo_root` or a base
  branch, which belong to the machine that ran it.
- **No mid-run state existed anywhere.** Every captured trail projects only to
  its end, so "three agents working at once" had only ever been a fixture or a
  screenshot caught at whatever moment a human pressed the button — and the two
  live captures here (`03`, `04`) both landed inside an inspection-lag window
  showing "Waiting to start" beside three running tasks. The collector now emits
  `<id>@midrun`, the trail cut at peak concurrency and projected by Core, which
  renders the honest state: 3 running, 1 waiting.

`project-state/` deliberately omits `plans/S-001.tentative.json`. It is
superseded by the ratified plan, and its grounding is stale against any scratch
repository, which fails plan-lint on a mid-run cut.

### Not verified by this trail

- **The vocabulary guard and `taskAttentionTitle` are not exercised here.** This
  run was clean, so it produced **no queue items at all** — nothing ever needed
  a person. Both were verified across the rest of the corpus instead: 6 of 6
  attention titles lead with the task title where one is known, the 4 that lead
  with an identifier are `m7-4`, whose trail records no `task.created` and so
  has no title to lead with, and the guard fires on 3 pre-`plain_reason`
  reasons containing "lease". Zero Core strings anywhere still say *merge*.
- **Memory items.** "What it has learned" is empty because this project learned
  nothing. Populated memory remains fixture-only.
- **The refusal half of `plain_reason`.** Nothing was rejected.
- **Mid-run lease state.** Leases were released at adoption, so the restored
  state has none and the mid-run replay shows "0 files being edited" where the
  live run showed 2 per task.

## For the website

**Three strongest, in order:**

1. `15-replay-midrun-map.png` — "3 tasks running", three phase cards mid-flight,
   the dependent task waiting below. This is the product's whole claim in one
   image, and it exists only because the collector can now cut a trail mid-run.
2. `11-replay-plan-review.png` — what gets approved before anything runs: the
   files each step may touch and how each result is checked.
3. `07-ship-confirmation.png` — "Confirm this exact change set · 4 tasks · 8
   files · into master", the second and last decision.

**Do not use `03-work-in-progress.png` or `04-map-parallel.png`.** Both live
captures landed inside an inspection-lag window: the rail reads "Waiting to
start" beside three tasks the thread says are working. `14`/`15` replace them
and are correct.

**Needs recapturing before publication:** `08-post-ship.png` shows the "0 files
changed" defect. Recapture it after the next real run, when
`adoption.completed` carries the field. The replayed `10` has the same problem
for the same reason.

Two cosmetic notes on the replay shots: the run header says "took 26m 27s"
because the trail's span includes idle time before the prompt, and the inspector
reads "Nothing from this agent yet" because the replay harness does not yet play
back worker output.

### Can the trail produce a sped-up demo video?

**The data is sufficient; the harness is not yet.** Everything needed is now
captured:

- 105 events with real timestamps — the run is ~7 minutes of activity inside a
  30-minute span, clustered in bursts (39 events in one 30-second window when
  the wave starts).
- `project-state/log/tasks/*.output.jsonl` — 71 real worker output records with
  timestamps and tool names, in exactly the shape the desktop's output stream
  serves.

Two things are missing, both in `tools/replay.tsx` rather than in the evidence:

1. **Timed playback.** The harness fires every event at once. A video needs the
   events emitted on their real relative timing, divided by a speed factor.
2. **Output stream playback.** The harness stubs `/output/stream` and returns
   nothing, so the inspector stays empty. The records exist; nothing serves them.

Both are small and use only captured data. Until they exist, a demo showing live
agent output has to be a fresh screen recording — but a fresh recording would
capture the same inspection lag that spoiled `03` and `04`, so the replay route
is the one worth building.

## Files

| File | What it is |
| --- | --- |
| `e2e-textkit-parallel-run.jsonl` | The durable trail. 105 events. Replayable. |
| `resource-ledger.json` | Measured spend, per provider and per session. |
| `spec-S-001.md` | The ratified spec the plan was built from. |
| `01-plan-waiting.png` | Plan ready, nothing started. |
| `02-plan-review.png` | The plan review, from real data. |
| `03-work-in-progress.png` | Three workers running at once. |
| `04-map-parallel.png` | The map: two stages, four phase cards. |
| `05-ready-to-ship.png` | Checks passed, ship bar. |
| `06-ship-files-expanded.png` | The eight files, expanded. |
| `07-ship-confirmation.png` | "Confirm this exact change set". |
| `08-post-ship.png` | Shipped, with the adoption ref. |
| `09-project-after-run.png` | The Project surface after a real run. |
| `10-replayed-from-trail.png` | The trail replayed back into the UI. |
| `11-replay-plan-review.png` | The plan review, replayed from the trail. |
| `12-replay-project.png` | The Project surface, replayed, with spend on the line. |
| `13-replay-map.png` | The map, replayed at the finished state. |
| `14-replay-midrun-story.png` | Cut at peak concurrency: three tasks running. |
| `15-replay-midrun-map.png` | The same moment as the map. **Landing-page shot.** |
| `project-state/` | The files a trail cannot carry: spec, plan, contracts, ledger, session, and the run's ceilings. Restored by the collector. |
