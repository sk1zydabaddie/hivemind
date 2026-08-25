# Cache economics: the number that is actually true

Measured on this machine from real runs. Every figure here traces to a captured
record; nothing is projected. Re-measure before quoting it elsewhere.

## The claim worth making

> **Hivemind spends about 17,600 uncached input tokens per completed task.**

Measured across 60 real worker attempts (`.hivemind/log/corpus-*-repetition.stdout.json`,
`cache_economics` blocks): mean 17,604, median 15,640, at 1.00 worker calls per
task and 0 revisions in that corpus.

That is the claim to make instead of a cache hit rate, because a hit rate is a
ratio and the bill is in tokens.

## Why a hit rate is the wrong number

A hit rate has a denominator you control. Inflate the prompt and the percentage
improves while the cost rises. Our own calls show it:

| | n | avg call input | avg uncached |
|---|---:|---:|---:|
| calls under 85% cached | 34 | 93,782 | 17,637 |
| calls at or over 88% cached | 8 | **197,217** | **19,937** |

The better-looking group has **2.1x the input and 13% more uncached tokens**.
Correlation between call size and hit rate: **+0.46**.

So a harness reporting 97% is not necessarily cheaper. At our uncached volume,
*reporting* 97% would require a call of **587,000 tokens** — roughly five times
our absolute cost per task. The percentage cannot distinguish "does less
uncached work" from "sends a much larger prompt", which is exactly why it should
not be the headline.

| reported hit rate | call size implied at our uncached volume |
|---|---:|
| 90% | 176,000 tokens |
| 95% | 352,000 tokens |
| 97% | 587,000 tokens |
| 99% | 1,760,000 tokens |

## Where the tokens actually are

Averages over 60 worker attempts:

| | tokens | share |
|---|---:|---:|
| call input | 116,061 | 100% |
| cached | 98,457 | 84.8% |
| uncached | 17,604 | 15.2% |
| **Hivemind's own prompt** | **1,239** | **1.07% of the call** |

Hivemind's entire worker prompt is **7.0% of the uncached portion**. Corroborated
two ways: direct assembly of real worker prompts (658–3,342 tokens) and the
runtime's own `self_measured_tokens`.

The consequence is counter-intuitive and worth stating plainly: **the worker gap
is not addressable by anything Hivemind puts in the prompt.** The manager's was —
its prompt was roughly the whole of its uncached portion (~15,100 tokens of
prompt against ~14,058 uncached). For workers the ratio is inverted.

Per-provider, same corpus and ledgers:

| role / provider | n | avg input | cached | uncached per call |
|---|---:|---:|---:|---:|
| codex-terra | 44 | 111,344 | 86.1% | 15,437 |
| codex-luna | 36 | 115,854 | 83.2% | 19,442 |
| **worker-grok-build** | 20 | 110,522 | **38.8%** | **67,616** |

Provider choice moves this number roughly 4x. No prompt-ordering change comes
close to that.

## A line of work that is closed

**Shared cited-file contents across tasks.** The idea: two tasks whose scopes
overlap embed the same file contents, byte-identical, and pay for both.

It is real. Measured:

| run | duplicated bytes |
|---|---:|
| hivemind-e2e (4 tasks) | 2,496 B (`src/capitalize.js` x4, `test/capitalize.test.js` x4) |
| Installed E2E 26.821.453 (3 tasks) | 1,650 B (`package.json` x3, `scripts/serve.mjs` x2) |
| m10-8 concurrency (2 tasks) | 0 B (disjoint scopes) |

It is also **too small to build for**: 2,496 B is 624 tokens across an entire
four-task run, against 4 x 17,604 = 70,416 uncached tokens for that run. **0.9%.**

Recorded so nobody re-derives it. Two details that matter if it is ever
revisited:

- The duplicated blocks come from the FALLBACK path, not from a context pack.
  No project on this machine has ever written a `context-pack` file, so
  `loadContextPackForContract` returns null in every real run and
  `taskContextReadPaths` (allowed_files + read_only_files) supplies the contents.
  The blocks are labelled `Cached read <path>`; the context-pack path would
  label them `Reused cached read <path>`.
- Ordering compounds it: the shared blocks sit AFTER the per-task contract
  section, so a prefix cache can never reach them. Shared leading bytes across
  tasks measured 368 B (two runs) and 877 B (one run) — in each case the declared
  `shared_prefix` plus about 34 bytes, and nothing more.

The larger part of the uncached portion is what the harness does with its own
tools inside the call: files it reads for itself, its reasoning, and turns
accumulating within one invocation. Hivemind does not assemble any of it, and a
worker's next read is not knowable in advance, so it cannot be pre-cached.
Quantifying that split has not been measured here and should not be quoted until
it is.

## AGENTS.md, for completeness

It sits at the top of the worker prompt's stable prefix. Measured: the shared
prefix is 334 bytes with no AGENTS.md and 7,050 bytes with a 6,981-byte one, and
a run that had one showed an 877-byte shared prefix against 368 bytes for runs
that did not. It caches, so it is cheap — its ceiling is set by readability
rather than by cost. See `src/agents-file.ts`.
