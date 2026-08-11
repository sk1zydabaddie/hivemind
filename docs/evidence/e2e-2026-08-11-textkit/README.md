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
