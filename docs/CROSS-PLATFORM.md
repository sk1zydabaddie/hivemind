# Cross-platform: the prerequisite, done

"Green" used to mean green on Windows. It now means green on both.

| Platform | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- |
| Windows 11 (native) | 667 | 665 | **0** | 2 |
| Linux 6.6 (WSL2, Ubuntu 22.04, ext4) | 667 | 667 | **0** | 0 |

Both run green after every change in this pass; Linux twice. The two skips on
Windows are platform-guarded tests that Linux runs, which is why its pass count
is higher — the suite is the same 667 either way. Desktop: 83 pass.

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

## The port, done and measured

Everything below was run, not reasoned about.

### A Linux first run works, and it never touches a committed profile

`docs/evidence/e2e-2026-08-11-linux-firstrun`. A fresh git repository on native
ext4 reached a shipped commit whose tests pass: `project.init`, three probed
`adapter.connect` calls, prompt, review, approve, ship. **289,744 tokens.**

The profile `adapter.connect` wrote begins `["codex", "exec", …]` — no
`cmd.exe`. That is the answer to the open question: the platform-correct
invocation is generated at connect time and verified by the probe, so nothing in
the repository needs to be right about the platform.

Two things it found. **The spec drafter returned invalid JSON once and there is
no retry** — the same prompt succeeded immediately after, so it is variance from
the cheap model rather than a Linux fault, but a first-time user meets a hard
refusal with no hint that pressing again is the right move. Worth a retry-once
in Core. And one harness bug: `$(pwd)` expanded in the outer Windows shell, so
the walk was handed `"AI"` as its project path and `project.init` correctly
refused.

### The committed profiles are gone

They were Windows-only, and they were also the thing `project.init` already
refuses to write: a profile on disk that no probe has checked. Core's
`profileSpecs` still owns the model pins, tiers and cost ranks; only the argv
differs per platform, and it is now generated by `writeLocalAdapterProfiles`
(`npm run adapters:local`). The tier-ladder test validates the generator's
output instead of a committed artefact and asserts exactly the same ladder.

### Temp namespacing under a shared /tmp

Windows gives every user a private temp; Linux shares `/tmp`. The dangerous
direction is a **live** owner's directory being reclaimed, and the case that
could do it is cross-user: `kill(pid, 0)` against another user's process fails
with **EPERM**, and a probe reading that as "gone" would delete a directory out
from under a running instance.

It cannot. `getProcessLiveness` returns `dead` **only** on ESRCH; EPERM and
every unrecognised errno become `unknown`, and the reconciler removes only on
`dead`. Two new tests prove the link the existing ones assumed: the errno
mapping itself, and a shared temp root where an EPERM-owned directory is
retained while a genuinely absent one is still reclaimed — so the test cannot
pass by doing nothing. Namespaces are already disjoint per project
(`sha256(canonical root)`), which the suite covered before.

### Linux packaging

`npm run tauri:build:linux` produces both:

```
Hivemind AI_0.0.0_amd64.deb
Hivemind AI_0.0.0_amd64.AppImage
```

The `.deb` installs cleanly, puts `hivemind_desktop` on `PATH` and registers
`Hivemind AI.desktop`, so it launches from a desktop environment with no
terminal — the same bar as the NSIS installer.

**AppImage failed the first time** with *"couldn't find a square icon"*, and the
cause was that `tauri.conf.json` declared **no `bundle.icon` at all**. Windows
fell back to a default and nobody noticed; the AppImage bundler had nothing to
find. The icon set is declared now and `targets` is `"all"` rather than
`["nsis"]`, with each platform's npm script naming its own bundles — so the
config is no longer Windows-shaped.

### The WebKitGTK gap — GUI walks are Windows-only

Tested rather than assumed. The Linux app **does** have the hook: launching the
packaged binary with `WEBKIT_INSPECTOR_SERVER=127.0.0.1:9445` opens a listening
inspector port. But it speaks the **WebKit Inspector protocol**, not CDP —
`curl http://127.0.0.1:9445/json/list` returns nothing, and that endpoint is
exactly what Playwright's `connectOverCDP` needs to discover a target. So the
GUI walk built for WebView2 cannot attach, and driving WebKitGTK would need a
bespoke client for a different protocol.

**What that leaves unverified on Linux:** the click-level seam — control labels,
enabled/disabled states, and the wiring between a control and the action behind
it — plus anything engine-specific in rendering, focus or scrolling. **What it
does not leave unverified:** the logic behind those controls, which the Linux
first-run walk exercises end to end through the same typed actions the GUI
dispatches. The React bundle is byte-identical on both platforms; only the
engine rendering it differs.

### Still not verifiable from here

**macOS remains UNVERIFIED-ON-MACOS.** It takes the POSIX `detached` /
`kill(-pgid)` path and the `["codex", …]` shell branch that Linux now exercises,
which makes it *likely* fine — an inference, not a result. `.app`/`.dmg`
bundling, code signing and notarisation are untouched and untestable without
hardware.
