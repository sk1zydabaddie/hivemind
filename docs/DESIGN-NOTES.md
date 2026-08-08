# Design notes

Durable notes about behaviour that is deliberate, and about known conditions that
should not be re-diagnosed from scratch when they recur.

## JSONL trails: what is guaranteed, and what PIPE_BUF has to do with it (nothing)

### The invariant

> A trail is the durable record something else derives a guarantee from. A
> partial write must never be observable — a reader sees all of a record or
> none of it — and a damaged trail must be **recoverable rather than terminal**.

This covers `.hivemind/log/events.jsonl` and
`.hivemind/log/tasks/<id>.output.jsonl`. Both go through `src/jsonl-trail.ts`.

### Prevention

Appends take a cross-process lock (`withPathLock`, the same `link()`-based
exclusion the lease store uses, reaped by PID liveness rather than a timeout).
The line is written with **one** `write()` on an `O_APPEND` handle, the byte
count is checked so a short write is reported instead of silently retried into
a torn line, and the handle is `fsync`ed before the lock is released.

The in-process promise queue in `events.ts` is kept, but it is not a
correctness mechanism — the daemon, the CLI and the MCP server are separate
processes. It only stops one process queueing against its own file lock.

### PIPE_BUF is the wrong threshold, and the measured one is much higher

An audit finding described events as exceeding `PIPE_BUF` (4096) and therefore
being at risk. **That reasoning does not apply.** `PIPE_BUF` governs pipes and
FIFOs. For a regular file, a single `write()` is serialised by the Linux inode
lock and by Windows `FILE_APPEND_DATA`.

The real hazard is Node chunking a large buffer into several `write()` calls
that another process can land between. Measured on Windows/NTFS, 12 processes
× 20 appends through the **pre-fix** `appendFile` path:

| bytes per line | result |
|---|---|
| 131,072 | clean |
| 262,144 | clean |
| 524,288 | **tore** — 128 of 240 lines unparseable |
| 2,097,152 | **tore** — 115 of 144 unparseable |

So the threshold is between 256KB and 512KB, not 4KB.

**Nothing the system writes today reaches it.** Events are capped near 40,000
bytes (`plan.ts` and `human-guidance.ts` both cap their text at 20,000
characters), and a task-output record is one pipe read, bounded by the stream
high-water mark. The largest line in the repository's captured evidence is
23,408 bytes.

That is why the lock is worth having anyway: without it, correctness depends on
an undocumented buffer-chunking threshold staying above an input cap nobody
checks against it. The regression test in `test/events.test.ts` therefore uses
a 600,000-byte payload deliberately — a test that passes both with and against
the fix proves nothing, and a realistic payload would.

### Recovery

The severe half is not the tear, it is that a damaged trail was **terminal**.
`readEvents` refused on any malformed line, 69 call sites across 15 modules
depend on it, and `event-bus.ts` calls it on every SSE connect — so one bad
line made the durable record unreadable, the daemon stream dead, and there was
no repair, truncate or salvage path. The system bricked fail-closed.

- `readEvents` / `readTaskOutput` still **never skip a record** — a skipped
  event is a lost guarantee. They now return a `TrailDamage` alongside the
  reason: file, line, byte offset, kind, how many records are intact, whether
  it is repairable, and the command to run.
- A **trailing** incomplete line is the only thing repaired automatically, and
  only by an explicit `hivemind events repair`. It is provably an interrupted
  append — `readTrail` refuses a file not ending in a newline, so no reader can
  ever have observed it, and nothing durably committed is lost.
- Damage **anywhere else** is refused. Its bytes may belong to two interleaved
  records, so discarding it could discard a record that really happened.
- Repair copies the whole trail to `<name>.damaged-<timestamp>` **before**
  touching it, takes the append lock, and re-checks under that lock — a
  "partial" line that the racing writer has since completed is left alone.
- The event trail records its own repair as `trail.repaired`, because a repair
  that leaves no trace makes the trail unable to explain its own gap. A task
  output stream does **not**: it is a record of what a provider printed, and
  putting a Hivemind sentence into a worker's stdout would be a lie about the
  provider.

### Reading races an append; that is normal and not damage

A reader that catches a live append sees a trailing partial line, and so does a
reader looking at crash residue. They are indistinguishable in one glance, so
`readTrail` re-reads a trailing partial a few times before calling it damage.
A live append resolves in milliseconds; crash residue does not.

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
