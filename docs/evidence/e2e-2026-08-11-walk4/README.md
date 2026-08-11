# First-run walk 4 — clean install, prompt to shipped, 2026-08-11

## Prompt to shipped: yes

A clean install gets from prompt to shipped with no terminal and no
hand-written document. Folder chosen, project set up, prompt typed, spec
drafted, plan prepared, one review, non-goal authored, approved, worked,
checked, shipped — every step through the app.

The evidence is on the base branch of the walked project rather than in this
folder: commit `de6eba7` on `main`, `src/email.js` and `test/email.test.js`
added, `src/index.js` re-exporting, and `npm test` green at 3/3 where it was
1/1 before. `08-shipped.png` is the confirmation the person actually sees —
**3 files changed · landed as de6eba7081**, which replaces the `0 files changed`
defect that `e2e-2026-08-11-textkit/08-post-ship.png` still carried.

## What the walk cost, and why the pairing was the fix

**3 calls, 199,708 tokens.** Estimate before spending was ~163,000, so 22% over,
all of it in the worker.

| Call | Provider | Tokens |
| --- | --- | --- |
| Drafting the spec | `planner` / `gpt-5.6-sol` | 20,280 |
| Preparing the plan | `planner` / `gpt-5.6-sol` | 21,382 |
| The work | `worker-standard` / `gpt-5.6-terra` | 158,046 |

The run session — planning plus the worker — came to **179,428 against a
300,000 ceiling**, about 40% headroom.

The number that settles the argument is 158,046. That is a **standard-tier**
worker call, on the cheaper model the new tier ladder routes ordinary source
work to, and it is still larger than the old 150,000 run ceiling. So routing
work down a tier would not have fixed the first run on its own; neither would
raising the ceiling while every role stayed on the flagship. Fixing the
providers without the ceiling in the same change would not have been a fix, and
this walk is the measurement that shows it.

`routing.observed` in the trail records `provider: "worker-standard"`, so the
tier ladder is proven in the durable log rather than only in a config file.

The worker overshot the estimate because it made a mistake and corrected it —
an extra closing parenthesis in the regular expression, caught by the project's
own tests, fixed, re-run. That is the system working, and it is also why an
estimate built from a clean call is optimistic.

## Four defects, all found by walking

None of these were caught by 646 passing tests. All four are in the first-run
seam, which is the fourth consecutive walk to find something there.

### 1. A byte-order mark silently cost the project its checks

`hivemind init` detects the test command by parsing `package.json`. PowerShell's
`Set-Content -Encoding utf8` writes a BOM, `JSON.parse` rejects it, and the
catch returned `""` in silence. Setup reported success and the project was
configured with no checks.

It would not have shipped code unchecked — `integrate.ts` refuses shadow
integration with an empty test command — but it would have failed at
*integration*, after the worker was paid for, with a message naming a config
key. Silent early, expensive late, and phrased for whoever wrote the code.

The BOM is now stripped and an unparseable `package.json` is reported rather
than absorbed; a *missing* one stays silent, because that is a project with
nothing to detect rather than a broken one. Pinned by
`test/first-run-defaults.test.ts`.

Found because my own fixture was written with PowerShell. Worth stating plainly:
this walk was one accident away from measuring my own setup instead of the
product, and the accident is what exposed the defect.

### 2. The cost readout undercounted by a third of the calls

The composer showed **2 calls / 179.4K** on a run that had spent **3 calls /
199.7K**. `spec.draft` runs before any run exists, so it bills its usage to the
spec id while planning and work bill to the run session; the readout summed only
the run session. A third of the calls and a tenth of the money were invisible,
in the direction that flatters us.

Both sessions are the same first run to anyone reading the number, so the spend
now sums them. `test/spend-readout.test.ts` asserts it against **this walk's
captured `project-state-after`**, deriving the expected figures from the
project's own settled reservations rather than restating them. Reverting the fix
turns that test red at `expected 3, actual 2` — checked, not assumed. A fixture
could not have caught this: the two-session split only appears when a spec is
drafted and then run.

### 3. The setup screen told people to paste files it had already written

> Steps 2 and 3 are files in your project. Hivemind cannot write them for you
> yet, so it hands you exactly what to paste.

Setting up the folder writes the adapter profiles and, since this round, the
cost tiers. The first screen a new person sees was sending them to a terminal
for work already done. Rewritten to say what actually happens.

### 4. After an update, an existing project says "restart the daemon"

Opening a project whose daemon is running an older build gives:

> daemon build mismatch: state …, running …, expected …; restart the daemon
> before using this project

The guard is right — mismatched builds must not share a project. The problem is
the instruction. There is no restart control anywhere in the app, so a person
who updates Hivemind while a daemon is alive is told to do something the product
does not let them do, in words from the wrong vocabulary, with hashes.

**Not fixed this round, and recorded rather than worked around.** It cost me
three recapture attempts on a walk that was already finished, which is a fair
proxy for what it costs someone with no terminal. The fix is for the app to
retire a mismatched daemon of its own accord, since it started it.

## What was verified about resuming, and what was not

`resumeTask` shipped last round with fail-closed guards and **no tests** — the
only tests mentioning resuming covered Core's internal quota-reset path, which
is a different mechanism. `test/task-resume.test.ts` now covers it: 8 tests
against a genuinely paused task, produced by walling the only eligible provider
rather than by writing a `task.paused` event by hand.

Each dangerous direction is asserted directly. Resuming refuses when the spec is
no longer ratified, when the approved plan no longer contains the task, when
another task now holds a file it was editing (biting that branch specifically,
with the task still holding a different lease), when it holds nothing at all,
and when the worktree is gone. The success case proves the claim that justifies
the whole thing: partial work survives, and no plan is ratified a second time.

**This walk did not exercise resume,** because the new defaults meant the run
never hit the ceiling. That is the right outcome and it is also a gap in the
evidence: the recovery path is proven by tests and not by use.

## Conditions

Genuinely fresh folder (`D:\Projects\hivemind-walk4`, a small JS library with
one passing test), no `.hivemind`, set up through the app's own **Set up this
folder** button. No terminal and no hand-editing of any Hivemind document at any
point in the walk. Clicking was synthetic, through the WebView2 debugger, but
every click went through the real UI and every action through the real
dispatcher.

Two departures, both after the walk had finished and neither affecting the
result: BOMs were stripped from the fixture's own source files and the project
was re-set-up (defect 1, my error), and stale daemons were killed to recapture
screenshots (defect 4).

## Files

| File | What it is |
| --- | --- |
| `walk4-prompt-to-shipped.jsonl` | The whole trail, 33 events, prompt to `adoption.completed`. |
| `project-state/` | `.hivemind` before the first call: config, adapters, ceilings. |
| `project-state-after/` | `.hivemind` after shipping: spec, plan, ledger, verification set, adoption manifest. |
| `01-fresh-folder-not-set-up.png` | The corrected setup screen on a folder that has never been set up. |
| `02-prompt-typed.png` | The composer with the prompt and nothing running. |
| `03-after-draft-and-plan.png` | A plan waiting, task named rather than numbered. |
| `04-the-one-review.png` | The one review: three assumptions under "Decisions made for you", no blocking questions, Approve enabled. |
| `05-review-non-goal-authored.png` | The same review with a non-goal the person wrote. |
| `06-work-in-flight.png` | The worker running, live output and diff. |
| `07-changes-bound.png` | The exact change set bound before shipping. |
| `08-shipped.png` | Shipped to main: 3 files changed, landed as `de6eba7081`, spend reading all three calls. |

## The prompt, and what the drafter did with it

Same prompt as walk 3, unchanged, for comparability: *"Add a way to validate
email addresses"*.

Zero open questions. Three assumptions, all shown in the review under
**Decisions made for you** — practical syntax rather than full RFC compliance,
whitespace makes an address invalid rather than being trimmed, and the validator
returns a boolean. One non-goal declined on its own: *"Does not verify that the
domain or mailbox exists or can receive email."*

The person added the non-goal the product asks them for: *"Don't change the
existing name helper or its test."* The worker did not touch either.

This is the third consecutive run in which the drafter finds the same real
ambiguity in this prompt and, since the assumptions change, states it rather
than blocking on it. The gate still bites when it should; it simply stopped
biting on the ordinary case.
