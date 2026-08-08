# Audit findings

Findings that outlive the session that found them. A finding belongs here when
it changes a plan or a belief about the system, not merely when it is a bug —
bugs get fixed and disappear; the reason they were possible should not.

Severity is about **consequence if left alone**, and is stated separately from
**product impact today**, because the two often differ. A finding that harms no
current user can still block a plan the project has already committed to.

| ID | Finding | Severity | Product impact today | Status |
| --- | --- | --- | --- | --- |
| F-1 | The test suite cannot run on the platforms being ported to | High (blocks the cross-platform plan) | None | Open, deliberately not fixed |

---

## F-1 — "Green" means "green on Windows"

**Severity: High for the port. Product impact today: none.**
**Status: open. Deliberately not fixed — recorded so the plan can account for it.**

### The finding

The Core suite has only ever been run on Windows. Run on Linux for the first
time (WSL2 Ubuntu-22.04, kernel 6.6.87.2, during the POSIX worker-termination
work), **six tests fail**.

None of them is a product defect. All six are fixtures that encode Windows
assumptions. That is what makes this a finding rather than a bug list: the
suite cannot gate a POSIX port, because it cannot pass on a POSIX target even
when the product is correct there.

### The six

| Test | Diagnosis |
| --- | --- |
| `capability corpus` — fake Codex corpus uses the real disposer | Fixture installs its fake agent as `fake-bin/codex.cmd`, a Windows batch file. On Linux it is not executable, so the agent never runs and `calls.jsonl` is never written (`ENOENT`). |
| `capability corpus` — repeats one selected profile in fresh immutable iterations | Same `codex.cmd` fixture. |
| `capability corpus` — registered corpus evidence is hash-bound and source-labeled | Same `codex.cmd` fixture. |
| `capability corpus` — retains usage, cache economics, and overshoot evidence | Same `codex.cmd` fixture. |
| `resolveChangeset classifies mode-only changes as chmod` | File-mode semantics differ between platforms; the fixture encodes the Windows outcome. Notably this is the test *about* Unix file modes, and it is the one that fails on Unix. |
| `CLI analyze prints escalate JSON and exits non-zero for an escalated bundle` | Not diagnosed. |

### Confirmed not a regression

These were measured **both with and without** the POSIX termination change, by
stashing it and rebuilding: the same six, by name, with identical counts
(24 tests, 18 pass, 6 fail) in each direction. They are pre-existing.

### Why it matters more than six fixtures

The project intends to port to two POSIX platforms. The gate for that port is
the suite. A suite that cannot pass on the target cannot gate the port, so
today the only honest statement is *"green on Windows"* — and every "full suite
green with the count" in this repository's history means exactly that and
nothing more.

The four `codex.cmd` cases share one cause and are likely one fix. The `chmod`
case needs a decision, not a fix: either the fixture asserts per-platform
outcomes, or the test is Unix-only and skips elsewhere. The `analyze` case needs
diagnosis first.

### Reproducing

See "How to run the suite on Linux from a Windows box" in
[DESIGN-NOTES.md](DESIGN-NOTES.md). Run targeted files; a full-suite run over
the 9p mount managed roughly 130 tests in 25 minutes.
