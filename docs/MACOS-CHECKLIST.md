# macOS: an hour with a Mac

macOS is the last unverified platform. Windows and Linux are both green and both
have a first run walked end to end; macOS has neither, and no amount of reading
the source turns that into a result.

This is the checklist. It is ordered by **what could be wrong that matters**, not
by what is easy, so if the hour runs out the important answers are already in
hand. Each item says what to run, what a pass looks like, and what a failure
would mean — because "it didn't work" is not a finding.

Everything here was derived by reading the source on 2026-08-11. Where inference
gives a confident answer, it is stated as an expectation so the check can
disconfirm it. Where inference genuinely cannot decide, the item says so.

**Prerequisites** (~10 min, not counted in the hour): a Mac with git, Node 22,
Rust, `codex` CLI logged in, and a clone of this repository. Then:

```sh
npm ci && npm test
```

---

## 1. The scope gate on a case-insensitive filesystem — 5 min

> **Mostly closed since this was written.** The lease store, the decision gate
> and scope canonicalisation now key off a *measured* filesystem verdict rather
> than a path string — see "The case-collision lease hole, closed" in
> `CROSS-PLATFORM.md`. Windows was exposed to the same defect and is the
> platform the fix is verified on, in **both** directions: NTFS conflicts on two
> spellings, and a directory switched to case-sensitive with
> `fsutil setCaseSensitiveInfo` does not.
>
> What is left here is confirmation that macOS behaves like the other two
> case-insensitive volumes, which 1a and 1b answer in five minutes. **Item 4 is
> now the one worth the hour.**

APFS is case-**insensitive** by default, so
`src/Foo.js` and `src/foo.js` are one file. Every other platform Hivemind runs on
either agrees with that (Windows, and the code knows it) or disagrees with it
consistently (Linux, where they really are two files). macOS is the only place
where the filesystem says "same" and `process.platform` says "case-sensitive":

```
src/config.ts:524       process.platform === "win32" ? lowercase : as-is
src/events.ts:300       same
src/project-temp.ts:567 same
src/project-temp.ts:572 same
src/daemon-client.ts:184 same
desktop/src-tauri/src/project.rs:677  cfg!(windows) ? eq_ignore_ascii_case : ==
```

None of those five is the scope gate, though. The scope gate and the lease store
both key off whatever `canonicalize()` returns (`src/canonicalize.ts:14`,
`src/decision.ts:75`, `src/lease.ts:192`), and that function's answer comes from
`fs.realpath`. So the whole question collapses to one fact nobody here can
establish without a Mac:

> **Does `fs.realpath` on macOS return the case as stored on disk, or the case
> that was asked for?**

### 1a. Answer that first

```sh
mkdir -p /tmp/hm-case && cd /tmp/hm-case && touch foo.js
node -e "console.log(require('fs').realpathSync('/tmp/hm-case/FOO.js'))"
diskutil info / | grep -i "File System Personality"
```

- **Prints `/tmp/hm-case/foo.js`** → realpath corrects case. Section 1b will
  pass and the invariant holds. This is the expected result; confirm it anyway.
- **Prints `/tmp/hm-case/FOO.js`** → realpath is a pass-through. Go to 1b, which
  will fail, and treat it as a scope-gate defect rather than a cosmetic one.
- **Throws ENOENT** → the volume is case-sensitive (someone formatted it that
  way). You are testing the Linux story, not the macOS one. Note it and move on;
  this section proves nothing on such a volume.

### 1b. Then prove the invariant on the real machinery

Two leases whose paths differ only in case must not both be granted, because on
this filesystem they are the same file, and "one writer per file" is stated
without qualification.

```sh
cd /tmp && rm -rf hm-lease && mkdir hm-lease && cd hm-lease
git init -q && mkdir src && echo "x" > src/foo.js
git add -A && git -c user.email=t@t -c user.name=t commit -qm base
node <REPO>/dist/src/cli.js init
node <REPO>/dist/src/cli.js lease request --task T-001 --file src/foo.js
node <REPO>/dist/src/cli.js lease request --task T-002 --file src/Foo.js
```

*(Check the exact `lease` subcommand spelling with `cli.js --help`; the point is
two requests from two task ids over the two spellings.)*

- **Pass:** the second request is refused with `lease conflict: src/foo.js held
  by T-001`. Note that it names the *lowercase* path — that is realpath having
  canonicalised the second request onto the first's key.
- **Fail:** both are granted. Then `.hivemind/leases.json` holds two keys for one
  physical file, two workers can be scheduled against it, and the one-writer
  invariant is broken on macOS specifically. **That is a real defect, not a
  packaging nit** — record it as such.

### 1c. The case that used to survive a passing 1a — now fixed, still worth running

A file that does **not yet exist** never had an on-disk spelling to be corrected
against, so `src/NewThing.js` and `src/newthing.js` were two lease keys no
matter what realpath did. That was the actual hole, and it is closed: identity
is now a measured filesystem property rather than a string comparison.

```sh
node <REPO>/dist/src/cli.js lease request --task T-003 --file src/NewThing.js
node <REPO>/dist/src/cli.js lease request --task T-004 --file src/newthing.js
```

- **Pass:** the second is refused. The suite proves this on NTFS and on a
  Windows directory switched to case-sensitive; macOS should behave like the
  first of those.
- **Fail:** both granted. Then the probe read this volume as case-sensitive when
  it is not — check `npm test 2>&1 | grep "probe agrees"`, which compares the
  probe against a real write-then-read-under-another-spelling.

### 1d. What git thinks

```sh
git config core.ignorecase        # expect: true, set by git init on this volume
mv src/foo.js src/Foo.js && git status --porcelain
```

If `core.ignorecase` is true, git reports the **index** case, so the diff Core
parses stays self-consistent regardless of what the working tree is called. This
is why the *diff-scope* half of the question is less exposed than the *lease*
half: the diff comes from git, which has already picked one spelling.

---

## 2. Process control — 10 min

macOS takes the same POSIX branch Linux now exercises: `detached: true`
(`src/adapter.ts:446`), `process_group_id` recorded, `kill(-pgid)` to prove the
tree dead (`src/process-control.ts:72`), `kill(pid, 0)` liveness with ESRCH-only
meaning dead (`src/process-liveness.ts`). That path is proven on Linux, so this
is a confirmation rather than an exploration.

```sh
npm test 2>&1 | tail -20
```

- **Expect:** the same counts Linux reports (687 tests, 687 pass, 0 fail, 0
  skipped — the two Windows skips are Windows-only guards).
- The tests to watch by name are the cancellation ones. A failure mentioning
  *"has no recorded process group"* means a spawn path lost `detached`, which is
  the exact shape of the Linux failure already diagnosed in `CROSS-PLATFORM.md`.
- One genuine difference to be aware of: macOS `kill(2)` returns **EPERM** for
  processes protected by System Integrity Protection where Linux would return
  ESRCH or succeed. `getProcessLiveness` maps EPERM to `unknown`, and the temp
  reconciler removes only on `dead`, so the effect is a directory retained rather
  than one reclaimed. Fail-closed either way; no action expected.

---

## 3. BSD vs GNU tool flags — 2 min

**There is nothing here, and that is the finding.** Every external binary Core
spawns was enumerated:

```
src/*.ts            git, taskkill.exe (Windows-gated)
src-tauri/*.rs      git, hivemind, powershell (Windows-gated), sleep (test only)
```

No `sed`, `awk`, `find`, `stat`, `date`, `readlink`, `xargs` — so the entire
BSD-vs-GNU flag class does not apply to the product. `git` is git. The one
`sleep 30` is in a Rust test fixture and uses no flags.

Confirm with `npm test` passing (item 2). If it passes, this item is closed.

---

## 4. PATH when launched from Finder — 15 min

**This is now the item worth the hour, and it is expected to fail.** A `.app`
launched from Finder or Dock inherits launchd's minimal PATH
(`/usr/bin:/bin:/usr/sbin:/sbin`), **not** the shell's. Neither Homebrew's
`/opt/homebrew/bin` nor nvm's node directory is in it. Two things then fail to
resolve:

- `node`, spawned by name at `desktop/src-tauri/src/project.rs:516` unless
  `HIVEMIND_NODE_PATH` is set.
- `codex`, which is `invoke[0]` in every generated adapter profile
  (`src/project-defaults.ts:137`), spawned by `src/adapter.ts`.

Windows masks this completely: Explorer hands GUI apps the full user PATH from
the registry. It is unverified on Linux too, for a different reason — the GUI
walk cannot attach to WebKitGTK, so no Linux run has ever exercised a
Finder-equivalent launch.

**Both now have an escape hatch, and the failure now explains itself.**
`HIVEMIND_CODEX_PATH` overrides the agent (derived from the program name, so
`HIVEMIND_CLAUDE_PATH` and so on work the same way), and a program that cannot
be found produces a message naming it, saying why a desktop launch differs from
a terminal, and giving the `which` command that prints the value the variable
wants. So this item is no longer "does it break" — it is **"does it break
comprehensibly, and does the hatch work"**.

### 4a. Does it break, and does it say so

```sh
open -a "Hivemind AI"                        # from Finder/Dock, NOT from a terminal
# then in the app: open a project and connect an agent
```

- **Pass:** `adapter.connect` completes with a probe report. macOS resolves the
  agent from a Finder launch and nothing more is needed.
- **Expected failure:** it refuses with *"We could not find codex on this
  computer's PATH…"*. That is the intended outcome of a missing agent — record
  the message verbatim, and confirm the PATH is the cause rather than guessing:

  ```sh
  /Applications/Hivemind\ AI.app/Contents/MacOS/hivemind_desktop &
  ps eww $! | tr ' ' '\n' | grep ^PATH=
  ```

- **Bad failure:** a raw `spawn codex ENOENT`, or a hang, or a message naming an
  adapter profile. That means the diagnosis did not fire on this platform and is
  worth reporting.

### 4b. Does the hatch actually work

```sh
which codex                                  # e.g. /opt/homebrew/bin/codex
launchctl setenv HIVEMIND_CODEX_PATH "$(which codex)"
launchctl setenv HIVEMIND_NODE_PATH "$(which node)"
# fully quit the app, then relaunch from Finder
```

`launchctl setenv` is what puts a variable into the environment Finder-launched
apps inherit; exporting it in a shell will not reach them. **Pass:**
`adapter.connect` now completes from a Finder launch.

If 4a fails and 4b passes, the remaining decision is whether Hivemind should
resolve the agent to an absolute path at connect time — the probe already
verifies everything else about it — rather than asking a person to set a
variable. That is a design call, not a bug report.

---

## 5. Packaging — 15 min

`tauri.conf.json` now declares `targets: "all"` and a full icon set including
`icons/icon.icns`, so the macOS bundlers have what the AppImage bundler was
missing. There is no `tauri:build:mac` script yet; add one or pass the bundles
directly.

```sh
cd desktop && npx tauri build --bundles app,dmg
```

- **Expect:** `Hivemind AI.app` and `Hivemind AI_0.0.0_<arch>.dmg` under
  `src-tauri/target/release/bundle/`.
- Then: mount the `.dmg`, drag to Applications, launch — and **do item 4 from
  that installed copy**, not from the build directory.

Two things to look at specifically:

- **Gatekeeper.** Unsigned, the first launch is blocked with *"cannot be opened
  because the developer cannot be verified"*. Right-click → Open bypasses it for
  a local test. Shipping needs a Developer ID certificate, `codesign --deep`,
  and notarisation — none of which exist in this repository and none of which
  can be set up without an Apple Developer account. Record the requirement; do
  not try to solve it in the hour.
- **`bundle.resources` ships `../../node_modules`** into the app. That directory
  contains native modules (`tree-sitter`) and symlinks. Codesigning a bundle
  with symlinks and unsigned `.node` binaries inside `Resources/` is a known
  source of *"code object is not signed at all"*. Check whether the `.app` even
  launches before worrying about signing it:

  ```sh
  codesign -dv --verbose=4 "/Applications/Hivemind AI.app" 2>&1 | head
  ```

---

## 6. WebKit vs WebKitGTK — 5 min

macOS Tauri uses **WKWebView**, not WebKitGTK. Two consequences, one better than
Linux and one the same:

- **Better:** Safari's Web Inspector can attach to a WKWebView directly (enable
  *Develop → Show web inspector for other processes*), so a human can inspect
  the running UI — which is impossible on Linux.
- **The same:** it still speaks the WebKit Inspector protocol, not CDP, so the
  Playwright `connectOverCDP` GUI walk built for WebView2 **cannot attach**. The
  click-level seam stays Windows-only.

What that leaves unverified is unchanged from the Linux case: control labels,
enabled/disabled states, and the control-to-action wiring. The logic behind them
is exercised by the headless walk. The React bundle is byte-identical.

Worth five minutes: open the app, look at the five surfaces
(`docs/evidence/ui/visual-2026-08-11`) and note any rendering difference. Font
rendering *will* differ; that is not a defect. Layout breaking is.

---

## 7. Temp directories — 5 min

macOS gives each user a private, per-session temp directory under
`/var/folders/...` via `confstr(_CS_DARWIN_USER_TEMP_DIR)`, which `os.tmpdir()`
returns. That is closer to Windows than to Linux: the shared-`/tmp` cross-user
EPERM hazard analysed in `CROSS-PLATFORM.md` does not arise, because no other
user can see the directory.

```sh
node -e "console.log(require('os').tmpdir())"   # expect /var/folders/...
```

The namespacing tests run as part of item 2. One macOS-specific note: those
directories are periodically cleaned by the system, so a long-idle disposable
directory can vanish under a live owner. The reconciler treats a missing
directory as nothing to reclaim, so the failure mode is a recreate rather than a
loss — but if a test flakes here, that is the mechanism.

---

## What to write down

For each item: **pass**, **fail with the observed output**, or **not reached**.
The one answer that still changes what gets built is **item 4** — whether a
Finder-launched app can find `codex`, and whether the escape hatch reaches it.

Item 1 used to share that billing. It no longer does: the lease hole it was
written to find was fixed in the machinery and is verified in both directions on
Windows, so 1a and 1b are now confirmation that macOS behaves like the other
case-insensitive volume rather than an open question. Everything else here is
packaging.
