# Cross-platform: the prerequisite, done

"Green" used to mean green on Windows. It now means green on both.

| Platform | Tests | Pass | Fail | Skipped | Desktop |
| --- | --- | --- | --- | --- | --- |
| Windows 11 (native, NTFS) | 687 | 685 | **0** | 2 | 83 pass |
| Linux 6.6 (WSL2, Ubuntu 22.04, ext4) | 687 | 687 | **0** | 0 | 83 pass |

Both run green after every change in this pass. The two skips on Windows are
platform-guarded tests that Linux runs, which is why its pass count is higher —
the suite is the same 687 either way. It was 667 before the drafter retry, and
672 before the case-identity work below.

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

### The drafter refusal is fixed

The Linux first run's finding — *"the spec drafter returned invalid JSON and
there is no retry"* — is closed. `draftUntilReadable` (`src/spec-draft-action.ts`)
asks up to three times, and the boundary is drawn at **what counts as
retryable**:

- **A parse failure** is retried, at the same tier with no escalation, plus one
  line naming what was unreadable. This is the observed failure: cheap-model
  sampling variance that succeeded on the very next attempt.
- **An adapter failure** — non-zero exit, timeout, quota wall — returns at once.
  Retrying spends money against a wall that is still there.
- **A blocking question** cannot be retried away, because it never reaches the
  loop: it is a *successful* parse whose `open_questions` are non-empty. That is
  the property that makes retrying safe at all — the drafter's judgement lives in
  the parsed value, never in a parse error.

When three attempts are exhausted the refusal tells the person what to do
(press it again, add a sentence of detail, or connect a stronger planner) and
states that nothing was written. `test/spec-draft-retry.test.ts` pins all five
behaviours, including that a readable answer costs exactly one call and that a
failed draft leaves no spec behind.

## The case-collision lease hole, closed

**The invariant, stated before it was changed:** *at most one task holds write
scope over any given **file**.* The lease store substituted "byte-equal
repo-relative string" for "file". That substitution is exact on a case-sensitive
filesystem and wrong on a case-insensitive one, where `src/Foo.js` and
`src/foo.js` are one file with two names — two keys, two grants, two workers
writing the same bytes, and the store and the decision gate both reporting
normal.

This was written up as a macOS item. It is not one: **Windows is
case-insensitive and was already exposed.** It went unnoticed because
`canonicalize` realpaths existing files, and realpath returns the on-disk
spelling — so for a file that already exists the two spellings converge on their
own. `canonicalizeIntentPath` is the gap: for a file that does *not* exist yet
it appends the tail verbatim, because there is nothing on disk to take the
spelling from. New files are exactly what a plan leases.

Three arguments with the framing, all narrowing rather than widening it:

**The fix belongs at the path-identity layer, not inside the lease store.** If
only the lease folded, the two layers would disagree: a task granted
`src/newthing.js` writing `src/NewThing.js` would pass the lease check and be
rejected by `decideOp` as `outside_allowed_files`. `src/path-identity.ts` owns
the question and the lease store, the decision gate and scope canonicalisation
all consume it.

**Fold the comparison key, never the stored value.** The lease store's on-disk
shape is unchanged — the spelling the plan used is what is stored, recorded in
the trail and shown to a person. Folding the value would make the record lie
about what was asked for and could hand a worker a path spelled differently from
the one its contract names. `src/lease-index.ts` builds a folded index over an
unfolded store, and a re-request under a second spelling writes through to the
key already there.

**One filesystem fact, two opposite safe defaults.** Widening what is *allowed*
on a guess lets a genuinely different file through, so `allowed_files` folds only
when the filesystem is **proven** case-insensitive. Narrowing what is
*forbidden* on a guess lets a worker evade an entry by shifting a letter, so
forbidden, critical and protected paths fold unless it is **proven**
case-sensitive. Both refuse when unsure, and neither needs a new failure mode.
`.hivemind/canon` folds unconditionally: it is our path, there is one of it, and
a guard stricter than the filesystem costs nothing.

### Detection is a measurement

`process.platform` is the wrong proxy and is not used. macOS is insensitive by
default and sensitive if formatted that way; Linux is sensitive unless a
directory carries the ext4 casefold flag; a disk image or network mount can be
either anywhere. The probe flips the case of a name that already exists in the
repo root — `.git` first — and compares `dev`/`ino`. **Nothing is written**: an
earlier draft created a probe file under `.hivemind/`, which pollutes a
directory between create and unlink and fails on a read-only checkout. Inode
identity rather than "did the stat succeed", because on a case-sensitive volume
somebody may genuinely have both `.git` and `.GIT`, and that is two files.

### Both directions, on real filesystems

The dangerous direction is tested, not just the safe one, and on both platforms
the *real* lease store is driven rather than a model of it:

| | Windows (NTFS) | Linux (ext4) | Windows + `fsutil setCaseSensitiveInfo` |
| --- | --- | --- | --- |
| probe says | case-insensitive | case-sensitive | case-sensitive |
| two tasks, `src/Widget.ts` and `src/widget.ts` | **conflict** | both granted | both granted |

That third column matters: Windows can switch a single directory to genuinely
case-sensitive, which is the only way to prove the *safe* direction on a machine
whose volumes are otherwise all insensitive. It runs — it is not skipped on this
hardware — so both answers are observed on one kernel rather than inferred from
two. The decision itself is pure arithmetic over the verdict and is exercised
for both answers everywhere.

Mutation-tested rather than assumed: making `pathIdentityKey` never fold kills 7
of the 9 tests; inverting the probe's verdict kills the case-sensitive one.

**What this changes for macOS:** item 1 of `MACOS-CHECKLIST.md` is no longer the
question that decides anything. 1a is still worth the two minutes as a
confirmation, but 1b and 1c are now covered by machinery that measures the
filesystem instead of trusting the platform.

## The `codex` escape hatch

`invoke[0]` is a bare name resolved against `PATH`, and a GUI launch does not
get the `PATH` a terminal does. `node` had `HIVEMIND_NODE_PATH` on the shell
side; the agent had nothing, and the failure was `spawn codex ENOENT`.

`HIVEMIND_<AGENT>_PATH` is derived from the program name rather than listed, so
it covers an agent this build has never heard of, and one variable covers
`codex` and `codex.cmd` — a person setting it has one agent in mind, not one
spelling of it. On Windows the override replaces element **four**, not element
zero, because element zero is `cmd.exe` and replacing it would swap the
interpreter rather than the agent.

ENOENT is the one spawn failure with a specific remedy, so it now says the
remedy — naming the program, why a desktop launch differs from a terminal, and
the exact `which`/`where` command that prints the value the variable wants —
instead of quoting an errno. Every other errno keeps the detail it came with.
`adapter.connect` runs through the same path, so this is what a first-time GUI
user meets rather than a stack of nothing.

## The sweep for other Windows-masked defaults

The AppImage icon was found by trying to build on Linux, not by reading. So the
rest of the tree was read looking for the same shape: a default that is correct
on Windows and silently wrong elsewhere. Seven things checked; three findings.

**1. A GUI-launched app may not be able to find `codex`.** The most likely
remaining first-run break, and Windows masks it completely — Explorer hands GUI
processes the full user `PATH` from the registry, so `node` and `codex` resolve.
macOS launchd gives a Finder-launched `.app` `/usr/bin:/bin:/usr/sbin:/sbin` and
nothing else; a Linux `.desktop` launch inherits the session's `PATH`, which may
or may not include wherever npm put `codex`. `node` has an escape hatch
(`HIVEMIND_NODE_PATH`, `project.rs:516`); **`codex` has none** — it is `invoke[0]`
in every generated profile and is spawned as-is. Unverified on both non-Windows
platforms for the same reason: no GUI walk can attach to WebKitGTK, and no Mac
exists here. Written up as item 4 of `MACOS-CHECKLIST.md`, which is where it will
be either confirmed or killed.

**2. `tauri:build` was the only unqualified build script.** `tauri:build:linux`
was added in this pass; `tauri:build` still means NSIS and macOS had nothing.
`tauri:build:mac` now names `app,dmg` and the packaging test asserts all three.
This is config shape, not a verification claim — nobody has built a `.app`.

**3. Case-folding is `win32`-only in six places.** Five in Core
(`config.ts:524`, `events.ts:300`, `project-temp.ts:567` and `:572`,
`daemon-client.ts:184`) and one in the shell (`project.rs:677`). Every one of
them lowercases on Windows and compares literally everywhere else, which is right
for Linux and wrong for a default APFS volume. None is the scope gate — that
keys off `canonicalize()`, whose answer comes from `fs.realpath` — so the whole
question reduces to one fact that needs a Mac to settle. It is item 1 of
`MACOS-CHECKLIST.md`, and it is the reason that checklist exists.

Four things checked that turned out to be nothing, recorded so nobody re-checks
them:

- **BSD vs GNU flags do not apply.** Every external binary spawned was
  enumerated: Core runs `git` and (Windows-gated) `taskkill.exe`; the shell runs
  `git`, `hivemind`, and Windows-gated `powershell`. No `sed`, `awk`, `find`,
  `stat`, `date` or `xargs` anywhere. The one `sleep 30` is a Rust test fixture
  and passes no flags.
- **`test_command` is never spawned by Core.** It is validated as non-empty
  (`integrate.ts:162`) and handed to the agent in a prompt. There is no shell
  assumption to get wrong, and the detected default is `npm test`.
- **Line endings are a non-issue.** There is no `.gitattributes`, but the tree
  contains **zero** checked-in `.sh`/`.bash`/`.ps1` files and **zero** files with
  the executable bit set in the index, so there is nothing a CRLF checkout could
  render unrunnable.
- **`node --test "dist/**/*.test.js"`** quotes its glob and lets Node expand it,
  rather than depending on a shell — which is why the same script works under
  PowerShell, bash and zsh.

### Still not verifiable from here

**macOS remains UNVERIFIED-ON-MACOS.** It takes the POSIX `detached` /
`kill(-pgid)` path and the `["codex", …]` shell branch that Linux now exercises,
which makes that half *likely* fine — an inference, not a result. `.app`/`.dmg`
bundling, code signing and notarisation are untouched and untestable without
hardware.

What inference cannot settle is narrower than "macOS" and is written up as
`docs/MACOS-CHECKLIST.md`.

## What is actually left

No engine work. Every remaining item is packaging or verification — something to
build and sign, or something to observe on hardware that is not here.

| # | Item | Kind | Size | Needs a Mac |
| --- | --- | --- | --- | --- |
| 1 | Confirm the case verdict and process control on macOS | verification | 15 min | yes |
| 2 | Finder-launch PATH: does it break, does the hatch reach it | verification | 15 min | yes |
| 3 | Build `.app`/`.dmg` and check it launches installed | packaging | 20 min | yes |
| 4 | Codesigning + notarisation | packaging | half a day, plus an Apple Developer account | yes |
| 5 | Decide: resolve the agent to an absolute path at connect time | design | 2 h | no — but item 2 decides whether it is needed |
| 6 | A GUI walk that speaks the WebKit Inspector protocol | verification | 1–2 days | no (Linux gets it too) |
| 7 | Linux `.desktop` launch: same PATH question as item 2 | verification | **half done** | no |

Items 1–3 are the hour. Item 4 is the only one that is genuinely expensive and
it buys distribution rather than correctness — an unsigned `.app` runs fine
after a right-click Open, so it is a shipping decision rather than a port one.

Item 7 is the one worth doing without any hardware at all: Linux has exactly the
same launch-PATH exposure as macOS and has never been checked, because the GUI
walk cannot attach there. Installing the `.deb` and launching it from a desktop
environment answers most of item 2 on a machine that already exists.

**Half of item 7 closed on 2026-08-14, and it is worth being exact about which
half.** The question has two parts, and only one of them needs a desktop
session:

| | Question | State |
| --- | --- | --- |
| a | Under a launcher-minimal PATH, does the failure explain itself and does the escape hatch resolve? | **Closed.** `test/adapter-command.test.ts` runs it behaviourally against `/usr/bin:/bin:/usr/sbin:/sbin`: the message names the program and the variable, the hatch points the invocation at an absolute path, and without the hatch nothing is silently substituted |
| b | Does a real display manager actually hand the app that minimal PATH? | **Still open.** Needs a machine with a desktop environment. WSL has no session to launch from |

The distinction matters because (a) is the part that determines whether a person
can recover, and (b) only determines whether they will need to. Closing (a)
means the worst case is now a comprehensible message with a documented fix
rather than an unexplained failure — on both POSIX platforms, since the same
code path serves the `.app` and the `.desktop` launch.

Item 6 is what would let a GUI walk run anywhere but Windows. It is the largest
piece of remaining work and the only one that is engine-adjacent; it verifies the
click-level seam that the headless walk already covers behind the controls.
