# First run on Linux — 2026-08-11

The question this answers: **the checked-in adapter profiles were Windows-only,
so a Linux first run depended entirely on `adapter.connect` writing fresh ones —
and nothing had ever tested that.**

It works. A fresh git repository on **native ext4** (not `/mnt/d`, where drvfs
would have hidden platform differences) reached a shipped commit whose tests
pass, with no terminal beyond creating the repository and no hand-written
document.

## What was walked

Every step is the typed action the desktop dispatches, through
`executeWorkspaceAction`, on Linux 6.6 / Node 22 / codex-cli 0.147.0.

| Step | Result |
| --- | --- |
| `project.init` | ok |
| `adapter.connect` planner (codex-luna) | ok, 23s — **5 verified, 1 unverified** |
| `adapter.connect` manager (codex-luna) | ok, 24s — 5 verified, 1 unverified |
| `adapter.connect` worker (codex-terra) | ok, 23s — 5 verified, 1 unverified |
| `spec.draft` | **refused once**, ok on retry |
| `plan.prepare` | ok, 42s |
| `spec.adopt` → `plan.ratify` | ok |
| `manager.start` → `manager.continue` | ok, 69s |
| `adoption.review` → `adoption.execute` | ok |

Verified in the repository, not in the action results:

```
src/greet.js       | 5 +++++
test/greet.test.js | 8 ++++++++
npm test after adoption: 1 test, 1 pass, 0 fail
```

**The profile `adapter.connect` wrote begins `["codex", "exec", …]`** — no
`cmd.exe`, no `codex.cmd`. That is the whole point: the platform-correct
invocation is generated at connect time and verified by the probe, so nothing
in the repository has to be right about the platform.

## What it cost

**289,744 tokens** — planner 98,370 over 4 calls (one wasted on the refused
draft), worker 154,129 over 2, manager 37,245 over 1. Three of those calls are
connect probes at roughly 40K each, matching Windows exactly.

## Two findings

**The spec drafter returned invalid JSON once, and there is no retry.**
`spec.draft` refused with *"spec drafter returned invalid JSON: SyntaxError:
Expected ',' or ']' after array element at position 809"*. The same prompt
succeeded on the immediate retry, so this is model variance from the cheap model
(`codex-luna`), not a Linux fault — the Windows walks used the same model and
did not hit it. But Core has no repair or retry on a malformed drafter response,
so a first-time user meets a hard refusal and has to press the button again with
no indication that trying again is the right move. Worth a retry-once in Core;
recorded rather than fixed here.

**One harness bug, not a product one.** The first attempt refused at
`project.init` with *"not a git repository"* on a directory that plainly was
one. Cause: `$(pwd)` was expanded by the outer Windows shell before reaching
WSL, so the walk received `"AI"` — a fragment of `D:\Projects\Hivemind AI` — as
the project path. Refusing was correct. This is the same class as the two
harness notes already in DESIGN-NOTES, and is why the path is now passed
literally.

## Files

- `linux-first-run.jsonl` — the durable trail.
- `project-state/` — config, adapters with their probe records, spec, plans,
  ledger.
- `shipped.txt` — the commit and its diffstat.
