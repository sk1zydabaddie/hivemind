# M8 Real Workspace E2E Attempt - 2026-07-31

## Scope

The run used `D:\Projects\hivemind-workspace-e2e-20260731`, a real scratch TypeScript release-note repository. Its repo-local configuration raised only this run's session ceiling to 650,000 tokens. The 150,000 per-call ceiling and Hivemind's global 500,000 session default were unchanged.

The workspace started from an already ratified project spec. The user-facing flow exercised here began at the Work prompt: real plan generation, grounding, lint, plan review, exact-hash ratification, and manager start.

## Prompt And Plan

The prompt requested exactly two sequential tasks:

1. Strict grouped release-note parsing/rendering plus unit tests.
2. CLI text/JSON formats plus end-to-end tests after task 1.

The real planner produced two grounded tasks. `T-001` was Medium because it changed ordinary source and tests. `T-002` was High because it changed the public CLI entry point configured as a higher-risk boundary. Both forbade `package.json`. Plan lint passed, and no task existed before ratification.

The planner startup reported:

```text
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
```

## Initial Result

Exact-hash ratification succeeded. The first manager call then returned seven actions in one proposal:

```text
create_task_contract
request_lease
check_write_intent
create_worktree
run_worker
submit_patch
analyze_patch
```

Core refused the proposal with:

```text
manager proposal must contain at most one next action so no paid proposal output is silently discarded
```

This was a correct fail-closed result, but it initially blocked the E2E before any task, lease, worktree, worker, inspector use, or merge. The scratch repository remained source-clean and had no canonical work state to clean up.

The manager startup also reported `approval: never` and `sandbox: read-only`.

## Repair And Resume

Core commit `95e25ce` made the zero-or-one-action rule explicit in both manager prompt modes, retained the parser guard, added a Work-tab retry through the existing `manager.start` dispatcher action, and refreshed inspection after failed actions so metered failures appear in spend.

The first retry attached to the still-live scratch daemon that predated the repair. That daemon retained the old prompt module in memory and returned the same invalid batch. The UI correctly advanced to `3 calls / 61.5K`, proving the spend-display repair. No task state was created. The daemon was then replaced only after `/health` proved its scratch-project identity and disk inspection proved there was no task, manager, lease, worktree, patch, or output state to orphan.

The retry against the replacement daemon produced one valid stored action: `create_task_contract` for `T-001`. The UI advanced to `4 calls / 81.9K` and exposed `Continue run`, proving that the repaired prompt works and the initial paid proposal is durably retained.

Continuation then failed with Windows socket timeout `10060`. The timeout was a symptom, not the root cause. The daemon processes `/workspace/action` inside its serialized mutation queue. `manager.continue` consumed the stored execution path far enough to call `routeMutatingAction()` for `create_task_contract`, which discovered the same live daemon and posted `/contract/create` back to itself. That nested request waited behind the outer queue holder while the outer request waited for the nested request. A live TCP snapshot showed daemon PID `32184` connected to its own port `56029`. After the client timeout, the manager session still had the proposal in `pending`, `executed_actions` was empty, and no contract, lease, worktree, worker, or patch existed. Retrying would duplicate risk while the queue remained deadlocked, so the run stopped without further paid calls.

This is a missing daemon-internal execution boundary, not a reason to extend the 30-second Rust action timeout. A longer timeout would only wait longer on the same self-deadlock. The loop was not redesigned during this test.

## Free Repair Before Resume

The daemon now provides a scoped in-process route transport while a queued handler is running. Manager actions still resolve the same registered daemon handlers and primitives, including the asynchronous `/run` job, but do not issue nested HTTP or queue behind themselves. A deterministic fake-worker regression drove the complete nine-action lifecycle through real `/workspace/action` requests and observed only the six outer requests.

Core daemons also capture and publish a deterministic compiled-build identity at startup. The desktop compares that identity before attach and before each action, so a live pre-fix daemon is surfaced instead of silently receiving another paid call. Missing or mismatched identity never causes the shell to start a second writer.

## Post-repair E2E Resume

The repaired dispatcher consumed the already-paid `create_task_contract` proposal and drove `T-001` through contract creation, lease, write intent, worktree creation, and a real Codex worker without nested HTTP. The worker ran for 121.032 seconds, changed only `src/release-notes.ts` and `test/release-notes.test.ts`, and passed all four scratch-repository tests. The manager then submitted and analyzed the patch, the deterministic scope gate accepted it, and the patch entered the integration queue.

The explicit project-check approval reached the real shadow-integration primitive. Integration then stopped at the deterministic floor with:

```text
base branch main not found
```

The scratch repository's checked-out branch is not named `main`, while its integration configuration expects `main`. The manager recorded `integrate_shadow` as consumed with `result_ok: false` and a Tier-3 hard stop. Per the bounded-run rule, no branch/config adaptation, retry, second worker, or additional paid call followed. `T-002` never started.

This proved the self-reentrancy repair under the real UI path and exposed a repository-assumption defect rather than a scratch-repository defect.

## Base-branch Repair And Completed Shadow Run

Project setup now records the checked-out symbolic `HEAD` branch in repo-local `config.base_branch`, and shadow integration verifies and uses that exact local branch ref. The scratch repository correctly recorded `master`. Setup fails closed when the branch cannot be resolved, and integration fails closed when the configured branch is missing or invalid. The audit found no production hardcoded remote name; remaining `HEAD` reads verify commit/worktree identity, while `hivemind/<task>` and `integration/<timestamp>` are Hivemind-owned branch names.

The stopped `integrate_shadow` action was recovered through the audited exact-action retry. Retry did not replay the old approval or spend: it re-presented the same durable action behind a fresh pending-action identity and current-state hash. After explicit approval, `T-001` passed the full scratch suite with 4/4 tests.

The same UI session then drove `T-002` through contract creation, lease, write intent, detached worktree, explicit worker approval, a real Codex worker, patch submission, deterministic scope analysis, integration queueing, and explicit project-check approval. The worker ran for 124.161 seconds, changed only `src/cli.ts` and `test/cli.test.ts`, exited successfully, and reported 50,249 provider tokens. The final shadow tree applied both accepted patches and passed 7/7 tests. Durable evidence includes `task.completed`, `patch.accepted`, `verification.completed`, and `integration.passed` for both tasks.

The run did **not** merge those patches into the scratch repository's `master` branch. `integrateShadow()` intentionally creates a throwaway `integration/<timestamp>` branch, verifies it, records `integration.passed`, and deletes the branch. `master` remains at seed commit `e440496`, and its source tree still has the original 2/2 tests. At capture time the UI labeled this state `Merged` / `Reached merge`, which overstated the implemented contract; the subsequent truthfulness repair now presents it as `Verified` / `Ready to adopt`. Automatic adoption into the target branch remains outside the current integration primitive; the screenshots document successful shadow verification, not a repository merge.

## Spend

| Call | Provider tokens | Self-measured tokens | Wall time |
| --- | ---: | ---: | ---: |
| Planner | 19,561 | 2,276 | 24.356 s |
| Manager, original batched proposal | 20,959 | 3,733 | 25.088 s |
| Manager, stale-daemon retry | 20,937 | 3,717 | included below |
| Manager, repaired single-action proposal | 20,447 | 3,647 | included below |
| Total | 81,904 | 13,373 | 84.544 s |

Provider-reported usage was the accounting source. Provider usage was 6.12 times the self-measured estimate. No worker call had occurred at that checkpoint.

At the terminal shadow-integration point, the replacement daemon ledger contains 409,795 provider tokens across 23 requests: planner 19,561, manager 309,879 across 20 requests, and workers 80,355 across 2 requests. Self-measured usage for those calls is 133,649 tokens. The earlier stale-daemon manager call cost another 20,937 provider tokens and one request but is absent from the replacement daemon ledger. Actual paid spend for the complete attempt is therefore **430,732 provider tokens across 24 calls**, within the deliberate one-off 650,000-token session ceiling and with no call over the 150,000 per-call ceiling.

The final History screen displays 23 calls / 409.8K because it reads the current daemon ledger. The cross-daemon total is one call and 20,937 tokens higher. This continuity gap remains recorded as a known accounting limitation rather than being hidden.

Before `95e25ce`, the UI still showed `1 call / 19.6K` after the failed manager request had been durably metered. After the repair, it showed `2 calls / 40.5K`, then advanced after each retry. The defect is closed.

## Experience Findings

- The real plan review was readable and useful. Scopes, read boundaries, dependency order, mixed risk, and concrete completion criteria were visible without opening JSON; a bad file boundary or wrong dependency would have been catchable there.
- The review used only the left half of the takeover at this two-task size, leaving substantial dead space, but the information itself was well prioritized.
- The non-aggressive takeover worked: the plan first appeared as a banner and attention item, and nothing started until the explicit review action.
- The most-used surfaces were the project selector, bottom prompt, spend indicator, plan-ready banner, attention card, plan review, activity stream, and final status message.
- `Later`, Routing, Draft comparisons, the empty task inspector, and most of the run-summary strip supplied no value before execution. They read as persistent structure waiting for data rather than tools used in this run.
- The Swarm inspector was useful during real execution: it located the active `T-002` worker, showed its changed files, startup mode, duration, and live output without leaving the app. The small two-task tree itself was mainly orientation rather than a decision surface.
- The new Retry control was obvious and preserved the exact ratified plan. Its first use also exposed a lifecycle fact the UI did not communicate: attaching to a daemon started before a Core update leaves that process on old code.
- The continuation timeout message is raw infrastructure text and is too long for the prompt dock. More importantly, `Continue run` looked safely retryable even though the daemon mutation queue was still occupied; the UI has no distinct "operation may still be running" state.
- When the daemon was deliberately restarted, the disconnected header leaked the `\\?\` long-path prefix again. The normal connected header remains clean, so path sanitization is incomplete specifically in the connection-error surface.
- The worker inspector was useful: it made the real provider startup mode, live output, changed files, and eventual patch visible without leaving the workspace. Raw ANSI escapes and the complete uncollapsed transcript made it harder to scan than necessary.
- The Swarm tree accurately oriented the two sequential tasks, but for this small run it was mostly empty canvas. The inspector earned its space; the tree itself did not materially affect a decision.
- After the worker finished, the selected task continued to read `Working` until the manager advanced the patch pipeline. That label conflates worker execution with post-worker processing.
- The merge approval surfaced manager-internal wording (`integrate_shadow` and instructions to the orchestrator) instead of a human explanation.
- The initial integration rejection disappeared from the attention queue after approval and was not presented as a clear recovery card. The repair now projects that durable reason into the attention and task cards and offers exact-action retry.
- The 30-second desktop action timeout still presents successful long-running manager work as a raw socket failure while the daemon completes durably. This made the operator guess whether clicking again was safe.
- The activity stream contains many generic `Project state was updated` rows. They crowd out the small number of events that changed an operator decision.
- The prompt/continuation dock can fall below the visible viewport when selected-task output is tall; keyboard navigation was needed once during the run.
- The worker output is diagnostically complete but visually noisy: ANSI escapes, provider startup telemetry, the full prompt, and long raw transcript text are uncollapsed.
- History showed both tasks and the cumulative spend, but still marked the run `Active` after terminal shadow integration. No explicit session-complete event currently closes that presentation.
- The largest semantic UI defect was `Merged` / `Reached merge`: the user saw a completed merge while the canonical target branch remained unchanged. The projection and every primary surface now say `Verified`, `Checks passed`, or `Ready to adopt` unless and until a separate approved adoption primitive exists.

### Panels Actually Used

- Used: project selector, prompt, spend meter, plan-ready banner, plan review, attention card, task cards, activity stream, Swarm tree for orientation, Swarm inspector/live output, explicit worker and project-check approvals, and History.
- Low value or noise in this run: empty Later queue, empty routing and draft-comparison panels, repetitive activity rows, and large unused tree canvas for a two-task sequence.
- Missing control reached for: an honest final adoption/merge action. None exists because the current integration contract stops after the disposable shadow check.

## Screenshots

- `01-plan-ready.jpg`: linted tentative plan awaiting review; nothing started.
- `02-plan-review.jpg`: real two-task review with Medium/High tiers, scopes, dependency, acceptance, and exact-hash approval.
- `03-manager-proposal-refused.jpg`: ratified plan followed by the fail-closed manager-proposal error.
- `04-retry-and-correct-spend.jpg`: existing ratification preserved, failed call visible in spend, and audited retry available.
- `05-stale-daemon-second-refusal.jpg`: retry against the pre-repair daemon, with the second paid failure included in spend.
- `06-manager-continue-deadlock.jpg`: repaired single-action proposal stored, followed by the daemon self-routing timeout on continuation.
- `07-worker-completed-output.png`: real Codex worker completed, changed two scoped files, and streamed output into the inspector.
- `08-swarm-after-worker.png`: real two-task sequential swarm after the first worker completed.
- `09-swarm-worker-inspector.png`: selected worker with live output and changed-file detail.
- `10-project-check-approval.png`: accepted patch awaiting explicit shadow-verification approval.
- `11-integration-rejected.png`: workspace immediately after the Tier-3 `base branch main not found` rejection.
- `07-integration-failure-surfaced.png`: repaired attention and task-card presentation of the durable branch failure.
- `08-integration-retry-approval.png`: exact-action retry awaiting a fresh explicit approval.
- `09-t001-shadow-verified.png`: `T-001` after successful shadow verification; the screenshot's old `Merged` label is retained as evidence of the defect that prompted the truthfulness repair.
- `10-t002-worker-approval.png`: `T-002` awaiting explicit real-worker approval.
- `11-t002-swarm-live.png`: real `T-002` worker active in the Swarm tree and inspector.
- `12-t002-integration-approval.png`: both accepted patches awaiting explicit final project-check approval.
- `13-final-work-shadow-integrated.png`: terminal Work view after the two-patch shadow suite passed 7/7; target `master` remained unchanged.
- `14-history-real-run.png`: final History view with both tasks, current-daemon spend, and the still-Active / Reached-merge presentation findings.
