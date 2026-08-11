# First-run walk — clean install, 2026-08-11

## Prompt to shipped: no

A clean install gets from prompt to **approved plan and a running worker** with
no terminal and no hand-written document. It does not get to shipped.

It stops on `quota_exhausted`, after the worker finished, because `init` writes
a 150,000-token run ceiling and the worker used **152,229** — an overshoot of
2,229 on a one-task run. Every role pins to `gpt-5.6-sol`, so there is nothing
cheaper to route to and no way to come in under the ceiling.

Two things make that a wall rather than a bump:

- **Raising the ceiling means editing `.hivemind/config.json`.** That is the
  terminal again, which is the condition being tested.
- **A quota-paused run has no recovery path in the app.** The manager session
  reads `stopped`, `continuation_available` is false, and the attention item
  carries `action: null`. The person is told "waiting for capacity" and offered
  nothing to do about it. `05-first-run-quota-stop.png`.

So the defaults are internally inconsistent: the flagship is the only provider a
fresh project has, and the default ceiling is below what one flagship worker
call costs. Either number alone is fine; together they guarantee a first run
stops after the money is spent.

**Cost of the walk to that point: 3 calls, 194,810 tokens** — planner 20,469 and
22,112, worker 152,229, all `gpt-5.6-sol`. That number is the argument for the
settings work: nothing here needed a flagship model.

`04-first-run-work-in-flight.png` is the run working. There is no ship
screenshot, because the run never shipped. `08-post-ship.png` in the textkit
folder still carries the "0 files changed" defect and still needs replacing —
this walk did not replace it.

I raised the ceiling by hand to try to finish the capture, which leaves
clean-install conditions and is recorded here as such. It did not help: the
session had already stopped, and the app offers no way to resume it.

## What a first run does reach, and that part works

**Yes** to everything up to the worker. A clean install reaches a first run with no terminal and no
hand-written document. Same prompt, unchanged — "Add a way to validate email
addresses" — now produces a plan the person can approve, with the ambiguity
recorded as a stated assumption instead of a blocking question.

The assumption that used to stop the run:

> *Validation checks practical syntax suitable for ordinary application input
> rather than implementing every address permitted by the full email RFCs.*

Plus two more it decided rather than asked (boolean return, whitespace
handling), and two substantive non-goals it declined on its own — *"Does not
verify that the address, domain, or mailbox actually exists"* and *"Does not
send a verification email or contact an external service."* Zero open
questions. `03-review-with-assumptions.png` is the review with "Decisions made
for you" populated and **Approve and start enabled**.

Re-run cost: **2 calls, 42,581 tokens**, matching the estimate.

What is still not proven is the second half of the sentence — the run itself.
The walk stops at an approvable review; nobody has clicked Approve on a clean
install and watched work land. That is the next thing to capture.

## The answer before the fix, kept for the record

**Yes for the door, no for the room.** A clean install reaches the one review
with no terminal and no hand-written document — folder chosen, project set up,
prompt typed, spec drafted, plan prepared, review presented. It did not reach a
first *run*, because the drafter raised a blocking open question and the gate
stopped it, which is the gate working.

Whether an ordinary request gets through on the first try: **on this one, no.**
Asked "Add a way to validate email addresses" — the kind of thing someone types
after reading "describe what you want built" — the drafter asked whether
validation should check practical syntax or the full standards-permitted range.
That genuinely changes what gets built. Per instruction the walk stopped there
rather than re-prompting; re-prompting until it passed would have hidden this.

Three drafts of the same prompt raised the same class of question every time
(format-only vs standards-strict vs deliverability). That consistency is worth
more than any single run: a request at this level of ordinariness reliably has
one real ambiguity in it, and the drafter reliably finds it.

## What the walk cost

**4 calls, 83,816 effective tokens** across two attempts — the first stopped by
a bug found mid-walk, the second clean. Both on `gpt-5.6-sol`, because that is
what `hivemind init` pins for every role on a clean install.

| | calls | tokens |
| --- | --- | --- |
| Attempt 1 (drafting + planning) | 2 | 42,203 |
| Attempt 2 (drafting + planning) | 2 | 41,613 |

Drafting is ~20K and planning ~21.5K, matching the estimate. No worker ran, so
the estimated 285–405K was not approached: the gate stopped the walk at ~43K per
attempt, exactly the risk flagged before spending.

**A clean install runs everything on the flagship.** `init` writes `planner`,
`manager` and `worker` profiles all pinned to `gpt-5.6-sol` at
`routing_tier: "strong"`. Tier globs are written correctly, so the routing floor
works — but with only strong-tier profiles present there is nothing cheaper to
route to. Configuring `codex-terra` or `codex-luna` means editing files, which
is the terminal again.

## What the walk found

Two defects, both mine, both from the planning-gate change, and neither caught
by a test:

**1. `plan.prepare` had its own copy of the ratified check.** The gate was moved
in `checkPlanningAllowed`, but `prepareWorkspacePlan` called
`requireActiveSpecRatified` directly, so the first prompt still refused a drafted
spec. Attempt 1 died here.

**2. Autonomy signed for the person.** Worse. With the planning gate loosened,
`auto` reached its policy-ratification branch against an *unsigned* spec and
ratified the plan — `plans/ratified/S-001/` existed with
`convergence.user: false`. The human signature was bypassed entirely, which is
the one thing the whole arrangement exists to prevent.

Both are fixed and pinned in `test/unratified-spec-gate.test.ts`:
`ratifyPlanWithSource` now requires a ratified spec before it writes anything,
and `auto` only suppresses the plan interruption once the spec is signed —
because an unsigned spec is precisely the case where somebody *is* needed, which
is what "only what needs me" means.

The second is the shape this project keeps hitting: loosening one gate silently
widened a second one that depended on it. Planning-before-ratification was
audited beforehand for anything inferring ratification from a plan's existence,
and that audit was clean. It did not ask the reverse question — what *grants*
ratification — and that is where the hole was.

## The trail

`firstrun-pending-plan.jsonl` plus `project-state/` is the first capture of a
**plan awaiting ratification**. Every earlier trail was captured after
ratification, because the run ratified as it went.

**It captures but does not replay, and that is structural.** The collector
replays into a scratch repository, and a *tentative* plan is bound by grounding
to the commit it was planned against:

```
firstrun-pending-plan  2 events  NO PROJECTION: plan-lint failed:
GROUNDING_FRESHNESS: tentative plan base 6b0e28b3… is stale relative to
current HEAD ceaf8a6a…
```

A ratified plan replays because it is read as a stored artefact; a tentative one
is re-linted against the live repository, and no scratch repository can have the
history it was planned against. Closing this needs the collector to reconstruct
the base commit, not just the project state.

So the pending review is **no longer fixture-only** — `02-first-run-one-review.png`
is the live screen from this walk, which is stronger than a replay — but it
remains the one state the replay harness cannot reproduce. Recorded per the
standing rule rather than glossed.

The collector's three-event floor was also wrong for this case and now admits any
run carrying a plan, however short: a run stopped at its review is two events.

## Files

| File | What it is |
| --- | --- |
| `firstrun-pending-plan.jsonl` | The trail at the pending review. Two events; the run had not started. |
| `project-state/` | Spec, drafted ideation, tentative plan, ledger, adapter logs, ceilings. |
| `01-first-run-plan-waiting.png` | The plan bar, from a clean install. |
| `02-first-run-one-review.png` | The one review: blocking question, verbatim prompt, suggested non-goal, approve disabled with the reason. |

The suggested non-goal in that screenshot is worth reading — *"Does not verify
that an email address exists, can receive mail, or belongs to the person
entering it."* That is a real declined scope, and the tempting adjacent thing.
On the config-reader prompt in the earlier experiment the drafter declined
nothing at all. So it is capable of the thing it sometimes skips, which is an
argument for keeping the person as the author rather than trusting the draft.
