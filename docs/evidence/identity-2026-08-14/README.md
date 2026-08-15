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

---

## Update — the lanes on the canvas

`work-midrun.png` was re-captured after the lanes were promoted out of the rail.

At rail width a lane was a 2px tick roughly 20px tall, smaller than the phase
pips beside it: the signature object was the least visible thing on screen
during the exact moment the product's claim is strongest, while the centre
column held three lines of timeline and a large empty region.

The lanes now take the canvas while work is in flight — one column per task,
tracks running down side by side, four phase stations each. Three agents working
in parallel is three tracks next to each other, countable at a glance.

The timeline and the composer are unchanged and in the same places. The rail's
inspector is unchanged. The map is untouched: it is already a full-size picture
of the same fact, so the canvas is not drawn over it.

**One rule, not three.** At rail width three gate hairlines stacked in a column
read as quiet. At canvas width they read as a decorative divider stack — the
horizontal noise this was explicitly not to become. The passed gates now share a
single rule the lanes descend from, naming all of them:

```
──── SCOPE 3 file claims approved · WRITE 3 edits approved · NEXT STEP 2 decisions approved ────
```

A held gate still gets its own, in clay and doubled, because it is the one that
has stopped something.
