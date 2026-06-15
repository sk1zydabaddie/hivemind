# Hivemind AI Build Progress

This file tracks implementation progress against `Hivemind_Build_Tasks.md`.
It is the project-local build ledger for Hivemind AI.

## Current State

- Current milestone: M0 - Tracer bullet
- Last completed subtask: M0.5 - `hivemind run` end-to-end diff capture [GATE]
- Next subtask: M1.1 - Apply-to-base changeset resolver (requires user approval to start M1)
- Current branch: `master`
- Latest completed commit: `4fd7f32` - `fix: bound headless adapter runs`
- Paid AI/provider calls run: approved live Codex and Claude Code acceptance on 2026-06-15. Codex launched in disposable task worktrees. First Codex attempt returned exit code 1 because the default `gpt-5.3-codex` model was not supported by the active ChatGPT account. After updating the adapter profile to `gpt-5.5`, Codex used 6,130 tokens but could not write under a read-only inner sandbox. After the approved writable Codex profile update and adapter timeout containment, Codex used 8,674 tokens and produced a correct one-file `README.md` diff. The first Claude Code run returned exit code 1 with `Not logged in - Please run /login`; after CLI login, Claude Code rerun returned `tool_exit: 0`, `changed_files: 1`, and produced a correct one-file `README.md` diff.

## Completed Subtasks

| Subtask | Status | Commit | What changed | Validation |
| --- | --- | --- | --- | --- |
| M0.1 - `hivemind init` project scaffold | Complete | `422486b` | Added TypeScript/Node CLI scaffold and `hivemind init`; creates `.hivemind/`, required subdirs, empty `log/events.jsonl`, and atomic `config.json`; idempotent and fails outside git. | `npm run typecheck`; `npm test` with 4 tests; cleanup scans clean. |
| M0.2 - Task-contract format + loader | Complete | `9af793d` | Added `TaskContract` type, contract loading from `.hivemind/tasks/<id>.contract.json`, validation/normalization, and `hivemind contract <id> --validate`. | `npm run typecheck`; `npm test` with 11 tests; cleanup scans clean except expected deferred-scope references. |
| M0.3 - `hivemind worktree <id>` create/teardown | Complete | `e5f1115` | Added task worktree create/remove helper and CLI command; creates branch `hivemind/<id>` from contract `base_commit`; remove cleans up worktree and branch. | `npm run typecheck`; `npm test` with 16 tests; cleanup scans clean except roadmap references. |
| M0.4 - Headless adapter + Adapter Profile | Complete | `7f939f1` | Added internal `invokeAgent(repoRoot, taskId, tool)`, adapter profile loading/validation, contract-derived prompts, subprocess execution in the task worktree, `agent.log` stdout/stderr/exit-code capture, a dated Codex profile, and fake-adapter tests. Live Codex acceptance launched through the profile, ran in `.hivemind/worktrees/T-001`, wrote `agent.log`, and returned exit code 1 due unsupported default model/account pairing. | `codex exec --help`; live `invokeAgent` with Codex profile; `npm run typecheck`; `npm test` with 25 tests; cleanup scans clean except expected roadmap references. |
| M0.5 - `hivemind run` end-to-end diff capture [GATE] | Complete | pending | Added `hivemind run <id> --tool <tool>` composing contract validation, worktree creation, headless adapter invocation, deterministic diff capture, and atomic `.hivemind/patches/<id>/diff.patch` writes. Captures no-change runs, non-zero tool exits, timed-out tool exits, and untracked worker-created files while excluding `agent.log`. Added bounded adapter `timeout_ms` support so wedged workers are terminated, logged as `tool_exit: 124`, and still allow diff capture. Added a Claude Code adapter profile. Updated the Codex adapter profile to explicit `gpt-5.5`, approved writable invocation flags, and a 120000ms timeout. | `npm run typecheck`; `npm test` with 34 tests; `git diff --check`. Codex real-tool gate passed in a disposable repo with `tool_exit: 0`, `changed_files: 1`, and a correct `README.md` diff. Claude Code real-tool gate passed after CLI login in a disposable repo with `tool_exit: 0`, `changed_files: 1`, and a correct `README.md` diff. |

## M0 - Tracer Bullet

| Subtask | Status | Notes |
| --- | --- | --- |
| M0.1 - `hivemind init` project scaffold | Complete | Committed in `422486b`. |
| M0.2 - Task-contract format + loader | Complete | Committed in `9af793d`. |
| M0.3 - `hivemind worktree <id>` create/teardown | Complete | Committed in `e5f1115`. Must not be treated as agent invocation, lease, or gate support. |
| M0.4 - Headless adapter + Adapter Profile | Complete | Implementation checkpoint in `1861486`; completed in `7f939f1`. Codex launched through the dated profile and returned its exit code; tool exited 1 due unsupported default model/account pairing. |
| M0.5 - `hivemind run` end-to-end diff capture [GATE] | Complete | No-paid implementation in `301d725`; real-tool reliability checkpoint in `4fd7f32`; full gate completion pending commit. Codex and Claude Code both produced correct one-file `README.md` diffs in disposable repos. Do not start M1 until the user explicitly approves moving to the next major phase. |

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
