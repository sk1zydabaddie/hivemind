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

## Result

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

This was a correct fail-closed result, but it blocked the E2E before any task, lease, worktree, worker, inspector use, or merge. No retry was made. The scratch repository remained source-clean and had no canonical work state to clean up.

The manager startup also reported `approval: never` and `sandbox: read-only`.

## Spend

| Call | Provider tokens | Self-measured tokens | Wall time |
| --- | ---: | ---: | ---: |
| Planner | 19,561 | 2,276 | 24.356 s |
| Manager | 20,959 | 3,733 | 25.088 s |
| Total | 40,520 | 6,009 | 49.444 s |

Provider-reported usage was the accounting source. Provider usage was 6.74 times the self-measured estimate.

The UI still showed `1 call / 19.6K` after the failed manager request had been durably metered. This is a separate spend-inspectability defect: failed-before-session manager calls are omitted from the current workspace spend projection.

## Experience Findings

- The real plan review was readable and useful. Scopes, read boundaries, dependency order, mixed risk, and concrete completion criteria were visible without opening JSON; a bad file boundary or wrong dependency would have been catchable there.
- The review used only the left half of the takeover at this two-task size, leaving substantial dead space, but the information itself was well prioritized.
- The non-aggressive takeover worked: the plan first appeared as a banner and attention item, and nothing started until the explicit review action.
- The most-used surfaces were the project selector, bottom prompt, spend indicator, plan-ready banner, attention card, plan review, activity stream, and final status message.
- `Later`, Routing, Draft comparisons, the empty task inspector, and most of the run-summary strip supplied no value before execution. They read as persistent structure waiting for data rather than tools used in this run.
- Swarm usefulness, live worker output, task controls, merge presentation, and post-run History could not be judged because the manager proposal was refused before task creation.
- The status message explained the internal one-action invariant rather than giving the user a recovery path. There was no visible retry or revise-manager-proposal control, which is where the flow stranded.

## Screenshots

- `01-plan-ready.jpg`: linted tentative plan awaiting review; nothing started.
- `02-plan-review.jpg`: real two-task review with Medium/High tiers, scopes, dependency, acceptance, and exact-hash approval.
- `03-manager-proposal-refused.jpg`: ratified plan followed by the fail-closed manager-proposal error.
