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

> **There is no other finding in this file, and there never has been.** If a
> plan refers to audit findings numbered above F-1 — a §7–§22 backlog, or
> anything similar — that backlog does not exist in this repository and did not
> come from it. Recorded here so a future session cannot inherit it as real
> work. The numbered list that *does* exist is the seven-item table in
> `CROSS-PLATFORM.md`, which is remaining **port** work, not audit findings.

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
