# Visual identity — 2026-08-14

Three surfaces, each rendered from a **replayed durable trail** rather than a
fixture. Every number, task, lane and gate count on screen came out of a run
that really happened, under `docs/evidence/e2e-2026-08-11-textkit/`.

Driven over CDP against the dev build. The harness refuses to photograph a
surface that does not contain what the shot came for — it polls for content and
throws rather than sleeping on a timer, because a blank screenshot has been
mistaken for a result on this project before.

## `work-midrun.png` — `e2e-textkit-parallel-run@midrun`

The trail cut at peak concurrency. Three agents working, one queued.

- **Lanes.** Three navy tracks running side by side down the rail, each headed
  by a hexagon, and a fourth in rule-grey for the task waiting to start. The
  product's claim is parallel work; this is the first build that draws it.
- **Gates.** Three hairlines above the lanes: `SCOPE 3 file claims approved`,
  `WRITE 3 edits approved`, `NEXT STEP 2 decisions approved`. Counted from
  `lease.approved`, `write_intent.approved` and `manager.action_approved` in the
  trail. One rule per gate — not per task, not per phase.
- **Phases.** Four hexagons and the live phase named (`EDITING`), replacing four
  unlabelled grey rules.

Nothing has gone wrong in this shot, and it still shows that something is being
enforced. That was the objective.

## `ship-moment.png` — `e2e-textkit-parallel-run`

The same run, complete.

- The lane hexagon arrives at full size on the navy card with its check drawn.
- `4 tasks landed on master`, `30m 43s from first step to shipped`, `landed as
  6b024f5c11` — all durable facts from `adoption.completed`.
- Finished lanes step out of the traffic: their tracks fade toward rule-grey and
  their hexagons carry checks.
- The gate counts have moved with the run: 4 file claims, 4 edits, 6 decisions.

## `accumulation-comb.png` — Project

Four filled hexagons, one per task this project has shipped. `tasksShipped` sums
`merged_tasks` over recorded runs; the comb is that number and nothing else.

No streak, no weekly average, no percentage against a previous period, and no
count-up on mount. Every stat component surveyed for this pass offered all four
and every one of them is invented.

## `installed-binary-icon.png`

Extracted with `Icon.ExtractAssociatedIcon` from
`%LOCALAPPDATA%\Hivemind AI\hivemind_desktop.exe` **after installing**, version
`26.814.2146`.

This is the check the brief asked for and it is worth keeping as a habit: the
config having an `icon` list is not evidence that the mark reached the artifact.
Windows had previously fallen back to a default with the config looking correct.
The only thing that settles it is reading the icon back out of the binary that
was installed.
