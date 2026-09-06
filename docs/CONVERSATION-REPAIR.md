# Conversation reliability repair

Approved scope: the four defects reported on 2026-09-04, plus the associated
missing Stop and unclear agent-role controls. Execute one checkpoint at a time;
report validation and obtain approval before the next major checkpoint.

## 1. Durable conversation continuity (committed; installation pending)

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

## 2. Controllable, truthful live operations (implemented; installed proof pending)

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

## 3. Cohesive transcript and installed verification (implemented; installed proof pending)

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

### Checkpoint handoff

- Implementation commit: `d9e1ed2`. Final production reachability check passed
  all 44 surface/size cases, including loaded-resource/CSP checks. This unchanged
  UI suite does not prove the still-open duplicate activity/layout defects fixed.
- Installation was **not attempted**: preflight found installed-runtime daemons
  99600 (Test Game) and 102148 (an old desktop verification fixture). Read-only
  records showed no active reservations or task worktrees in Test Game; the old
  fixture has neither a ledger nor a worktree directory. No installed process
  was stopped. Approval to close those services and install was requested.
- The installed maintenance artifact remains **416.28392.32244**, not this fix.
  No installed-app/model response is claimed for that checkpoint. The subsequent
  user instruction to proceed approved the remaining repair and installation.
- Original history and the incorrect garden proposal remain intact. One ignored
  intermediate test compilation remains under `node_modules/.cache`; optional
  deletion was denied by the execution policy and was not retried via another
  mechanism. This is not a production code path or a tracked repository change.

## Checkpoints 2 and 3 implementation record

- `conversation.stop` is an audited, request-scoped interrupt across the daemon
  queue and update admission lock. Durable operation and child identities span
  response drafting and task planning. Early cancellation is checked before
  launch and before stdin; cancellation prevents the later provider stage.
- Stop returns success only after the producer closes its owned processes. A
  restarted producer reconciles only proven absence, never signals a historical
  PID, and leaves ambiguous/live children unconfirmed. Previously prepared
  draft artifacts are retained; Stop does not rewrite the user's history.
  On Windows, an orphan's missing root PID is not enough: an existing child
  termination record is required because this path has no durable process group.
- The transcript owns one live operation. Removed the duplicate pending footer;
  worker output is in the same scroll region. Legacy draft projection remains
  only for old histories without operation events. Request/phase tags prevent
  one stream from being presented as the following response or planning phase.
- Reused adapter process ownership, output storage, dispatcher and design tokens.
  No parallel prompt builder, client authority or model-driven gate was added.
- Models stays openable for inspection while busy and explains role assignments.
  This does not implement separate planner/manager chats or hot-swap a process.
- Actual 21st use: catalog search for chat/activity/composer references and local
  review of Work. No catalog component was installed, no generation was bought.
  Review: 0 errors, 15 warnings (13 max-width heuristics, existing long-duration
  motion and autofocus). Viewport checks, not those heuristics, decide reachability.
- Focused Core regressions: 42 passed (conversation, orphan reconciliation,
  round catalogue and MCP); separate real-daemon queue/update-lock Stop: 1 passed.
- Initial full Core run: 982 total, 977 passed, 3 failed, 2 skipped. Failures:
  incomplete new daemon fixture setup (fixed), missing new round catalogue
  entries (fixed), and existing MCP readiness timeout (passed unchanged in the
  focused rerun). This run was not green. Final suite and installed evidence
  are still pending at this entry; no paid model calls have been made.
- The next full run ended without a completion summary when execution was
  interrupted; it is not counted as passing. The Windows orphan rule was then
  tightened with an explicit regression before a fresh final run.
- Negative control: reintroducing the update-admission wait in the compiled
  daemon made the real HTTP Stop regression fail with "Hivemind is preparing
  an update". Restoring the interrupt exemption made the same test pass. Only
  generated test output was temporarily altered; production source stayed fixed.
  The tightened early/reading/planning/orphan checks passed 4/4 separately.
- Desktop: 381/381 passed across 42 files after the shared response-type guard
  caught an inline Stop response shape and it was moved into the existing type
  owner, derived from Core. Rust: 64/64. Production UI build/typecheck passed;
  the existing large-bundle warning remains. Reachability: 48/48 surface/size
  cases, including the new active conversation and scoped elapsed negative
  controls, with loaded-resource/CSP checks. These are production-browser checks,
  not installed-app proof and not an older-history-pagination qualification.
- Final Core run on 2026-09-05: **983 total, 981 passed, 2 skipped, 0 failed
  or cancelled**, exit 0, 712.65 seconds. The skips are live POSIX process-group
  tests on Windows, not skipped conversational behaviors. Static reachability:
  0 audited actions without production consumers, 0 events without producers;
  the 10 existing export leads are not treated as dead-code proof. npm reports
  0 vulnerabilities; RustSec reports 0 across 483 Windows dependencies.

### Installed verification correction (2026-09-05)

- `npm run ship` installed source `b3293b8` as **416.29771.32506**;
  all 4,474 managed files and Core/shell/Node identities matched. This is an
  installed identity result, not completed behavioral qualification.
- First installed fixture run observed the complete answer while the provider
  was still running and a scoped elapsed change from 3 to 6 seconds. It then
  failed on a test submission race. Its partial-answer check incorrectly
  admitted `Thinking`; that check is explicitly invalid as streaming evidence.
- The corrected test waits for enabled Send and requires the live answer to be
  a nonempty proper prefix of the exact expected reply. The second installed
  run failed that stronger assertion: structured JSON was buffered until closed.
  Both failed attempts remain under the build-numbered evidence directories.
- The existing Core stream decoder now emits received, schema-identified reply
  prefixes, never synthetic playback. Other field orders remain buffered until
  full validation; draft/spec and nested provider envelopes remain hidden.
  Escapes and incomplete surrogate pairs are retained safely. Partial snapshots
  do not accept drafts, plans or any authoritative state. The output writer now
  replaces complete snapshots before combining subsequent deltas, removing the
  old unconditional concatenation that could duplicate coalesced prefixes.
- Focused decoder/output tests passed 20/20 before the final JSON-literal reply
  regression was added. Full rerun, replacement installation and the strict
  installed behavioral check are pending. No paid calls were made.
- Visual review of the first failed run also caught a second progress label
  and elapsed clock in the run header. Counting only transcript test IDs missed
  it. The header now names the taskless surface `Conversation`; its duplicate
  clock and unused timestamp property are removed. Worker-run status remains
  in that header, and conversation progress remains in the transcript. Both
  production viewport and installed checks now inspect the header explicitly.
  The 21st review/catalog workflow confirmed reuse of the existing system;
  no component was installed or generated.
- Final Core rerun after the decoder correction: **988 total, 986 passed,
  2 skipped, 0 failed or cancelled**, exit 0, 573.67 seconds. Rust: **64/64**.
  The subsequent header-only correction does not change Core or native behavior;
  Desktop/production viewport checks and replacement installation are pending.
- Final normal Desktop `npm test` (including replay/Core build): **381/381**
  across 42 files. Production reachability: **48/48** at 790x610, 1280x720,
  1366x768 and 1440x900, including header/transcript assertions and the elapsed
  negative control. `git diff --check` and static action/event scans passed;
  the same 10 export leads remain unproven dead code. The 21st rerun reports
  0 errors and 15 unchanged warnings. Replacement ship/installed proof follows.
