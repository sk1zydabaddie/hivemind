# Cross-platform: the prerequisite, done

"Green" used to mean green on Windows. It now means green on both.

| Platform | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- |
| Windows 11 (native) | 665 | 663 | **0** | 2 |
| Linux 6.6 (WSL2, Ubuntu 22.04, ext4) | 665 | 665 | **0** | 0 |

Linux was run twice green after the last fix; Windows once. The two skips on
Windows are platform-guarded tests that Linux runs, which is why its pass count
is higher — the suite is the same 665 either way.

**The Linux filesystem matters.** The first Linux attempt ran from `/mnt/d`, a
Windows drive mounted through drvfs, where git sees `core.fileMode = false`
exactly as it does on Windows. That hides the mode-semantics failures entirely
and is why the earlier run reported six failures where a native ext4 checkout
reports nine. Anything claiming to be a Linux result has to come off a Linux
filesystem.

## The nine failures, each diagnosed

The instruction was to diagnose rather than skip, and to say for each whether
the test was wrong about Linux or right and revealing a real assumption. Four
distinct root causes.

### 1. Mode-only changes were built in a Windows-only way — 4 tests

`analyze`, `changeset`, `gate`, `gate-corpus`.

Each staged an executable bit with `git update-index --chmod=+x` and then
captured `git diff HEAD`. **`git diff HEAD` compares against the WORKING TREE**,
so a staged-only mode bit is invisible wherever `core.fileMode` is true — which
is every real POSIX checkout. On Windows, NTFS has no executable bit, git
ignores worktree modes, and the index-only change shows up; the fixture has
looked correct for years for that reason alone.

**Verdict: the tests were wrong about Linux.** The product's chmod
classification was never in question — it parses a diff, and the diff simply had
no mode change in it. Fixed by changing the mode on disk as well as in the
index, which produces the same patch on both platforms.

### 2. The fake coding agent was a Windows batch shim — 4 tests

All four capability-corpus tests died on a missing `calls.jsonl`, never reaching
what they were testing. The fixture wrote `codex.cmd` and left the profile's
`cmd.exe /d /s /c` prefix in place — unrunnable on Linux.

**Verdict: the fixture was wrong about Linux.** Fixed with one helper that
writes the shim the platform can start (a `.cmd` behind `cmd.exe` on Windows,
because Windows cannot spawn a `.cmd` directly; a `#!/bin/sh` script with mode
755 elsewhere) and replaces the whole leading command rather than the binary
name — the interpreter prefix is itself platform-specific.

### 3. A synthetic worker event with no process group — 1 test

Run cancellation refused with *"worker pid … has no recorded process group, so
its tree cannot be proven dead even though the root process is absent; lease
remains held."*

**Verdict: the test was right, and it revealed a real assumption.** A real POSIX
worker is spawned `detached`, becomes a group leader, and records
`process_group_id`; `terminatePosixTree` then proves the tree gone with
`kill(-pgid)` and refuses to claim success without it. Windows records no group
because `taskkill /T` is the tree primitive there. The fixture wrote a
**Windows-shaped event** that no POSIX worker would ever produce, so Core
correctly refused — the stricter Linux path is the safer one. Fixed by recording
the group the way `adapter.ts` does.

### 4. Two timing assumptions that only a slower platform exposes — 2 tests

- **`runTask captures diff … when the adapter times out`** gave the fake agent a
  **50 ms** timeout and expected it to boot Node, import `fs/promises` and
  append a file first. That window is inside Node's own startup cost; on a
  slower filesystem it lost the race and captured zero changed files. The agent
  hangs forever afterwards, so the timeout still fires — the window only ever
  needed to be long enough for the write. Now 2,000 ms.
  **Verdict: the test was right, its timing was not.**

- **`concurrent deterministic scheduling … preserves serial per-task trails`**
  compared a task's whole event list at cap 2 against cap 1. It passed 5/5 in
  isolation and failed 2/2 under full-suite load, naming a *different* event
  each time — the signature of one extra element shifting everything after it.
  The extra element was `cache.read`: the same task doing the same work reads a
  warm cache a different number of times depending on what else has run.
  **Verdict: the test was right about the invariant and over-specified in how it
  checked it.** Its own comment says the claim is *causal, not temporal*, so the
  comparison now excludes the cache lookup, which is an observation rather than
  a step. The causal sequence is still compared in full.

## What is left in the port, and what can be verified from here

Reported before doing it, as asked.

### Verifiable from this machine

**WSL2 gives a real Linux kernel** (6.6, ext4, 12 cores), so everything below
that is not GUI or packaging can be proven here.

| Area | State | Notes |
| --- | --- | --- |
| Process groups / tree kill | **Done** | `detached` + `kill(-pgid)` with proof of an empty group; the §5 work. Exercised by the suite on both. |
| Test suite | **Done** | 665/665 Linux, 663/665 + 2 skips Windows. |
| Path separators | **Needs an audit, not a rewrite** | Core uses `path.join`/`path.resolve` throughout, and the gate matches globs on repo-relative paths. The risk is any place comparing a stored path string to a live one — the trail records POSIX-style relative paths, so a Windows-produced trail replayed on Linux is the case to test. Not yet tested. |
| MAX_PATH | **Windows-only concern** | Worktrees under `.hivemind/worktrees/<task>` plus a deep repo can exceed 260 chars. Linux has no equivalent limit; the fix, if needed, is Windows long-path support rather than a port. |
| Temp-directory namespacing | **Likely fine, unproven** | Everything uses `mkdtemp(path.join(tmpdir(), …))`, which is `/tmp` on Linux and `%TEMP%` on Windows. What is untested is two Hivemind instances on one Linux host sharing `/tmp` — Windows gives each user a private temp, Linux does not. |
| Shell invocation | **Real work** | The adapter catalogue builds `["cmd.exe","/d","/s","/c","codex.cmd", …]` on Windows and `["codex", …]` elsewhere — already branched in `agent-catalogue.ts`. The checked-in `.hivemind/adapters/*.profile.json` are **Windows-only** and would have to be rewritten or regenerated by `adapter.connect` on a Linux install. `adapter.connect` does the right thing already; the checked-in files do not. |
| PL-1 liveness port | **Partly done** | `getProcessLiveness` / `getProcessGroupLiveness` are implemented for both, and the cancellation path is now exercised on Linux. Untested: liveness of a process owned by another user, and PID reuse. |

### Not verifiable from here

- **macOS is UNVERIFIED-ON-MACOS and stays that way without hardware.** It is
  POSIX, so it takes the `detached`/`kill(-pgid)` path and the shell branch that
  Linux exercises, and it is *likely* fine. That is an inference, not a result,
  and it should be labelled that way anywhere it appears. `spawn` semantics,
  code signing and the app bundle are all genuinely different.
- **Packaging.** The desktop ships an NSIS installer, which is Windows-only.
  macOS needs a signed `.app`/`.dmg` and Linux an AppImage or `.deb`; Tauri can
  produce all three but none has been built or run. This is the largest
  untouched piece and none of it is testable from here beyond the Linux bundle.
- **The GUI on Linux.** Tauri uses WebKitGTK there rather than WebView2, so the
  WebView2 debugger the GUI walk drives does not exist. A Linux GUI walk needs a
  different driver.

### The honest summary

Core is portable and now proven so on two kernels. **The port that remains is
mostly packaging and the desktop shell, not the engine** — plus one concrete
piece of debt: the checked-in adapter profiles are Windows-only, and a Linux
first run depends on `adapter.connect` writing fresh ones rather than on
anything in the repository.
