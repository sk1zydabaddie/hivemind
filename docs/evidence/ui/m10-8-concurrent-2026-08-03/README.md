# M10.8 Real Concurrent Workspace Demonstration

Date: 2026-08-03

## Result

PASS. A fresh scratch TypeScript project ran two independent High-tier tasks through the installed Auto workspace. Setup was serialized and two confined `gpt-5.6-sol` worker processes overlapped. Both patches passed their existing scope gates, independent contract validity checks, and one exact-survivor shadow verification. Auto stopped at adoption; a typed UI authorization then moved the actual `master` ref to the verified candidate.

The first planning attempt failed closed before creating any plan or task because the planner consumed Codex JSONL transport rather than the adapter's normalized model output. That paid call is retained as evidence. Commit `ba26dfa` repaired every raw transport consumer, and the rebuilt shell completed the run.

## Timing

| Lane | Process start | Process stop | Duration |
|---|---:|---:|---:|
| T-001 slugify | 22:48:02.115Z | 22:48:58.694Z | 56.579s |
| T-002 duration | 22:48:03.232Z | 22:49:39.546Z | 96.314s |

- Actual overlap: 55.462s.
- Concurrent worker window: 97.431s.
- Same-run serial equivalent: 152.893s.
- Wall-time reduction: 55.462s (36.3%); speedup 1.57x.
- Setup evidence is ordered: T-001 reached `task.started` at 22:48:01.740Z; T-002 setup began at 22:48:01.802Z. Only provider worker processes overlapped.
- Scheduler evidence: `effective_concurrency=2`, `budget_available_reservations=2`, `binding_limit=ready_count`. Budget did not limit the wave. Because exactly two tasks were ready and the cap was two, the run does not distinguish ready-count and cap as the narrower constraint.

## Metering

| Call | Input | Cached input | Uncached input | Output | Reasoning subset | Total | Wall time |
|---|---:|---:|---:|---:|---:|---:|---:|
| Refused planner discovery | 20,415 | 9,984 | 10,431 | 1,035 | 342 | 21,450 | 28.121s |
| Successful planner | 20,842 | 9,984 | 10,858 | 1,236 | 489 | 22,078 | 29.280s |
| T-001 Sol worker | 130,248 | 114,176 | 16,072 | 2,027 | 977 | 132,275 | 56.588s |
| T-002 Sol worker | 109,703 | 93,952 | 15,751 | 3,806 | 1,972 | 113,509 | 96.316s |

- Successful run: 3 calls, 267,862 provider tokens.
- Entire M10.8 attempt including the refused planning discovery: 4 calls, 289,312 provider tokens.
- Worker cache rate: 208,128 / 239,951 input tokens (86.74%).
- Successful-run cache rate: 218,112 / 260,793 input tokens (83.64%).
- Price-snapshot cost at Sol $5/M uncached input, $0.50/M cached input, and $30/M output: $0.534531 successful run; $0.622728 including the refused discovery.
- Concurrency adds no call or token multiplier: the same two worker calls total 245,784 tokens whether their windows overlap or execute serially.

## Deterministic Evidence

- Both leases were granted for disjoint files: T-001 owned `src/slugify.ts` and `test/slugify.test.ts`; T-002 owned `src/duration.ts` and `test/duration.test.ts`.
- Both 250K reservations were simultaneously active and bound to distinct task/process identities.
- Exact survivor set: `V-ec02bcec-e3af-482e-8d3f-8dbba291581e`, tasks `T-001,T-002`.
- Shadow checks: both repository-authored validity checks plus `npm test`; 15/15 tests passed.
- Event trail: 52 complete newline-terminated JSONL records, 52 parseable, zero torn lines.
- Pre-adoption ref: `253176aede883a1dcfe485d052501bfe998c8bad`.
- Adopted ref: `c14bcd9c06a57e0badc81c67b0ec483527a3b8d3`.
- Adopted tree: `8ab54e71894f974291f0480afd9d0213256e6ff6`.
- Post-adoption repository: one `master` branch, one root worktree, zero task worktrees, zero active reservations, and no live worker process.
- The one-off 250K per-call / 650K session limits were restored to 150K / 500K after adoption.

## Experience

- Human decision moments: submit the prompt, then review/authorize the exact adoption. The adoption decision used two explicit UI clicks (`Review`, then `Merge exact set`); Auto demanded no attention before that boundary and emitted no false stall alert.
- The adoption screen was sufficient on its own: it named the two tasks, exact four files, base ref, target branch, and exposed the exact patch.
- Swarm made sibling identity, status, files, and per-lane output clear. With only two workers it was useful orientation, not essential navigation.
- The first usable Work capture occurred immediately after the two provider processes exited. Work briefly retained a `2 tasks, working` run banner while task cards were between worker completion and verification; it converged to Ready to adopt without intervention. This is recorded rather than reconstructed as a live-overlap image.
- History correctly shows the successful run's 3 calls/267,862 tokens and complete outcome. It does not include the earlier refused planning call in that run card because the call belonged to a separate failed planning session; the project ledger contains the full spend.

## Screenshots

- `00-project-select.png`: initial project-selection state before the first attempt.
- `02-planning.png`: first paid planning attempt before the JSONL boundary refusal.
- `04-rebuilt-shell.png`: rebuilt shell correctly refusing the stale daemon build identity.
- `05-current-build-ready.png`: rebuilt shell and matching daemon ready.
- `06-retry-planning.png`: paid planning retry in progress.
- `07-two-workers-work.png`: first usable Work state after the concurrent worker processes exited.
- `08-two-workers-swarm.png`: both sibling lanes shown together.
- `09-worker-inspector.png`: selected worker files and isolated output.
- `10-ready-to-adopt.png`: Auto stopped at adoption.
- `11-adoption-authorization.png`: exact-set typed authorization.
- `12-post-adoption.png`: Merged only after `adoption.completed`.
- `13-history-complete.png`: completed run and successful-session spend.
