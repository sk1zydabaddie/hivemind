# Design notes

Durable notes about behaviour that is deliberate, and about known conditions that
should not be re-diagnosed from scratch when they recur.

## Adoption indeterminacy is two conditions, not one

An `adoption.indeterminate` record does not always mean the same thing, and
treating it as one thing gets it wrong in both directions.

**Resolvable.** The base provably transitioned and only finalization is
incomplete -- typically cleanup could not remove a worktree. Later evidence
really does resolve this: clear the obstruction and startup reconciliation
finishes the adoption and records `adoption.completed`. This is a designed
recovery path and it must stay open. Marking every indeterminate terminal
destroys it, which is what the existing "cleanup failure leaves the lease held
and startup reconciliation can retry" test exists to catch -- and did.

**Unresolvable.** The system cannot determine the outcome at all: a malformed
intent, a HEAD matching neither the pre-adoption nor the candidate ref, or a
candidate ref whose tree contradicts the intent. Reprocessing cannot turn
"cannot determine" into a determination; it only re-appends the same conclusion
on every daemon start, without bound. These are terminal on the first record.

Records carry `resolvable` to distinguish them. Resolvable records are still
bounded by `MAX_INDETERMINATE_ATTEMPTS`, so a condition that never clears -- and
any record written before that field existed -- cannot append forever either.

Neither kind is silent. Both surface with `action: null`, because there is no
safe automatic recovery for an outcome nobody can determine, and both carry
`pre_adoption_ref`, `candidate_commit`, and the observed HEAD so a human can
check the branch by hand.

## Concurrency test determinism (M10.4 / M10.5)

Concurrent lane tests used to prove overlap by comparing event timestamps and
wall-clock windows of real spawned processes. That is a measurement, not a
proof: on a loaded machine the ordering it assumed stopped happening, and the
tests failed for reasons unrelated to the guarantee. One of them
(`a provider quota wall pauses only its lane`) measured at 1/3 passes under load
and 6/6 idle.

These fixtures now use an explicit barrier. Each fake worker announces itself
(`<barrier>/<taskId>.started`) and blocks until released (`<barrier>/release` or
`<barrier>/<taskId>.release`). Tests use `waitForWorkersInFlight` to prove that
N lanes are simultaneously in flight before any of them reaches an outcome, and
`releaseWorkers(dir, [taskId])` to drive one lane while its siblings are
provably still blocked.

The properties are therefore proven causally rather than temporally:

- cap N holds exactly N lanes in flight, and lane N+1 appears only as a
  consequence of releasing one of them;
- a failing lane is inspected against siblings that are still blocked, so an
  intact sibling lease/worktree/reservation is an observation, not a race;
- "already-reserved sibling" is established before the quota wall is allowed to
  fire.

When adding a concurrent test, do not reintroduce a sleep to create overlap.
Hold the lanes and observe them.

### Claims that remain sampled by design

- **Elapsed-time speedup.** The M10.4 value proposition is about real worker
  durations, which a barriered fixture deliberately controls. The barrier proves
  that work overlaps; it cannot prove how much wall-clock time that saves. The
  worker-window comparison is reported as a `context.diagnostic` measurement and
  is not asserted.
- **Spawn-time session reservation refusal.** That test injects a competing
  reservation into a window inside Core's launch loop. The fake agent only
  announces after Core has already reserved, so the barrier offers no
  synchronisation point there. Making it causal needs a Core-side test seam.
  The window it races for is wide (a full lane setup), and it has not been
  observed failing, but it is a race-injection test rather than a proof.

### Known unreproduced flake

`a concurrent worker failure settles only its lane while independent siblings
continue and keep their resources` failed once, on the first iteration of a
batch, after conversion to the barrier. It then passed 12/12 consecutively
under load and has not recurred. It is recorded here so a future occurrence is
treated as a recurrence with history rather than as a new defect.
