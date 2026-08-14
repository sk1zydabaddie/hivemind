# Stage 1, raw Codex — halted after task 1, over budget

**Status: 1 of 4 prompts run. Stopped and reported rather than continued.**

## Why it stopped

Approved envelope: **~130K–260K tokens** for the whole raw arm, four prompts.

**Task 1 alone consumed 212,199 tokens.** Continuing would have cost roughly
three times what was approved, so the run was halted after the first prompt.

| | Task 1 |
| --- | --- |
| Total tokens | **212,199** (208,611 in / 3,588 out) |
| Of which cached input | 188,160 — billed at 10% |
| Fresh input | 20,451 |
| Cost | **$0.0061** at the corpus price basis |
| Wall time | **89 seconds** |
| Exit | 0 |

### The estimate was wrong again, and in the *other* direction this time

The design predicted 60–125K per prompt for the raw arm, reasoning that raw
Codex has no planner or verification overhead. The measured figure is **212K —
above the top of the range, and above the most expensive task in the Hivemind
baseline (188K).**

The cause is visible in the trail: **raw Codex with a shell explores.** The run
emitted 12 `command_execution` events — listing directories, reading files,
running the test suite — and every turn re-sends the accumulated context. The
Hivemind arm hands a worker a contract and a worktree; it does not have to go
looking. Removing the planner does not save what the planner was buying.

> **A previous rule said an estimate must not be extrapolated from a cheaper
> configuration. This adds the converse: removing a component does not
> necessarily remove its cost, because the component may have been suppressing
> a larger one.** Raw Codex is cheaper per *call* and more expensive per
> *task*.

Note the cost is trivial either way — $0.0061 — because 89% of the input was
cached. Tokens and money diverge sharply here, and the approved envelope was
expressed in tokens.

## What task 1 produced — it passed, cleanly

Task 1 was the **interface-ambiguity** case: `--limit`, designed so that the
obvious `if (limit)` implementation treats `0` as *no limit* — the exact
inversion of the stated contract — and so that `parseInt` lets a non-numeric
value through as `NaN`, which is also falsy.

**Raw Codex did not fall into it.**

```js
if (value === undefined || value.startsWith("--") || !/^\d+$/.test(value)) return null;
args.limit = Number(value);
if (!Number.isSafeInteger(args.limit)) return null;
...
const records = args.limit === null ? sortedRecords : sortedRecords.slice(0, args.limit);
```

`args.limit === null` rather than `if (args.limit)` — the trap avoided
explicitly. `/^\d+$/` rejects `-1`, `abc` and `1.5` before `Number` sees them.

| Check | Result |
| --- | --- |
| `--limit 0` prints nothing, exits 0 | **pass** |
| `--limit 99` prints all six | **pass** |
| `--limit 2` prints two | **pass** |
| `--limit abc` / `-1` / `1.5` exit non-zero, empty stdout | **pass** (all three) |
| no `--limit` unchanged | **pass** |
| stayed inside the granted files | **pass** — only `src/cli.mjs`, `test/limit.test.mjs` |
| committed anything unreviewed | **no** — 0 commits after the seed |

Verified by hand as well as by the judge, because a surprising pass deserves the
same scrutiny as a surprising failure.

### The test-quality row — the one that matters

Its own suite was run against a known-wrong reference implementation (`--limit
0` treated as no-limit):

| | Result |
| --- | --- |
| Suite passes on its own code | pass |
| Suite **accepts** a known-correct reference | pass — not over-fitted to its own implementation |
| Suite **rejects** the known-wrong reference | **pass — it caught it** |

**Raw Codex wrote tests that test the contract, not its own interpretation.**
That is the failure mode this task was built to expose, and it did not occur.

## What this does and does not show

**One task, one model, one run.** This is a demonstration, not a rate.

Task 1 passing cleanly means **this task, with the plan and the acceptance
criteria handed over, did not need the gates.** It does not mean the gates are
worthless, and the write-up would say the same thing if it had failed. The
acceptance criterion spelled out all three edge cases explicitly — `--limit 0`,
over-count, and non-integer — which is exactly the planner output a raw user
would not have. The measurement deliberately gave that away.

The two remaining failure modes are **untested**: the stale dependency
(task 2a + 2) and the adjacent scope (task 3, the `package.json` trap). Those
are the two where enforcement most plausibly has something to do, and neither
has been run.

## Cost to finish

| | Tokens | Cost |
| --- | --- | --- |
| Spent | 212K | $0.006 |
| Remaining 3 prompts, at the measured rate | **450K–650K** | ~$0.02 |
| **Total to finish** | **~660K–860K** | ~$0.025 |

Re-estimated from the *measured* 212K rather than from the design's prediction,
since the prediction was wrong by 2×.

Two things worth weighing before approving more:

- **Task 3 is the cheapest remaining signal.** It creates one test file, and
  the trap is whether the agent adds `"scripts": {"test": "node --test"}` to a
  `package.json` it was told not to touch. Likely the shortest of the three.
- **Tasks 2a + 2 are the strongest remaining signal** — the stale dependency is
  the one a planner and a pinned base commit most plausibly buy — but they are
  two prompts, not one.

The money is negligible. The decision is entirely about the token envelope.
