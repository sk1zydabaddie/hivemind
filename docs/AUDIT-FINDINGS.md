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
