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

## Where the uncached tokens actually go (measured, 4 paid worker calls)

Captured 2026-08-24 by running four real Hivemind worker prompts through the
shipped invocation with only `--ephemeral` dropped, so codex would persist a
rollout. `--ephemeral` means "run without persisting session files to disk"; the
API request is identical either way, so this changes what is *observable*, not
what is sent.

| call | turns | Hivemind prompt | turn 1 uncached | turns 2+ | total uncached | mid-call misses |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 2,630 B | 11,868 | 7,557 | 19,425 | 0 |
| 2 | 9 | 2,851 B | 11,902 | 24,502 | 36,404 | 0 |
| 3 | 7 | 2,806 B | 21,887 | 5,743 | 27,630 | 0 |
| 4 | 6 | 3,159 B | 22,041 | 28,974 | 51,015 | 1 |

Average: **33,618 uncached per call**, of which **turn 1 is 16,924 (50%)**.
Hivemind's own prompt averages 2,861 B (715 tokens) — **2.1% of the uncached
total**.

The initial context of one call, byte for byte, in the order codex assembles it:

| block | bytes | whose |
|---|---:|---|
| session_meta | 18,535 | codex |
| **developer** (its own instructions) | **33,832** | codex |
| user `<recommended_plugins>` | 12,076 | codex |
| world_state | 22,645 | codex |
| turn_context | 2,591 | codex |
| **user — the Hivemind worker prompt** | **2,967** | **Hivemind** |

So roughly **92,600 bytes of harness-injected context against 2,967 bytes of
Hivemind's**, or 3.2%.

### What that makes addressable, and what it does not

- **Not addressable: the harness's own injection.** It is the bulk of turn 1, but
  the large blocks are codex's own instructions, its plugin list and its world
  state. No flag Hivemind passes removes them, and they already cache in part
  (turn 1 showed 9,984 of 21,852 already cached). This measurement is the reason
  `--include-directory` was NOT adopted: the injected bulk is not project
  directories that Hivemind could supply more cheaply, so the flag would add a
  per-harness argv branch without targeting the mass.
- **Not addressable: what the worker reads next.** Half the uncached total is
  turns 2+, which is the agent's own tool calls, their outputs (one single tool
  output was 10,891 B) and its reasoning. What it reads at turn N+1 depends on
  what it found at turn N, so it is unpredictable by construction and cannot be
  pre-cached.
- **Not addressable: mid-call cache misses.** 1 in 27 turns here; 2 in 12 turns
  in an older rollout, where they accounted for 17% of that sample's uncached
  total. They do not correlate with idle time (an 8.1 s gap missed while a 9.8 s
  gap hit) or with content, and on every miss exactly the same small prefix
  stayed cached. Provider-side.
- **Addressable: turn count.** Uncached scales with turns — 5 turns cost 19,425
  and 9 turns cost 36,404, roughly 2,000–3,500 per additional turn. Tighter task
  scope means fewer turns, and that is a contract-design lever rather than a
  cache lever. It is the only one of these with real headroom.
- **Addressable: instrumentation.** Hivemind records only aggregate usage per
  call, and `--ephemeral` suppresses the rollout, so per-turn cache behaviour is
  invisible in every shipped run. Everything in this section had to be bought
  with paid calls for that reason. Capturing per-turn counts would make it free
  from then on.

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
