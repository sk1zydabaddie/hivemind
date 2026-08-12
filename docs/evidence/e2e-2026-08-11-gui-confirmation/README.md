# GUI confirmation walk — 2026-08-11

The seam the last walk left open. The action-level walk proved every typed
action works from a clean install; this one **clicks the controls that send
them**, in the real Tauri app, on a fresh repository.

That gap is where this project's three worst first-run defects lived: a
duplicate ratification check behind the prompt, autonomy signing for the person,
and a payload field the dispatcher and `adoptSpec` disagreed about. All three
were invisible to the suite.

## How it was driven

The release build, launched with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`, driven
over CDP with Playwright: real clicks on real controls, `Control+Enter` in the
real composer. **No typed action was dispatched directly.** If a control were
mislabelled, wired to the wrong action, or disabled when it should not be, the
walk stops there.

## What was clicked, and what happened

| Control | Result |
| --- | --- |
| **Set up this folder** | the Work surface appeared |
| **Settings** | opened |
| **planner** on *Codex — cheaper* | connected, 6 capabilities reported |
| **manager** on *Codex — cheaper* | connected |
| **worker** on *Codex — balanced* | connected |
| composer, empty | `Start building` **disabled** — correct |
| composer, filled | `Start building` **enabled** — correct |
| **⌘↵** | plan prepared |
| **Review the plan** | the review opened |
| **Approve and start** | enabled, clicked, work ran |
| **Show me the changes** | bar became *Confirm this exact change set* |
| **Ship it** | shipped |

Verified in the repository rather than on screen:

```
ac5500e  Hivemind adoption V-3325163c-8918-44bd-b235-6b17e2c3ade9
43acfd8  base
 src/shout.js       |  3 +++
 test/shout.test.js | 12 ++++++++++++
npm test after adoption: 0 fail
```

## What it found

**Shipping is two clicks, not one — and the evidence screenshot only ever showed
the second.** A real run's ship bar first reads *"Fresh checks passed; review the
change set"* with **Show me the changes**; only after that does it become
*"Confirm this exact change set"* with **Ship it**. Core requires the review to
bind the exact set before it will authorise a merge, so this is correct
behaviour — but `04-ship-bar.png` shows the second state, because the `@ship`
replay scenario was rebuilt with `exactReview = true`. The first state had never
been captured.

**Two things that looked like defects and were mine, not the app's:**

- `Set it up` on the setup screen opens the *agent* dialog; initialising is
  `Set up this folder`. The first driver script clicked the wrong one. The
  labels are correct in context.
- `Ship it` appeared visible-but-disabled once. That was two CDP clients driving
  one app at the same time, so `busy` was true from the other one's in-flight
  action. Not an app fault, and recorded so nobody chases it.

Nothing else was wrong. Every control did what its label said.

## What it cost

**414,536 tokens over 6 calls** against an estimate of 294,500.

| | Estimated | Actual |
| --- | --- | --- |
| three connect probes | 117,890 | **118,794** |
| draft + plan | 63,594 | 64,243 |
| worker | 113,016 | **231,499** |

The probes were within 1%. The run half doubled because the planner produced a
**two-task** plan for this prompt where the previous walk's produced one — so
the variance is plan shape, not estimation error. Worth knowing as a first-run
cost: **connecting three agents is ~118K regardless, and the rest depends
entirely on how many tasks the planner writes.**

## Files

- `gui-run.jsonl` — the durable trail.
- `project-state/` — config, adapters with their probe records, spec, plans,
  ledger.
- `shipped.txt` — the commit and its diffstat.
