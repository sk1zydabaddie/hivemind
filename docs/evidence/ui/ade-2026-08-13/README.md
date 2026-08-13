# ADE pass — 2026-08-13

Development-environment surfaces: a **diff view** wherever a change is
discussed, **notes on a diff line** that ride the redirect channel, a **file
tree and file viewer** on a new read-only Core action, an **accounts panel**
that refuses to draw a meter it cannot read, and a **checks-output pane** —
built instead of the embedded terminal that was refused.

Images 01–05 and 07 are the real app at **1440×900**, driven by `replay.html`.

```
npm run replay:collect
npm run dev   ->  /replay.html?scenario=<id>
```

| # | Surface | Scenario |
| --- | --- | --- |
| **01** | **The whole verified set at the ship bar, line by line** | `walk4-prompt-to-shipped@ship&open=changes` |
| **02** | **Agents and what they spent** | `e2e-textkit-parallel-run&tab=project` |
| 03 | A run in flight, with the files each agent holds | `e2e-textkit-parallel-run@midrun` |
| 04 | The agent graph at peak concurrency | `e2e-textkit-parallel-run@midrun&tab=agents` |
| 05 | A held file opened from the rail, with the project tree | `…@midrun&open=file&file=src/slugify.js` |
| **06** | **What the checks said** | `…@midrun&open=checks` |
| **07** | **The whole file, reached by walking the tree** | `…@midrun&open=filetext&walk=src/lib/diff-model.ts` |

## What to look at

**01 is "See every line" finally showing lines.** The control already existed
and dumped a raw patch into a `<pre>`. It now renders the real captured patch
from `docs/evidence/e2e-2026-08-11-walk4/project-state-after/patches/T-001/diff.patch`:
three files, `+39 −0`, per-file change kind, and **editor-accurate line
numbers** on both sides. The first added line is the email regex — dense with
`+`, `-`, `@` and `/`, exactly the input a naive diff parser mangles. It renders
intact, and `test/diff-model.test.ts` parses that same file on disk and asserts
it.

This dialog is **read-only on purpose**. It sits directly above the ship button,
and a comment box there would be the adoption gate with an extra door.

**02 is the panel that exists because three days went to an exhausted quota with
nothing on screen saying so.** The rule worth the whole feature is what it
*refuses* to draw:

> planner  `gpt-5.6-sol`   **not readable**
> This agent was installed before Hivemind could check it, so nothing here
> knows whether its spending can be read. Reconnect it to find out.

A provider whose `reports_usage` capability is not `verified` is marked
unreadable in amber — never a confident zero. The worker, which was probed,
reads **599K across 4 tasks**. `THIS RUN 623K of 2.50M` is Core's own ledger,
the figure the ceiling is enforced against, not a sum of events.

That 599K sat under "unattributed" until the last fix. `routing.observed` names
the provider `codex-terra` — the *agent* — while the adapter's tool is `worker`
— the *role*. Every token landed in the unattributed line and the worker read 0.
The types were perfectly happy; the screenshot was not.

**06 is the terminal replacement, and the point is what it contains:**

```
not ok 2 - strips punctuation
    expected: 'hello-world'
    actual:   'hello,-world!'
```

That is the answer to "why did the checks fail", with no shell involved —
Hivemind ran the command, so the output was always there to keep. Until this
pass it was thrown away: `verification.completed` recorded `exit_code` and
dropped stdout and stderr. Failures sort first, above the passing check.

**05 and 07 are the file tree and viewer**, on the new `files.list` /
`files.read` Core action. Note what the tree does **not** contain: no `.git`,
no `.hivemind`. Those are refused by name and omitted from listings, and the
refusal names the audited action that serves them instead.

**05 is also the honest dead end turned into a door.** The textkit trail
retained no per-task patches, so the diff pane says

> this run's record does not include the lines it changed

and now adds: *the files themselves can still be read.* In the same frame,
**"Notes steer the agent. They never approve or ship anything."** and **Send
notes** disabled, because nothing is written.

## What is real in each, and what is not

Per the standing rule, the synthesized parts are named rather than left to be
discovered.

- **01–04 are entirely captured trail state.** No figure on them is invented.
- **01's patch is walk4's own.** It is the only trail in the corpus that
  retained patch files, so it is the only scenario shown with a diff. Serving
  walk4's patch under textkit's scenario would have produced a denser-looking
  screenshot and a false one.
- **The file tree and the checks output in 05, 06 and 07 are LIVE captures, not
  replayed trails.** No trail in the corpus retained the project's source tree
  or what its checks printed — `project-state/` is `.hivemind`, Hivemind's own
  record. So `collect-replay.mjs` runs the **real** Core functions
  (`listProjectFiles`, `readProjectFile`, `runNamedCheck`, `storeCheckOutput`,
  `readCheckOutput`) over a real directory and a real command and keeps what
  comes back. Nothing is authored; it is genuinely produced. Two consequences
  worth naming:
  - The tree in 05 and 07 is **this repository's `desktop/`**, not textkit's —
    a real project, but not the one the dialog's task belongs to.
  - The failing assertion in 06 is a real `node --test` run against a real
    two-line bug, executed during collection.
  The capture procedure has been changed so the next real run retains both from
  the trail itself; see `desktop/DESIGN-NOTES.md`. When it does, the live
  capture is deleted.

## The one surface with no screenshot

**The note editor with notes in it.** Reaching it needs a task that is
simultaneously holding a lease *and* has a patch on disk, and no captured trail
is both: walk4 retained patches but its task record carries no `lease_files`;
textkit carries leases but retained no patches. Rather than fabricate a trail
state to photograph, it is covered by test — `test/thin-client.test.ts` asserts
the diff view dispatches nothing, states that notes are guidance, and reaches
Core only through `task.redirect`.

The gap is in the corpus, not in the feature, and it is now a **timing
requirement on the mid-run snapshot** in the capture table rather than an open
question: take it after the first `task.patch_submitted` while other agents are
still working.
