# Hivemind AI Build Progress

This file tracks implementation progress against `Hivemind_Build_Tasks.md`.
It is the project-local build ledger for Hivemind AI.

## Current State

- Current milestone: M2 - The MVP
- Last completed subtask: M2.3 - Write-intent gate
- Next subtask: M2.4 - `hivemind submit` patch bundle assembly
- Current branch: `master`
- Latest completed implementation commit: `d45b190` - `feat: add write-intent gate`
- Latest M0.5 gate completion commit: `8a9786c` - `docs: complete m0.5 real-tool gate`
- Paid AI/provider calls run: none for M2.3. Previous approved live Codex and Claude Code acceptance ran on 2026-06-15. Codex launched in disposable task worktrees. First Codex attempt returned exit code 1 because the default `gpt-5.3-codex` model was not supported by the active ChatGPT account. After updating the adapter profile to `gpt-5.5`, Codex used 6,130 tokens but could not write under a read-only inner sandbox. After the approved writable Codex profile update and adapter timeout containment, Codex used 8,674 tokens and produced a correct one-file `README.md` diff. The first Claude Code run returned exit code 1 with `Not logged in - Please run /login`; after CLI login, Claude Code rerun returned `tool_exit: 0`, `changed_files: 1`, and produced a correct one-file `README.md` diff.

## Pre-M1 Hardening Checkpoint

| Checkpoint | Status | Commit | What changed | Validation |
| --- | --- | --- | --- | --- |
| Pre-M1 comprehensive audit hardening | Complete | `d8104e7` | Fixed the package bin to point at the emitted CLI; added shared task-id validation and contract/requested-id matching; made contract and adapter profile JSON tolerate UTF-8 BOMs; made existing worktree reuse fail closed when branch or `HEAD` does not match the contract base; added explicit `--allow-dangerous-adapter` opt-in for provider profiles containing bypass flags; added regression coverage for each audited fragility. No M1 gate logic was started. | `npm run typecheck`; `npm test` with 45 tests; `git diff --check`; cleanup/static scans for stale bin path, raw task-id joins, TODO-style markers, and dangerous adapter policy; no-paid disposable CLI probe for package bin, path traversal rejection, stale worktree rejection, and dangerous adapter gating. |

## Pre-M2 Hardening Checkpoint

| Checkpoint | Status | Commit | What changed | Validation |
| --- | --- | --- | --- | --- |
| Pre-M2 comprehensive audit hardening | Complete | `6a61f70` | Added shared config loading/validation with `repo_root` realpath matching; added shared atomic writers; exported shared contract load+validate; removed duplicate loader/atomic implementations from analyze/run/worktree/adapter paths; made `hivemind run` reject dirty existing task worktrees before invoking an adapter while allowing Hivemind-owned `agent.log`; added a separate tested future-intent path canonicalizer for later lease/write-intent use without implementing leases; tightened adapter profile validation to reject empty invoke entries. No M2 lease, submit, integration, status, or event-log commands were started. | `npm run typecheck`; `npm test` with 87 tests; `git diff --check`; cleanup/static scans for duplicate loaders, stale config validators, duplicate atomic writers, TODO-style markers, accidental M2 command/API implementation, and unused/stale references. No paid provider calls. |

## Completed Subtasks

| Subtask | Status | Commit | What changed | Validation |
| --- | --- | --- | --- | --- |
| M0.1 - `hivemind init` project scaffold | Complete | `422486b` | Added TypeScript/Node CLI scaffold and `hivemind init`; creates `.hivemind/`, required subdirs, empty `log/events.jsonl`, and atomic `config.json`; idempotent and fails outside git. | `npm run typecheck`; `npm test` with 4 tests; cleanup scans clean. |
| M0.2 - Task-contract format + loader | Complete | `9af793d` | Added `TaskContract` type, contract loading from `.hivemind/tasks/<id>.contract.json`, validation/normalization, and `hivemind contract <id> --validate`. | `npm run typecheck`; `npm test` with 11 tests; cleanup scans clean except expected deferred-scope references. |
| M0.3 - `hivemind worktree <id>` create/teardown | Complete | `e5f1115` | Added task worktree create/remove helper and CLI command; creates branch `hivemind/<id>` from contract `base_commit`; remove cleans up worktree and branch. | `npm run typecheck`; `npm test` with 16 tests; cleanup scans clean except roadmap references. |
| M0.4 - Headless adapter + Adapter Profile | Complete | `7f939f1` | Added internal `invokeAgent(repoRoot, taskId, tool)`, adapter profile loading/validation, contract-derived prompts, subprocess execution in the task worktree, `agent.log` stdout/stderr/exit-code capture, a dated Codex profile, and fake-adapter tests. Live Codex acceptance launched through the profile, ran in `.hivemind/worktrees/T-001`, wrote `agent.log`, and returned exit code 1 due unsupported default model/account pairing. | `codex exec --help`; live `invokeAgent` with Codex profile; `npm run typecheck`; `npm test` with 25 tests; cleanup scans clean except expected roadmap references. |
| M0.5 - `hivemind run` end-to-end diff capture [GATE] | Complete | `8a9786c` | Added `hivemind run <id> --tool <tool>` composing contract validation, worktree creation, headless adapter invocation, deterministic diff capture, and atomic `.hivemind/patches/<id>/diff.patch` writes. Captures no-change runs, non-zero tool exits, timed-out tool exits, and untracked worker-created files while excluding `agent.log`. Added bounded adapter `timeout_ms` support so wedged workers are terminated, logged as `tool_exit: 124`, and still allow diff capture. Added a Claude Code adapter profile. Updated the Codex adapter profile to explicit `gpt-5.5`, approved writable invocation flags, and a 120000ms timeout. Pre-M1 hardening later made dangerous adapter bypass flags require explicit `--allow-dangerous-adapter` approval when rerunning live provider gates. | `npm run typecheck`; `npm test` with 34 tests; `git diff --check`. Codex real-tool gate passed in a disposable repo with `tool_exit: 0`, `changed_files: 1`, and a correct `README.md` diff. Claude Code real-tool gate passed after CLI login in a disposable repo with `tool_exit: 0`, `changed_files: 1`, and a correct `README.md` diff. |
| M1.1 - Apply-to-base changeset resolver | Complete | `d522cac` | Added deterministic `resolveChangeset(repoRoot, baseCommit, patchPath)` support that creates a throwaway checkout at the declared base, applies patches through Git's index, derives staged file operations with rename detection disabled, classifies add/modify/delete/chmod/gitattr plus symlink/submodule when Git reports those modes, returns the required wrong-base reason on apply failure, and always cleans up its throwaway worktree. Did not add path canonicalization, pass/reject decisions, gate assembly, corpus, or CLI wiring. | `npm run typecheck`; `npm test` with 51 tests; `git diff --check`; cleanup/static scans for TODO-style markers and out-of-scope M1.2/M1.3 symbols in source/test files. |
| M1.2 - Path canonicalization + repo-root confinement | Complete | `8c9a2e9` | Added deterministic `canonicalize(repoRoot, path)` support that resolves the real repo root, normalizes relative or absolute concrete paths through filesystem realpath, applies filesystem case/link behavior, rejects unresolvable paths and paths escaping the repo root, and returns canonical repo-relative POSIX-style paths. Kept contract glob validation, changeset resolution, decision table, gate assembly, corpus, and CLI wiring out of scope. | `npm run typecheck`; `npm test` with 58 tests; `git diff --check`; cleanup/static scans for TODO-style markers and accidental M1.3/M1.4 integration. |
| M1.3 - Operation-decision table | Complete | `513285f` | Added deterministic `decideOp(op, contract, config)` support that canonicalizes each op path before membership checks, applies default-deny for unknown ops and unresolvable paths, rejects out-of-allowed-scope paths and symlink ops, rejects forbidden/Critical deletes, escalates chmod/submodule/git behavior/dependency-manifest/lockfile changes, and passes only in-scope ordinary ops. Added minimal exact/`*`/`**` path-pattern matching for current contract/config sets. Kept gate aggregation, CLI analyze wiring, and adversarial corpus out of scope. | `npm run typecheck`; `npm test` with 60 tests; `git diff --check`; cleanup/static scans for TODO-style markers, unused/out-of-scope gate symbols, and accidental M1.4/M1.6 integration. |
| M1.4 - Gate assembly + fail-closed + reason | Complete | `d779f23` | Added deterministic `runGate(baseCommit, patchPath, contract, config)` support that resolves a patch against the declared base, evaluates actual changeset ops, applies reject-over-escalate-over-accept precedence, rejects resolver/internal errors instead of throwing, and reports a reason naming the rejected or escalated op path. Refactored the changeset resolver to keep separate base and applied throwaway checkouts alive for gate decisions, so deletes canonicalize against the base checkout and adds/modifies/mode changes canonicalize against the applied checkout. Empty patches are accepted as `no changes`. Kept adversarial corpus fixtures and `hivemind analyze` CLI wiring out of scope. | `npm run typecheck`; `npm test` with 71 tests; `git diff --check`; cleanup/static scans for TODO-style markers, accidental M1.5/M1.6 integration, stale direct repo-root gate decisions, and expected M1.4 symbols. |
| M1.5 - Adversarial corpus harness + fixtures [GATE] | Complete | `ef4f0e0` | Added a deterministic test-only gate corpus that runs `runGate` against disposable git repos for the required rename-launder, symlink escape, `../` path escape, wrong-base patch, case-collision, forbidden-file deletion, mode-bit flip, and happy-path fixtures. The corpus expects reject for the adversarial reject cases, escalate for mode-bit flip, and accept for the happy path. Removed brittle global temp-dir cleanup assertions from older gate/changeset tests and kept repo-local worktree cleanup checks so concurrent test files cannot falsely fail on another test's live checkout. Kept `hivemind analyze`, leases, and integration out of scope. | `npm run typecheck`; `npm test` with 72 tests; `git diff --check`; cleanup/static scans for TODO-style markers, accidental M1.6 CLI wiring, accidental M2+ lease/integration implementation, duplicate gate helpers, and unused fixture helpers. |
| M1.6 - `hivemind analyze <id>` CLI wiring | Complete | `c8d0d5e` | Added `hivemind analyze <id>` and internal `analyzeTask(repoRoot, taskId)` support that loads the validated task contract, validates `.hivemind/config.json`, requires `.hivemind/patches/<id>/diff.patch`, calls `runGate`, prints `{ verdict, reason }` JSON, exits `0` only on accept, and exits non-zero for reject/escalate or pre-gate load errors. Kept leases, submit, integration, event logging, and advisory review out of scope. Local config/contract loading remains in the analyze command for this scoped CLI wiring phase. | `npm run typecheck`; `npm test` with 79 tests; `git diff --check`; cleanup/static scans for TODO-style markers, accidental M2+ lease/submit/integration implementation, duplicate/stale helpers, and expected M1.6 command symbols. |
| M2.1 - Lease store + disjoint-grant check | Complete | `1ced1f4` | Added deterministic file-level lease support backed by `.hivemind/leases/active.json` with exact `{ "<path>": "<task_id>" }` shape, guarded by `.hivemind/leases/active.lock`; added `requestLease(taskId, files[])`, `releaseLease(taskId)`, contract-backed `hivemind lease <id>`, and `hivemind lease <id> --release`; canonicalizes requested paths, rejects held paths with path/holder names, allows disjoint grants, makes same-task requests idempotent, fails closed on invalid lease stores, and writes lease state atomically. Reused the pre-M2 future-intent canonicalizer instead of adding a parallel path resolver. Kept M2.2 read-only flagging, M2.3 write-intent checks, submit, integration, status, and event logging out of scope. | `npm run typecheck`; `npm test` with 97 tests; `git diff --check`; cleanup/static scans for TODO-style markers, accidental M2.2+ write-intent/submit/integrate/status implementation, direct lease-store writes outside the lease module, and lease API references. No paid provider calls. |
| M2.2 - Read-only flagging of non-leased files | Complete | `26a0b12` | Added preventive worktree preparation that runs after task worktree creation or valid reuse, keeps canonical `allowed_files` writable, clears write bits from other tracked files, rejects glob/directory writable scopes during prep, and restores tracked-file write bits before worktree removal so cleanup stays reliable. Extracted shared concrete file-scope canonicalization and reused it from lease grants to avoid duplicate file-scope rules. Kept M2.3 write-intent checks, submit, integration, status, event logging, and any guarantee claim out of scope; the M1 gate remains authoritative. | `npm run typecheck`; `npm test` with 100 tests; `git diff --check`; cleanup/static scans for TODO-style markers, accidental M2.3+ write-intent/submit/integrate/status/event-log implementation, permission helper references, and duplicate file-scope logic. No paid provider calls. |
| M2.3 - Write-intent gate | Complete | `d45b190` | Added deterministic `checkWriteIntent(repoRoot, taskId, intent)` support and `hivemind intent <id> <intent.json>` CLI wiring. The gate validates intent shape and matching `task_id`, canonicalizes `intended_files`, reads the validated active lease store, passes only files leased to the task, and rejects unleased or differently held files with path/holder detail before editing. Advisory fields from the Overview example are parsed for shape but not enforced. Exported the existing validated lease-store reader instead of duplicating active-lease parsing. Kept submit, integration, status, event logging, and symbol enforcement out of scope. | `npm run typecheck`; `npm test` with 108 tests; `git diff --check`; cleanup/static scans for TODO-style markers, accidental M2.4+ submit/integrate/status/event-log implementation, duplicate lease-store readers, direct unvalidated active-store reads, and expected write-intent symbols. No paid provider calls. |

## M0 - Tracer Bullet

| Subtask | Status | Notes |
| --- | --- | --- |
| M0.1 - `hivemind init` project scaffold | Complete | Committed in `422486b`. |
| M0.2 - Task-contract format + loader | Complete | Committed in `9af793d`. |
| M0.3 - `hivemind worktree <id>` create/teardown | Complete | Committed in `e5f1115`. Must not be treated as agent invocation, lease, or gate support. |
| M0.4 - Headless adapter + Adapter Profile | Complete | Implementation checkpoint in `1861486`; completed in `7f939f1`. Codex launched through the dated profile and returned its exit code; tool exited 1 due unsupported default model/account pairing. |
| M0.5 - `hivemind run` end-to-end diff capture [GATE] | Complete | No-paid implementation in `301d725`; real-tool reliability checkpoint in `4fd7f32`; full gate completion in `8a9786c`. Codex and Claude Code both produced correct one-file `README.md` diffs in disposable repos. Do not start M1 until the user explicitly approves moving to the next major phase. |

## M1 - The Gate, Airtight

| Subtask | Status | Notes |
| --- | --- | --- |
| M1.1 - Apply-to-base changeset resolver | Complete | Implemented in `d522cac`. No dogfooding until M1.5 passes. |
| M1.2 - Path canonicalization + repo-root confinement | Complete | Implemented in `8c9a2e9`. Pure utility only; no decision table or gate wiring yet. |
| M1.3 - Operation-decision table | Complete | Implemented in `513285f`. Per-op verdicts only; no gate aggregation or CLI wiring yet. |
| M1.4 - Gate assembly + fail-closed + reason | Complete | Implemented in `d779f23`. Internal gate assembly only; no CLI analyze wiring yet. No dogfooding until M1.5 passes. |
| M1.5 - Adversarial corpus harness + fixtures [GATE] | Complete | Implemented in `ef4f0e0`. The full named adversarial corpus is green. Dogfooding still requires M1.6 CLI wiring for runnable patch analysis. |
| M1.6 - `hivemind analyze <id>` CLI wiring | Complete | Implemented in `c8d0d5e`. M1 gate is now runnable from the CLI. Do not start M2 without explicit user approval. |

## M2 - The MVP

| Subtask | Status | Notes |
| --- | --- | --- |
| M2.1 - Lease store + disjoint-grant check | Complete | Implemented in `1ced1f4`. File-level leases only; no M2.2 read-only flagging or M2.3 write-intent gate. |
| M2.2 - Read-only flagging of non-leased files | Complete | Implemented in `26a0b12`. Preventive only, not a guarantee; the gate remains authoritative. |
| M2.3 - Write-intent gate | Complete | Implemented in `d45b190`. Validates intended files against granted file leases before editing; no submit/integration/status/event-log behavior. |
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
