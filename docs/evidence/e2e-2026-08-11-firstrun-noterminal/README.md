# First run without a terminal — 2026-08-11

A clean install to a shipped change: **no terminal command, no hand-written
document, including connecting the coding agent.** This is the walk that closes
the front door.

## What was walked

A fresh git repository — a `package.json`, one source file, and **no
`.hivemind`** — driven through the exact typed actions the desktop dispatches,
in the order it dispatches them, through the same `executeWorkspaceAction` the
Tauri bridge calls.

| Step | Action | Result |
| --- | --- | --- |
| Set this folder up | `project.init` | ok |
| Connect planner (codex-luna) | `adapter.connect` | ok, 5 verified / 1 unverified |
| Connect manager (codex-luna) | `adapter.connect` | ok, 5 verified / 1 unverified |
| Connect worker (codex-terra) | `adapter.connect` | ok, 5 verified / 1 unverified |
| Type what you want built | `spec.draft` | ok |
| Prepare a plan | `plan.prepare` | ok |
| Sign the spec | `spec.adopt` | ok |
| Ratify the plan | `plan.ratify` | ok |
| Start the approved plan | `manager.start` | ok |
| Keep going | `manager.continue` | ok, 56s |
| Show me the changes | `adoption.review` | ok |
| Ship it | `adoption.execute` | ok |

The prompt was one sentence: *"Add a greet(name) helper in its own file
src/greet.js that returns 'Hello, <name>!', with its own test file
test/greet.test.js. Do not change any other file."*

## Verified in the repository, not in the action results

```
bd64af8  Hivemind adoption V-335aa795-963c-4847-944e-9bd9bcb8d495
17b51e0  base

 src/greet.js       | 3 +++
 test/greet.test.js | 8 ++++++++
 2 files changed, 11 insertions(+)
```

`npm test` on the branch after adoption: **1 test, 1 pass, 0 fail.** The helper
it wrote is three lines and correct; it changed no other file, which is what the
prompt's non-goal asked.

## What it cost

**294,500 tokens over 6 calls.**

| Role | Calls | Tokens |
| --- | --- | --- |
| planner | 3 | 101,575 |
| worker | 2 | 154,940 |
| manager | 1 | 37,985 |

Three of those six calls are the connect probes (~118K). Connecting agents is
roughly a third of a first run's bill, which is why the button says what it
costs before it is pressed.

## What this walk exercised, and what it did not

- **Exercised:** every typed action the desktop sends, in UI order, against a
  real coding agent and a real repository, from a folder with no `.hivemind`.
- **Not exercised:** the clicking. The controls that dispatch these actions were
  read for wiring rather than pressed, so a mislabelled or missing button would
  not have been caught here. The next real GUI run should confirm the controls.
- **Complements** `e2e-2026-08-11-textkit`, which went prompt-to-shipped through
  the GUI but needed four terminal commands to get there. The two together are
  what closes the question.

## Files

- `first-run.jsonl` — the durable trail, replayable.
- `project-state/` — config, adapters (profiles **and** connection records with
  the probe results), spec, plans and the spend ledger, as they stood at the
  end.
