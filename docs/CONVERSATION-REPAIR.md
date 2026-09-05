# Conversation reliability repair

Approved scope: the four defects reported on 2026-09-04, plus the associated
missing Stop and unclear agent-role controls. Execute one checkpoint at a time;
report validation and obtain approval before the next major checkpoint.

## 1. Durable conversation continuity (implemented; installation pending)

Acceptance: the actual second provider input for the space-game follow-up contains
the first user request and actual assistant reply, in order, exactly once; a new
conversation contains neither. This is an input-delivery guarantee, not a claim
that a model can never drift.

- Core owns history assembly in the existing `src/spec-draft-action.ts` path,
  with typed prompt input in `src/spec-drafting.ts`. No React-maintained memory,
  provider session dependency, new model call, or generated summary.
- Read the project's durable events before recording the current message. Stop
  on a failed read instead of silently treating the project as a fresh thread.
- Isolate the latest conversation boundary and match assistant replies/drafts
  to their user message. Retain compatibility with pre-ID legacy records only
  inside their existing boundary. Unmatched responses are not conversation input.
- Retain the opening exchange and newest turns, chronologically: at most 24
  prior turns and 48 KiB of serialized history. Individual message text is capped
  at 4 KiB UTF-8. Mark shortened text and omitted turns explicitly and tell the
  model to ask if missing context is needed. Original events are never shortened.
- Existing bounded, root-confined file reads remain through the dispatcher.
  Conversation context does not approve, ratify, start a manager, or ship. An
  assistant's suggestion is not a user decision. The current message may revise
  prior preferences but a vague continuation must not invent a different project.
- Extend `test/spec-draft-retry.test.ts` with a no-paid provider-input capture
  across actual dispatcher submissions, new-thread isolation and authority checks.
  Add projection tests for long histories, Unicode, stale IDs, draft responses,
  failed turns, absent history and corrupt logs. Prove the integration regression
  fails when history delivery is unplugged.
- Cleanup: replace the legacy-on-read-error conversation-ID helper with the same
  successful snapshot used for the prompt. No duplicate prompt builder or memory
  store. Update STATE and this report; run all suites with counts, builds, static
  checks, then commit. Install/observe if admission allows; a paid provider test
  requires separate approval. Report any gap instead of claiming qualification.

## 2. Controllable, truthful live operations (pending approval)

Depends on checkpoint 1's durable request/conversation identity.

- Trace existing adapter cancellation/death proof and daemon queue interrupts;
  extend the audited conversation action rather than invent a client-only stop.
  Relevant paths: `workspace-actions.ts`, daemon action transport, adapter process
  ownership, drafting/planning invocation, shared action/event types and tests.
- Cancellation must reach both drafting and subsequent plan preparation, survive
  reconnect, prohibit subsequent launches, and acknowledge process termination
  before reporting stopped. Test early stop, handoff races, repeated stop, failure
  to prove death, and isolation from other projects/tasks. Do not stop unrelated
  user work as a test.
- One operation identity and actual phase feed `work-tab.tsx`. Remove the extra
  bottom pending presentation once the transcript owns the live row. Keep a
  temporary pre-event row only until that same operation is durably represented.
- Report real phase, elapsed time, provider-emitted activity and readable answer
  deltas when available. No private reasoning, fabricated progress or artificial
  character-by-character playback of a buffered response.
- Clarify active-agent inspection versus future model assignment. Switching a
  view must remain usable while running; changing an executing model must not
  silently replace the process or grant manager authority.
- Acceptance: one visible activity row per operation, phase changes match Core,
  and Stop kills only the owned operation, with no later stage launched.

## 3. Cohesive transcript and installed verification (pending approval)

Depends on checkpoint 2; no new layout should hide broken lifecycle reporting.

- Use the 21st UI-build workflow and existing Hivemind primitives/tokens. Keep
  Work/Agents/Project structure and dark-blue theme; install no mixed library.
- In `work-tab.tsx`, align messages, activity and docked composer to one centered
  responsive reading column. Remove the bottom-pinned activity gap and unused
  history-toolbar strip. Give prompt text the same left inset in idle and docked
  states, with controls on a distinct balanced row.
- Preserve virtualized history, keyboard scrolling, focus, accessible status,
  attachment/draft retention, and reduced-motion liveness. Test long answers,
  narrow windows, older history, pending/failure/stopped/reconnect states.
- Add operation-scoped Desktop regressions and production reachability checks
  with negative controls; run Core, Desktop, Rust and all builds with counts.
- `npm run ship` must build/install/verify exact identity. Observe installed
  behavior and record build-numbered screenshots, exact prompts and replies.
  Real model calls need explicit approval; deterministic fixtures prove plumbing,
  not model quality. Existing user projects are not disposable test fixtures.
- Done: four defects and associated controls have separate reproducible evidence,
  replaced paths are removed, docs updated, scoped commits and clean worktree.

## Risks and non-goals

Bounded history can omit an older correction: omission must be explicit, never
described as complete memory. Old assistant output can be wrong; it is advisory
context, not canonical state. Cancellation is an ownership change, not a cosmetic
toggle. Installed admission can fail on unrelated live work or advisories; do not
weaken it to install. No provider purchases, credential changes, OS preference
changes, approval-gate changes, or edits to the user's existing game project.
Previously generated incorrect specs/plans are not silently rewritten: they
remain recorded proposals requiring explicit review, replacement or a new thread.

## Checkpoint 1 evidence

- Production changes are confined to the existing drafting action and prompt
  builder. The legacy-on-read-error helper is removed; old ID-less event support
  remains because existing project histories use that format.
- Focused conversation checks: 31 passed, including a new Core process for the
  follow-up. The test captures and parses only the history JSON in provider stdin.
  The provider's test files are excluded from project context. Original request:
  `hello, I want to make a 3d space exploration game do you have any ideas`.
  Recorded fixture reply: `Explore a handcrafted star system, salvage derelict
  ships, and upgrade your spacecraft.` Follow-up: `you come up with the idea,
  create the entire game autonomously`. These are deterministic fixture outputs,
  not responses measured from a live model.
- Negative control: removing the compiled `history: history.value` delivery
  caused that same dispatcher test to fail with an empty prior-turn list. Restore:
  the test passed. The tightened no-file-contamination variant also passed.
- Read-only projection of the user's existing Test Game events reconstructed
  2 prior exchanges, 0 omitted, 1,137 serialized bytes, including the original
  space-game request and its recorded space-game reply. No event/spec was edited.
- Initial Core full run: 977 tests, 974 passed, 1 failed, 2 skipped, 0 cancelled.
  An existing MCP test left daemon PID 21728 under test process 99696 alive and
  reported EBUSY removing its temporary repository. The harness awaited process
  exit until that verified test-owned daemon was stopped. This is not a green run.
- Verification-harness repair: the HTTP MCP and daemon startup helpers now share
  cleanup before ownership is handed to their callers. Injected readiness and
  JSON failures test both paths; the readiness deadline is not weakened. This is
  test infrastructure only, not a product lifecycle or cancellation change.
  Combined conversation/MCP run: 44/44 passed. Removing the compiled startup
  cleanup caused the new regression to fail with `http startup failure left its
  child running`; the test's own finalizer still cleaned that child. The guard
  was restored before the full rerun.
- Final Core rerun: **978 total, 976 passed, 2 skipped, 0 failed/cancelled**,
  exit 0, 640.27 seconds. No child cleanup intervention was needed in this run.
- Desktop: 380/380 across 42 files; Rust: 64/64. Core build/typecheck and Desktop
  production build passed (existing >500 kB bundle warning remains). Desktop
  tests/build initially used `--ignore-scripts` to avoid their replay hook cleaning
  Core output during the concurrent Core run; generated replay inputs were not
  changed by this repair. The isolated final focused build was invoked directly
  after Node's test-file glob excluded files under `node_modules`; direct imports
  ran all 31 focused checks successfully.
  Final normal Desktop `npm test`, including replay generation and the Core
  rebuild, also passed **380/380** across 42 files.
- Static scan: no audited actions without a production consumer; no declared
  durable events without a producer. The 10 existing export leads are not treated
  as dead-code proof. npm reported 0 vulnerabilities; RustSec reported 0 across
  483 Windows dependencies. `git diff --check` passed.
- No paid model calls, credentials, OS changes, or user-project edits. Final
  installed identity and live-model behavioral qualification remain pending;
  the latter requires separate paid-call approval.
