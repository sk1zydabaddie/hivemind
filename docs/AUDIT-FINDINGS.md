# Audit findings

Findings that outlive the session that found them. A finding belongs here when
it changes a plan or a belief about the system, not merely when it is a bug —
bugs get fixed and disappear; the reason they were possible should not.

Severity is about **consequence if left alone**, and is stated separately from
**product impact today**, because the two often differ. A finding that harms no
current user can still block a plan the project has already committed to.

| ID | Finding | Severity | Product impact today | Status |
| --- | --- | --- | --- | --- |
| F-1 | The test suite cannot run on the platforms being ported to | High (blocked the cross-platform plan) | None | **Closed 2026-08-12** — `8b96387`, `62e8089` |
| F-2 | Two thirds of the worker pool could never be verified through the app | High (routing picked from profiles no user could probe) | None | **Closed 2026-08-14** — fixed in the pass that found it |
| F-3 | Hivemind committed its own machine evidence by default | High (a clone inherited another machine's verdicts) | None | **Closed 2026-08-15** — fixed in the pass that found it |
| F-4 | A crash left the project permanently unable to prove itself idle | High (both remedies were gated on the thing the crash broke) | None | **Closed 2026-08-15** — fixed in the pass that found it |
| F-5 | This file's own "only finding" guard note became a false record | Medium (misdirects orientation) | Misled the 2026-08-21 orientation pass | **Closed 2026-08-21** — fixed in the pass that found it |

> **The live open register is `docs/AUDIT-2026-08-17.md`, not this file.**
> Every finding in this file is closed; what this file keeps is the reason each
> one was possible. If a plan refers to audit findings this file does not
> contain — a §7–§22 backlog, or anything similar — that backlog does not exist
> in this repository and did not come from it. The numbered list that *does*
> exist elsewhere is the seven-item table in `CROSS-PLATFORM.md`, which is
> remaining **port** work, and the A-numbered register in `AUDIT-2026-08-17.md`,
> which is the current audit.

---

## F-1 — "Green" meant "green on Windows" — CLOSED

**Severity: was High for the port. Product impact: none, at any point.**
**Status: closed 2026-08-12. Kept because the reason it was possible outlived
the fix.**

### What it was

The Core suite had only ever been run on Windows. Run on Linux for the first
time, it failed — and every failure was a fixture encoding a Windows
assumption, not a product defect. That is what made it a finding rather than a
bug list: **the suite could not gate a POSIX port, because it could not pass on
a POSIX target even when the product was correct there.**

### How it closed

`8b96387` and `62e8089`. Nine failures on a native Linux checkout, four root
causes, each diagnosed rather than skipped:

| Cause | Tests | Whose fault |
| --- | --- | --- |
| Mode-only changes staged with `git update-index --chmod=+x`, then captured with `git diff HEAD` — which compares against the **working tree**, so a staged-only mode bit is invisible wherever `core.fileMode` is true | 4 | The tests were wrong about Linux. NTFS has no exec bit, so the fixture looked correct for years |
| The fake agent was a `codex.cmd` batch shim, never executable on Linux | 4 | The fixture. One helper now writes a shim the platform can start, and replaces the whole leading command because the `cmd.exe` prefix is itself platform-specific |
| A synthetic worker event with no process group | 1 | **The test was right and revealed a real assumption.** A POSIX worker is spawned detached and records `process_group_id` so `kill(-pgid)` can prove the tree dead; the fixture wrote a Windows-shaped event no POSIX worker would produce |

### Current state

Both platforms run the same suite, and the counts are reported separately
because they legitimately differ:

| Platform | Filesystem | Result |
| --- | --- | --- |
| Windows | NTFS | **741 passed, 0 failed, 2 skipped** |
| Linux | native ext4 | **743 passed, 0 failed, 0 skipped** |

The two skips are genuine platform skips, not hidden failures.

### The part worth keeping

**The first Linux run measured the wrong thing, and looked like a result.** It
ran from `/mnt/d`, where drvfs makes git see `core.fileMode=false` exactly as on
Windows — which hid the four mode failures entirely, and is why that attempt
reported *six* where native ext4 reports *nine*.

> **A platform result must come off that platform's native filesystem. A
> cross-mount run is not evidence in either direction.**

That rule has since earned a second instance in the opposite direction: a 9p
mount later *manufactured* three daemon timeouts and then hung outright. One
mount hides failures, the other invents them, and both arrive looking like
results. Written up in full in `desktop/DESIGN-NOTES.md`.

---

## F-2 — Two thirds of the worker pool could never be verified through the app

**Found:** 2026-08-14, while restructuring provider/model/role selection.
**Status:** fixed in the same pass.

### What was true

Tier routing is not one decision, it is a *search*. `planner` and `manager` are
resolved by name — `plan.prepare` asks for "planner" — but `worker` is never
asked for by name. `routeTaskProvider` reads **every** `*.profile.json` in
`.hivemind/adapters` and picks among the ones admitting the worker role: tier
floor first, then task-type preference, then quota pressure.

`initProject` writes a three-member pool so that search has somewhere to land:

| File | Model | Tier |
| --- | --- | --- |
| `worker.profile.json` | `gpt-5.6-sol` | strong |
| `worker-standard.profile.json` | `gpt-5.6-terra` | standard |
| `worker-cheap.profile.json` | `gpt-5.6-luna` | cheap |

That part works, and it is why Medium work routes to standard and Low to cheap
on a project nobody has configured.

**`adapter.connect` wrote `${role}.profile.json`.** For a worker that is
`worker.profile.json` — always, whichever model was chosen. So:

- connecting a worker could only ever verify **one** of the three;
- the other two remained **declarations nobody had probed**, and routing went on
  selecting them for every Medium and Low task;
- connecting a *second* worker overwrote the first rather than joining the pool,
  so a verified pool could never have more than one member.

`config.inspect` compounded it: it enumerated the three role *names* and read
`<role>.profile.json`, so it reported one worker row. Two thirds of what routing
would actually pick from was invisible to every surface that reports what is
connected — including the setup screen's own "all roles connected" check.

### Why it is a finding and not a UI gap

Nothing was broken. Every test passed, routing routed, and the tier floor did
exactly what it was built to do. What could not happen was a person reaching
the feature: **every measurement behind tier routing came from profiles written
by hand**, with names like `codex-luna.profile.json` that no amount of clicking
could produce. This repository's own `.hivemind/adapters` still holds them.

> **A feature reachable only by editing files is not a feature the product has.
> It is a feature the product's authors have.**

The corpus evidence, the promoted routing policy `M-37f4a2a0`, the 1.57×
concurrency result — all of it exercised a pool that a user could not assemble.
That does not make the measurements wrong. It makes them measurements of a
configuration no user had.

### The correction to the first version of this finding

The first draft said the app "could only ever produce a worker pool of one".
That was wrong, and checking it is what produced the accurate version: a pool of
three exists from `initProject`. The defect is narrower and worse — the pool is
real, routing uses it, and only one member of it could ever carry a probe.

### Fixed by

- worker profiles are named for the (provider, model) they run —
  `worker-codex-terra.profile.json` — so several coexist and each is
  independently connectable and independently verified;
- `config.inspect` enumerates profiles rather than role names, so every pool
  member is reported with its own connection record;
- connecting a worker retires an **unprobed** default pinning the same model, so
  a verified profile never sits in the pool beside an unverified duplicate of
  itself. A profile with a connection record is never removed by a side effect.

Existing `worker.profile.json` files keep working: the search reads whatever is
there, and nothing needed migrating.

---

## F-3 — Hivemind committed its own machine evidence by default

**Found:** 2026-08-15, answering a question about multi-machine use.
**Status:** fixed in the same pass.

### What was true

`initProject` never wrote a `.gitignore` rule, and `initialize_git` — the
button Hivemind offers somebody whose folder is not yet a repository — runs
`git init && git add -A && commit`. So Hivemind's own first-run path committed:

```
.hivemind/adapters/manager.profile.json
.hivemind/adapters/planner.profile.json
.hivemind/adapters/worker-cheap.profile.json
.hivemind/adapters/worker-standard.profile.json
.hivemind/adapters/worker.profile.json
.hivemind/config.json
.hivemind/log/events.jsonl
```

and, once anybody connected an agent, `*.connection.json` alongside them.

### Why that is a contract failure and not untidiness

A connection record proves capabilities were measured on ONE binary, at ONE
version, under ONE account, on ONE machine. It carried none of those facts
except the version, and **the version was never compared** —
`compareAdapterVersion` existed, was unit-tested, and was imported by nothing
but its own test.

So a clone inherited the verdict. Not only as a label: `routing-preferences.ts`
reads the record to decide whether a provider may be **deliberately aimed at a
model**, so A's recorded `verified` granted B a routing privilege on evidence
B's machine never produced.

> **That is the capability contract accepting a declaration again** — the same
> shape as a wrapper passing every check by inheriting another harness's
> evidence, except the declaration is made by somebody else's computer instead
> of by a config file.

The account-switch invalidation could not catch it either: it fires on switch,
and a record arriving by clone was never switched, so it read as valid.

### Fixed by

- `.hivemind/.gitignore`, written by `init` **before** anything machine-specific
  exists, so no window remains in which `git add -A` could capture it. An
  ALLOWLIST — `config.json` and `canon/` are shared, everything else is not —
  because the first draft was a denylist and was already missing seven of the
  fifteen directories Core writes.
- `machine: { host, platform, account_home }` on the connection record, and a
  read-time check that reports a foreign record as stale rather than valid.
  Gitignore stops it travelling; this stops the class, including the
  same-machine case.
- `compareAdapterVersion` wired into the run path, so a self-updating binary
  invalidates its own verdict.
- `sharing.inspect` / `sharing.untrack`, because an ignore rule does nothing to
  a file git already has — a repository that already committed records keeps
  sharing them until somebody runs `git rm --cached`.

### The decision inside the fix

`log/events.jsonl` is **not shared**, and that is a judgement rather than a
default. The founding rule is that the trail must rebuild state; a trail merged
from two machines rebuilds a state that never existed — two runs that never
coexisted, interleaved by commit order, with leases and reservations from both.
That is worse than no history because it looks like history. It is also
append-only and shared-write, the worst possible shape for a version-controlled
file.

The cost is real: a clone starts with no history. Captured trails under
`docs/evidence/` are unaffected, and remain how a run is shared deliberately.

---

## F-4 — A crash left the project permanently unable to prove itself idle

**Found:** 2026-08-15, by being asked to test an assertion rather than repeat it.
**Status:** fixed in the same pass.

### What was true

The idleness proof gates two acts: restarting the daemon after an update, and
installing a new build over the running one. It counted `active` reservations in
`.hivemind/resource/ledger.json` and task worktrees on disk, and returned Busy
when either was non-zero.

A daemon killed mid-call leaves its reservation `active` **forever** — nothing
settles it, because the thing that would settle it is gone. So after any crash,
`daemon_work` returned Busy on every future call, and:

- the daemon restart refused, permanently;
- the build bar offered nothing, permanently;
- there was no path back, because both remedies were gated on the thing the
  crash had broken.

Quieter than restarting into a live run, and just as final.

### How it was found, which is the part worth keeping

I reported that `process_liveness` on `daemon.json`'s pid was what stopped a
dead daemon's reservations reading as busy. That sentence was confident,
specific, and wrong: `daemon_work` did not call `process_liveness` at all.

It was not caught by review — I had written that function days earlier and
described its behaviour incorrectly while looking at it. It was caught because
the assertion was turned into a test, and the test failed on its first run:

```
a_dead_daemons_reservations_do_not_block_forever ... FAILED
  a dead daemon's leftover reservation must not block forever:
  This project still has 0 task workspace(s) and 1 call(s) in progress.
```

> **A mechanism you can name and describe correctly may not be wired.** Being
> able to say what a guard does, and why, and where — none of that is evidence
> that anything calls it.

This is the unread-field family seen from the other side. There, a field was
written and never read; here, a function existed and was never called from the
place everyone assumed it was. Both look complete from every angle except the
one that matters, and in both cases the missing thing is a call site — which is
invisible precisely because it is absent.

The practical form: **when someone describes a guarantee, the useful next
question is not "is that right?" but "what would fail if it were not?"** The
first invites agreement; the second produces a test.

### Fixed by

`daemon_work` now consults liveness, and the asymmetry decides the uncertain
cases: only a **dead** daemon releases the guard. Alive keeps it, and so does
not knowing. A project with no daemon record has nothing registered as running
it, so its leftovers are orphans.

Five tests, written against the broken behaviour first, two of which failed:

| Case | Expected |
| --- | --- |
| Live daemon, active reservation | Busy — the dangerous direction, already correct |
| Killed daemon, active reservation | Idle — **failed before the fix** |
| No daemon record, active reservation | Idle — **failed before the fix** |
| Settled reservations only | Idle |
| Unknown liveness | Not idle |

The live-daemon case spawns a real process and the crash case kills one
mid-reservation, because the whole question is what a real dead pid does.

---

## F-5 — The "only finding" guard note became the false record it was built to prevent

**Found:** 2026-08-21, by an orientation pass reading this file cold.
**Status:** fixed in the same pass.

### What was true

This file's header table listed only F-1, and directly beneath it a bold note
read *"There is no other finding in this file, and there never has been."* The
note was written to stop a future session inheriting a phantom backlog — a
§7–§22 register that had been prioritised against without ever existing.

F-2, F-3 and F-4 were then appended below that note on 2026-08-14 and
2026-08-15 without the table or the note being touched. For six days the
file's own guard asserted that most of its contents did not exist, and an
orientation brief written from it repeated the error.

### Why it is a finding and not a typo

It is the project's standing rule — *recording a rule prevents nothing; only a
mechanism does* — applied to a record rather than a rule. The note was a
hand-maintained summary of the file's own contents: a count typed by hand, in
prose, which nothing forced anyone to update when the body grew. That is the
same failure as the stale count table at the head of `STATE.md`, found in the
same pass: **any place that must agree with another place will eventually
disagree with it.**

The sharper version, and the reason it earns an entry: the note was itself a
guard against stale records. A guard that shares the failure mode of the thing
it guards adds a place to be wrong without adding a place to be right.

### Fixed by

- the table lists every finding, and the note no longer asserts a count of
  this file's contents — it names where the live register is
  (`docs/AUDIT-2026-08-17.md`) and disclaims only backlogs this file *never*
  contained, which cannot go stale by appending;
- the general correction, applied here and to `STATE.md` §1 in the same pass:
  **a record must not carry a hand-maintained summary of itself.** Anything
  that has to agree with the body belongs in the body, once.
