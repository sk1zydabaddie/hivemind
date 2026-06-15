# Hivemind AI Build Progress

This file tracks implementation progress against `Hivemind_Build_Tasks.md`.
It is the project-local build ledger for Hivemind AI.

## Current State

- Current milestone: M0 - Tracer bullet
- Last completed subtask: M0.3 - `hivemind worktree <id>` create/teardown
- Active subtask: M0.4 - Headless adapter + Adapter Profile; implementation checkpoint is no-paid validated, live Codex acceptance pending explicit approval
- Next subtask: M0.4 live Codex acceptance
- Current branch: `master`
- Latest completed commit: `23e7556` - `docs: record m0.3 progress`
- Latest implementation checkpoint: pending commit - M0.4 adapter module/profile/tests
- Paid AI/provider calls run: none

## Completed Subtasks

| Subtask | Status | Commit | What changed | Validation |
| --- | --- | --- | --- | --- |
| M0.1 - `hivemind init` project scaffold | Complete | `422486b` | Added TypeScript/Node CLI scaffold and `hivemind init`; creates `.hivemind/`, required subdirs, empty `log/events.jsonl`, and atomic `config.json`; idempotent and fails outside git. | `npm run typecheck`; `npm test` with 4 tests; cleanup scans clean. |
| M0.2 - Task-contract format + loader | Complete | `9af793d` | Added `TaskContract` type, contract loading from `.hivemind/tasks/<id>.contract.json`, validation/normalization, and `hivemind contract <id> --validate`. | `npm run typecheck`; `npm test` with 11 tests; cleanup scans clean except expected deferred-scope references. |
| M0.3 - `hivemind worktree <id>` create/teardown | Complete | `e5f1115` | Added task worktree create/remove helper and CLI command; creates branch `hivemind/<id>` from contract `base_commit`; remove cleans up worktree and branch. | `npm run typecheck`; `npm test` with 16 tests; cleanup scans clean except roadmap references. |

## M0 - Tracer Bullet

| Subtask | Status | Notes |
| --- | --- | --- |
| M0.1 - `hivemind init` project scaffold | Complete | Committed in `422486b`. |
| M0.2 - Task-contract format + loader | Complete | Committed in `9af793d`. |
| M0.3 - `hivemind worktree <id>` create/teardown | Complete | Committed in `e5f1115`. Must not be treated as agent invocation, lease, or gate support. |
| M0.4 - Headless adapter + Adapter Profile | Ready for live acceptance | Implementation checkpoint no-paid validated with fake adapters; real Codex acceptance pending explicit approval because it may consume provider quota. Must keep volatile tool flags in adapter profile data. |
| M0.5 - `hivemind run` end-to-end diff capture [GATE] | Not started | Requires M0.2-M0.4. Must not implement scope gate or leases. |

## M1 - The Gate, Airtight

| Subtask | Status | Notes |
| --- | --- | --- |
| M1.1 - Apply-to-base changeset resolver | Not started | No dogfooding until M1.5 passes. |
| M1.2 - Path canonicalization + repo-root confinement | Not started | Pure utility. |
| M1.3 - Operation-decision table | Not started | Must implement spec table verbatim. |
| M1.4 - Gate assembly + fail-closed + reason | Not started | Reject wins over escalate wins over accept. |
| M1.5 - Adversarial corpus harness + fixtures [GATE] | Not started | Must reject named adversarial fixtures before M3. |
| M1.6 - `hivemind analyze <id>` CLI wiring | Not started | Runs gate over submitted bundle. |

## M2 - The MVP

| Subtask | Status | Notes |
| --- | --- | --- |
| M2.1 - Lease store + disjoint-grant check | Not started | File-level leases only. |
| M2.2 - Read-only flagging of non-leased files | Not started | Preventive only, not a guarantee. |
| M2.3 - Write-intent gate | Not started | Validate intent against granted lease before editing. |
| M2.4 - `hivemind submit` patch bundle assembly | Not started | Produce exactly the 7-file patch bundle. |
| M2.5 - `hivemind integrate --shadow` | Not started | Shadow branch only; never merge to main. |
| M2.6 - Two-task parallel demo + `hivemind status` [GATE] | Not started | This is the MVP gate. |
| M2.7 - Append-only Tier-1 event log | Not started | JSONL evidence only, no canon. |

## M3 - Dogfood

| Subtask | Status | Notes |
| --- | --- | --- |
| M3.1 - Self-protection workflow | Not started | Requires M1.5/M1.6 gate green. |
| Ongoing - Build later features through the harness | Not started | Begins after M3.1. |

## M4 - Daemon + MCP + Resource Baseline

| Subtask | Status | Notes |
| --- | --- | --- |
| M4.1 - `hivemind daemon` single-writer state owner | Not started | Requires M2 complete. |
| M4.2 - SQLite derived cache | Not started | Rebuildable cache only. |
| M4.3 - MCP server scaffold + transports | Not started | Must call daemon for state changes. |
| M4.4 - MCP tools: task/worktree/patch/status | Not started | No tool can bypass gate. |
| M4.5 - Quota ledger | Not started | Self-measured primary signal. |
| M4.6 - Pooling + tier-capped routing + ceilings | Not started | Critical tasks never downgraded below tier floor. |
| M4.7 - Prompt-cache layered prefix + read cache + metering | Not started | Exact-hash reuse for write-influencing context. |

## M5 - The Orchestrator

| Subtask | Status | Notes |
| --- | --- | --- |
| M5.1 - Spec artifact + ratification gate | Not started | No planning while spec is draft. |
| M5.2 - Discovery & ideation loop + self-critique | Not started | Ratification requires user sign-off. |
| M5.3 - Manager-agent loop + manager chat | Not started | Every mutation through deterministic tools/gates. |
| M5.4 - Planning loop | Not started | Tentative scopes only until grounded/linted. |
| M5.5 - Grounding | Not started | Verify existence and freshness before lease. |
| M5.6 - Plan-lint | Not started | Deterministic plan checks. |
| M5.7 - Scout role + context-pack assembly | Not started | Reusable context pack. |
| M5.8 - Thrash to re-plan convergence | Not started | Must terminate in blocked/escalation on budget exhaustion. |

## M6 - Real-Time + Recovery + Context

| Subtask | Status | Notes |
| --- | --- | --- |
| M6.1 - Event bus + streamed worker logs | Not started | Requires M2.7 and M4.1. |
| M6.2 - Live task board + agent monitor | Not started | Read-only daemon view. |
| M6.3 - Redirect-first correction loop | Not started | Pause/cancel last resort. |
| M6.4 - Task checkpoint/snapshot | Not started | Provider-neutral state. |
| M6.5 - Quota-wall recovery | Not started | Predictive and reactive recovery. |
| M6.6 - Context budget + working-set + orchestrator re-hydrate | Not started | Re-read authoritative state from disk. |
| M6.7 - Partial-failure degradation | Not started | One failed worker must not collapse a run. |

## M7 - Depth + Learning

| Subtask | Status | Notes |
| --- | --- | --- |
| M7.1 - Symbol-level graph | Not started | Tree-sitter graph artifact. |
| M7.2 - Closure-coverage advisory check | Not started | Advisory only, never blocks. |
| M7.3 - Two-tier memory | Not started | Log to canon only by human review. |
| M7.4 - Dreaming/consolidation worker | Not started | Proposals only. |
| M7.5 - Learned routing policy | Not started | Tier cap still overrides. |
| M7.6 - Oracle-strengthening | Not started | High/Critical cannot integrate on weak oracle. |
| M7.7 - Value-gated quality | Not started | Extra spend only where gated. |
| M7.8 - Verification learns which checks matter | Not started | Fall back to full suite when uncertain. |

## Update Rules

- Update this file after each committed Hivemind subtask.
- Record the commit hash, validation commands, paid-call status, and the next subtask.
- Do not mark a gate complete until its exact acceptance test has passed.
- Do not start the next major phase without explicit user approval.
