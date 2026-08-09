# Design notes

Durable notes about behaviour that is deliberate, and about known conditions that
should not be re-diagnosed from scratch when they recur.

## Control flow reads codes, never prose

### The invariant

> Control flow must never depend on the text of a message. A reason is for
> humans; a code is for code. **Rewording an error must be a copy change, never
> a behaviour change.**

### What this was

Twenty-eight sites resolved control flow by pattern-matching human-readable
error strings. The dangerous subset **fail open** — they proceed when the
message matches, so a reworded sentence silently disables a floor rather than
degrading a message.

`src/failure-code.ts` holds the codes. A producer that a caller needs to
*distinguish* sets one; producers whose failures are only ever read by a person
do not need one. `hasFailureCode` is the only way to ask, and it fails closed
by construction: no code and a different code are both no-match, so a caller
cannot re-invent the fail-open by treating absence as a wildcard.

A code is part of the contract between two modules. Changing one should be as
visible as changing a signature; changing a reason should be invisible.

### Three copies of a fail-open that could never fire

`lease.ts`, `run.ts` and `integrate.ts` each carried
`!reason.includes("tentative plan not found")` to skip the
dependency-integrated check — keyed on wording produced in `plan.ts`, with
nothing connecting them to it.

They were **dead**. `requireTaskDependenciesIntegrated` already handles a
planless project by falling through to manual-task authorization, and it
consumes that reason internally rather than propagating it. Verified by
instrumenting the callee to throw if it ever returned that reason and running
the whole suite: **zero hits across 605 tests**. Removing them is also the
fail-closed direction, so it is safe even if some uncovered path could reach
them.

The live consumers of that distinction were inside `plan.ts` itself and in
`workspace-inspection.ts`, asking the direct producer. Those became code
checks.

### The test that proves the coupling is gone

Producing a code is easy to assert and proves little. The load-bearing test
**rewords the producer's sentence and asserts every consumer branches the same
way**. It copies the compiled tree to a temp directory first — the runner runs
files in parallel, so mutating shared modules even briefly could hand a sibling
test a half-rewritten module — rewords the copy, re-imports, and checks the
decisions are identical while the sentences differ.

Proven to bite: replacing one code check with the old `reason.includes(...)`
makes it fail. That is the regression that would have caught every instance of
this class.

### The errno that was rendered and re-parsed

`task-control.ts` decided whether worktree cleanup was retryable — on the path
that releases a lease — by regexing `EBUSY|EPERM|resource busy|...` out of a
**rendered sentence**. The typed errno existed upstream: `stat` and `chmod`
threw a real Node error with a real `code`, that throw escaped
`removeTaskWorktree` entirely, and the caller flattened it with
`error.message` before matching the result.

The errno is now read while it is still a value. `restoreTrackedFileWrites`
catches its own throws and returns `worktree_busy`; the caller's catch does the
same for anything that still escapes. `isBusyErrno` reads `error.code` and
explicitly does **not** look at the message, so an error whose text merely
mentions EPERM is not evidence.

### git's stderr, and what "fail closed" means at each site

`src/git-stderr.ts` is the only place another program's prose is read. It is
named for what it is — untrusted classification — and each caller states its
closed direction concretely, because "fail closed" is meaningless in the
abstract:

- **Cleanup retry.** Unrecognised means *do not retry*: the removal is reported
  failed, cleanup does not complete, and the lease stays held with the debris
  present. Nothing is reclaimed on a guess. Retrying on an unrecognised message
  would be the open direction — it spends the retry budget and can report
  success on a cleanup that never happened.
- **Branch deletion.** Unrecognised means the failure is *real* and propagates.
  Only a branch git positively reports as absent counts as already-deleted.

Callers must read `false` as "not known to be transient", never as "known to be
permanent". The two differ, and only the first is safe to act on by giving up.

### Adoption says which check failed, not which regex matched

`reason_code` drives what a person is told about a failed write to their own
branch, and it was derived by regexing the reason — so rewording upstream
silently turned a specific diagnosis into "unknown". The idea was right and the
source was wrong: each of the three checks now emits its own code, and the
mapping reads it. "unknown" now means a check genuinely did not classify
itself.

### A scheduling decision that rested on a sentence about tokens

`isSessionReservationRefusal` matched
`/token budget exceeded: session .+another \d+-token call would exceed ceiling/`
to decide whether a **whole wave stops** for budget or **one lane** is treated
as a failure. `budget_exceeded: true` already existed but is set for both
run-ceiling and session-ceiling refusals, so it could not make the
distinction — which is exactly why the regex was there.

The session-ceiling refusal now carries `session_reservation_refused`, threaded
through the reservation result, the adapter failure, and onto the durable
`task.paused` event as `reroute_code`. Putting it on the event matters: the
scheduler reads the lane outcome back from the trail, not from a return value,
so a code that stopped at the function boundary would not have survived the
trip.

## Durable formats: version, upcast at read, never rewrite

### The invariant

> Upgrading Hivemind must not lose in-flight work, and a durable format gaining
> a field must not make existing records unreadable — **and migration must not
> change the bytes of any record another record's hash is bound to.**
>
> Closed-world validation stays. Rejecting unknown fields is a real floor
> against a worker smuggling data through a contract, so the answer is
> versioning plus migration, never loosening validation.

### The pattern this belongs to

A new required field making pre-upgrade state unusable has now happened three
times. It is not a coincidence, it is the shape of the system: every durable
format validates closed-world in both directions, so an older record fails on a
newer build *and* a newer record fails on an older one.

Worth knowing before "just add a field" again: **21 modules already declare
`version: 1` and hard-fail on `version !== 1`, and no format in this repository
is ever version 2.** The convention is present and inert. A version that can
only be 1 is worse than none — it looks like migration support while
guaranteeing a hard failure the moment anyone bumps it. Task contracts, which
gate the most, had no version field at all.

### Why migration is read-time and never rewrites

Not a preference — `verificationInputsStillMatch` re-hashes every contract file
and `adoption.ts` gates on it. Rewriting a contract to migrate it would report
`verified-then-stale: contract hash changed` on work that had already been
verified. The user's reward for upgrading would be losing exactly the work this
invariant protects.

So: bytes on disk are never touched, the upcast happens in memory on every
read, and old records stay readable by old builds. There is no migration step
to run, no partial-migration state, and nothing to roll back. The cost is that
upcast code is carried indefinitely.

Two rules keep an upcast trustworthy:

- **Pure and total.** No I/O, no clock, no config. Two reads of the same bytes
  must produce the same value, or a hash-bound artifact could disagree with
  itself.
- **Refuse rather than invent.** Where no safe default exists, fail and name
  the field. `routing_task_type` gets `other` — the enum's own unclassified
  member, not an invented value, and safe in both directions that consume it: a
  learned-routing scorecard miss falls back to the deterministic comparison,
  and a value-quality policy that does not name it *denies* admission.

### Forward compatibility: refuse, but legibly

A record from a **newer** build is refused, and that is correct rather than
merely cautious: a v2 contract could carry a field that *narrows* scope, and an
older build ignoring it would grant more than intended.

Consequences:

- **Single integer versions, no minor.** "Older readers may ignore fields they
  do not know" is exactly the hole closed-world validation exists to close — an
  unknown field rides in under a minor bump. Every known version gets its own
  exact field set.
- **Version is parsed before schema validation.** This is structural, not
  cosmetic. The field-set check runs last, so a v2 contract used to fail with
  `unsupported contract field: <whatever was added>`, which reads as corruption
  and sends a person hunting damage that is not there. It now says which format
  wrote it, which this build reads, and what to do.

### The one place unknown fields are tolerated

`daemon.json` and the daemon's `/health` response, read by the Tauri shell.
`deny_unknown_fields` there meant Core adding one field would stop the shell
attaching to its own daemon — a total outage from a purely additive change,
across two binaries that routinely ship at different versions.

Safe **here specifically** because daemon.json authorizes nothing: it is a
rendezvous record saying where the daemon is and which build it is. `version`
is still checked and `build_id` is still compared against the expected shell
build; ignoring an unknown field weakens neither. Do not copy this to a format
that grants anything.

### What is deliberately left alone

Every durable format now runs `checkFormatVersion` (`src/format-version.ts`)
**before** any shape validation, and `formatVersions` is the single reviewable
list of what is gated. Applying it was deliberately behaviour-preserving:
every one of these has always stamped its version, so absence means damage
rather than age (`whenAbsent: "refuse"`) and existing records get exactly the
outcome they already got. What changed is that a refusal is legible and there
is now one obvious place to put an upcast.

Only task contracts have a real pre-versioning era, and only they carry an
upcast today.

| Format | Treatment | Why |
| --- | --- | --- |
| Task contracts | Versioned + read-time upcast | Gates seven subsystems; a pre-upgrade contract was permanently unusable |
| config, spec, tentative plans, replan, ideation, write-intent | Gated | Work-bearing |
| memory canon, routing / value-quality / verification policies | Gated | Human-promoted, permanent |
| verification-set manifests, quality draft + selection manifests | Gated | Immutable evidence; hash rules below |
| capability corpus manifest / report / evidence, routing observations | Gated | Evidence |
| quota ledger reservations, manager sessions, `daemon.json` | Gated | Durable state |
| `daemon.json` + `/health` **in the Rust shell** | Tolerate unknown fields | Cross-language, cross-version, authorizes nothing |
| Characterization candidate manifests | **Nothing** — no reader exists | Written by `characterization.ts` and never read back by Core. Gating a format nobody parses is ceremony. If a reader is ever added, gate it then |
| `memory.proposed` and `quality.admission_decided` payloads | **Not gated** | These are event *payloads* validated by boolean predicates, not file loaders. An event payload version bump is a question about the event trail's own format, which is a different mechanism; restructuring the predicates to carry a reason would be a real change, not a move |
| `isCapabilityCorpusDescription`, `readMeteredUsageArtifact` | **Not gated** | Both return `boolean` / `null` with no channel for a reason, so a gate could refuse but not explain — the whole point. Changing their signatures is a real refactor with callers to follow, not part of this move. Both already fail in the safe direction: an unrecognised corpus description is invalid, and unreadable usage is simply not credited |
| lease-lock record, `project-temp/owner.json` | **Nothing, deliberately** | Ephemeral. An unparseable lock is already reaped as stale; an owner mismatch already means "not mine", which is the correct fail-closed answer. Versioning adds ceremony and no safety |

### Immutable evidence: the hash belongs to the file

A verification manifest is written once, hashed, and bound to by adoption, so
it can never be rewritten — read-time upcasting is the only migration
available to it, and that stays sound only while:

> **The hash is a property of the FILE, never of the parsed object.**

`loadVerificationSet` takes it over the exact bytes read, before parse or
upcast. Anything that re-derives it from a parsed manifest is a bug: an upcast
shape would not round-trip to the same bytes, so adoption's binding would break
on a record nobody touched. `test/format-version.test.ts` pins this with a
manifest written at four-space indent — semantically identical to its
re-serialization, byte-for-byte different — and asserts the loaded hash matches
the file and *not* the re-serialization.

## Worker termination proves a TREE, not a process

### The invariant

> Proving a worker dead means proving its entire process **tree** is dead, on
> every platform. The same code path that releases a lease and resets a
> worktree depends on that proof, and a tree that outlives its parent is
> exactly the condition the lease was protecting against. Anything short of
> proof is `unknown`, which per PL-1 is treated as alive — nothing is
> reclaimed.

### What was wrong

Windows ran `taskkill /pid N /t /f` and killed the tree. POSIX sent SIGTERM
then SIGKILL to a **single pid**, and `adapter.ts` spawned with no `detached`
and no process group — so there was no group to signal and the agent CLI's own
subprocesses (a shell, a node, a git) survived. `terminateProcessTreeAndVerify`
then confirmed the *named* pid absent, returned `"dead"`, and the caller reset
the worktree and released the lease while orphaned grandchildren were still
writing into it.

### The fix

- The adapter spawns with `detached` on POSIX, so `setsid()` makes the worker a
  process-group leader and the group id is the pid.
- Termination signals `kill(-pgid, …)`, which reaches every process in the
  group.
- Verification asks `getProcessGroupLiveness`, built on `kill(-pgid, 0)`:
  `ESRCH` → dead (the only thing that proves a tree gone), `EPERM` → alive
  (present but not ours), otherwise unknown. Deliberately **not** `/proc`,
  because macOS and the BSDs have none and are port targets.
- One entry point. The platform branch lives inside it, the way PL-1 keeps
  liveness in one place, so the two cannot drift into a pair that disagrees
  about what "dead" means. Windows is unchanged.

### What `detached: true` also changes

Stated because it was relied on, not assumed away:

- **stdio is unaffected.** `detached` only alters stdio when paired with
  `stdio: "ignore"`; with the default pipes, stdout/stderr/stdin behave exactly
  as before — which the streaming and prompt paths depend on.
- **The child no longer receives signals sent to our group**, so an interactive
  Ctrl-C no longer reaches it. That is the point: termination must go through
  the path that proves what it killed, and a stray Ctrl-C never did.
- The parent is not held open, because `unref()` is never called and the child
  is already awaited.
- **Not set on Windows**, where `detached` means a new console window.

### A worker with no recorded group is never reported dead

`process_group_id` is written into `task.worker_process_started`. It is absent
for any worker started before this existed, and null on Windows. On POSIX a
missing group means the tree **cannot** be proven dead, so the stop refuses —
even when the root pid is definitively absent, because that says nothing about
its orphans.

The cost is real and deliberate: a POSIX worker already in flight across this
upgrade can never be proven dead, so its stop will not reclaim. That is the
fail-closed answer, and it is the correct one.

### Verification status

| Platform | Status |
| --- | --- |
| Windows | **Verified.** Full Core suite; the two POSIX-only tests skip. |
| Linux | **Verified on a real kernel.** WSL2 Ubuntu-22.04, kernel 6.6.87.2. |
| macOS / BSD | **UNVERIFIED-ON-MACOS.** |

The Linux run is not a simulation — WSL2 is a real kernel, so `setsid`,
`kill(-pgid)` and signal delivery are native. The load-bearing test spawns an
actual worker that forks three grandchildren which ignore SIGTERM, terminates
it, and asserts every grandchild is gone. Reverted to the single-pid kill it
fails on Linux with `grandchild 390 outlived a termination that reported
success` — the defect reproduced, then closed.

**macOS is not covered.** It is POSIX and a port target, and it differs (no
`/proc`). The implementation uses only `kill(-pgid, 0)`, which is portable, so
there is reason to expect it to hold — but expectation is not verification, and
this table should not be read as though it were. Anyone porting to macOS should
run `test/process-control.test.ts` there first; it is self-contained and needs
no fixtures.

### How to run the suite on Linux from a Windows box

`wsl -d Ubuntu-22.04`, a user-local Node under `~/.local/node` (the Windows
`node.exe` on the PATH is not a Linux binary), and the Windows-built `dist/`
read straight from `/mnt/d`. No second `npm install` — the pure-JS dependencies
resolve from the existing `node_modules`, and the native modules that were
built for Windows are not reached by these tests.

Note that a full-suite run this way is very slow: the git-heavy fixtures cross
the 9p mount, and it managed ~130 tests in 25 minutes. Run targeted files, not
the whole suite.

### Six tests already fail on Linux, and none of them are about termination

Recorded as finding **F-1** in [AUDIT-FINDINGS.md](AUDIT-FINDINGS.md), because
it changes the cross-platform plan rather than being a bug list. Summary here;
severity and consequences there.

Running the suite on Linux for the first time surfaced pre-existing platform
gaps. Confirmed identical with and without the termination change — same six,
same names — so they are **not** regressions from it:

| Test | Cause |
| --- | --- |
| `capability-corpus` × 4 | The fixture installs its fake agent as `codex.cmd`, a Windows batch file. On Linux it never executes, so `calls.jsonl` is never written. |
| `resolveChangeset classifies mode-only changes as chmod` | File-mode semantics differ; the fixture encodes the Windows outcome. |
| `CLI analyze prints escalate JSON…` | Not yet diagnosed. |

These are Windows-only fixtures rather than product defects, but they mean the
suite cannot currently gate a POSIX port. Worth fixing before the port, and
worth knowing that "green" today means "green on Windows".

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

**So the lock is defence in depth, not a fix for an observed failure.** No torn
write was ever reproduced at the sizes this system writes, and none is known to
have happened. What the lock buys is that correctness stops depending on an
undocumented buffer-chunking threshold staying above an input cap nobody checks
against it — today those two numbers are 512KB and 40KB, and nothing enforces
the gap.

The regression test in `test/events.test.ts` therefore uses a 600,000-byte
payload deliberately — a test that passes both with and against the fix proves
nothing, and a realistic payload would.

**Do not re-derive this from the PIPE_BUF claim.** It was relayed from an audit
and is wrong; this entry exists so the measurement is not repeated.

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
