# Hivemind full-audit remediation program — 2026-08-27

## Decision

The current product is **NO-GO for public distribution** and **NO-GO for normal
development against a valuable repository**. Installed build **26.826.1622** is
an audit target, not a qualified release candidate.

The six discovery phases established 93 distinct open findings: **11 Critical,
50 High, 30 Medium, and 2 Low**. The critical set includes unauthenticated
command execution through the daemon, spoofable source-update execution,
update races across live work, a publish path whose artifact is not bound to
its source commit, a broadly readable passwordless update key, and cancellation
or crash transitions that contradict durable truth. Those are release and
valuable-repository blockers, not polish debt.

Disposable local fixtures remain useful for no-cost remediation checks if they
contain no secrets or valuable work, the public/source updater is not invoked,
and each test owns and removes only its own processes and state. That narrow lab
use is not product qualification.

## Execution status

**Phase 0 immediate containment completed 2026-08-27.** Installed build
**26.827.2050** has read-only release discovery but no registered install
command, source-build route, swap helper, local update transport, signing
script, or publication script. Both release command names now fail closed
before key or network access. Native evidence is under
`docs/evidence/remediation-phase0-26.827.2050/`.

This does not change the overall NO-GO verdict or reduce the ledger count. The
current updater key remains exposed externally, the public channel is not
rebuilt, and no provenance-bound replacement installer exists. Phase 0 removes
the executable authorities while R0/R1/R2 remain open for their permanent
contracts.

## Reconciliation result

The ledger parser found exactly 93 unique IDs with the expected phase counts:
21 + 15 + 12 + 12 + 13 + 20. Every ID has one severity and one class. Product
source under `src/`, `desktop/src/`, and `desktop/src-tauri/` is unchanged from
the pre-audit commit `13f5e6c`; the six audit commits added only documentation,
evidence, and audit probes. Therefore none of the findings was closed as a side
effect of the audit.

All 93 findings remain distinct after consolidation. Similar findings were not
merged when they fail at different boundaries or require different proof:

- F1-07 is transport failure hidden from the UI; F3-10 and F3-11 are record
  framing and explicit output-discard paths.
- F1-08 accepts wrong-shaped JSON; F3-10 loses a valid JSONL record split across
  operating-system chunks.
- F3-01 serializes observation behind provider work; F3-08 gives most manager
  calls no live-output transport even if serialization is removed.
- F4-01 fails to stop execution; F4-02 reconstructs the resulting cancellation
  as active. One is enforcement and one is durable projection.
- F4-08 filters abandoned anonymous rounds; F4-12 omits a named partial-stop
  failure from `Needs you`.
- F5-11 eagerly mounts retained conversation; F5-12 makes evicted content
  unreachable; F5-13 independently scales history reconstruction and rendering
  with the complete archive.
- F6-05 checks the wrong project scope; F6-06 lets a correct point-in-time check
  expire before installation.
- F6-11 does not bind source to artifact; F6-12 cannot verify that artifact and
  runs after publication; F6-14 leaves publication outside normal shipping.

No severity was reduced. “Local only,” “beta,” “unlikely,” and “works on this
developer machine” do not lower impact when the affected boundary executes
commands, signs updates, mutates repositories, charges providers, or asserts
that work stopped. The two Low findings remain Low because they are contract
and static-control drift without a demonstrated direct runtime failure.

## Severity rubric

| Severity | Closure meaning |
| --- | --- |
| Critical | Ordinary product use can cross repository, process, durable-state, cancellation, or update trust. Public release and valuable-repository use remain blocked. |
| High | A primary workflow can execute or charge unexpectedly, lose work, become unusable, or make a material safety/reliability claim false. The affected workflow remains blocked. |
| Medium | A recovery, persistence, accessibility, or diagnostic path fails or misstates evidence without independently crossing the top trust boundary. It must close before general availability. |
| Low | Contract/static-control debt with no independently reproduced user-visible or authority failure. It still closes before declaring the audit remediated. |

Severity describes demonstrated impact, not implementation effort or presumed
frequency.

## Product decisions to ratify before implementation

The recommended choices deliberately remove weak parallel systems instead of
patching around them:

1. **Source updater:** production should consume only signed published
   artifacts. Keep source rebuild/install behind an explicitly debug-only path,
   or remove it. Do not attempt to make arbitrary selected repositories into a
   production update channel.
2. **Daemon trust:** keep loopback transport, require an unguessable
   installation/session credential on every route, validate Host/Origin and
   content type as defense in depth, and do not support non-loopback binding in
   the consumer build.
3. **Core runtime:** bundle a pinned Node runtime with the installed Core for
   the current architecture. Do not depend on the user's PATH and do not execute
   `HIVEMIND_CLI_PATH` or `HIVEMIND_NODE_PATH` in release builds.
4. **Update scope:** one machine-wide update coordinator owns a durable update
   lease, inhibits new runs in every known project daemon, rechecks all projects
   at handoff, and holds the lease through verified relaunch.
5. **Release provenance:** build once in a clean release environment. One
   immutable manifest binds commit, lockfiles, dependency bytes, Core identity,
   shell identity, installer hash, version, signatures, and installed result.
6. **Signing:** treat the current updater private key as exposed. Stop using it,
   move signing to protected CI/secret storage, define an explicit migration for
   clients compiled with the old public key, and obtain Windows publisher
   signing before general distribution.
7. **Platform scope:** declare Windows as the only supported release platform
   until Linux and macOS use the same version, package, install, and verification
   contract. Remove or clearly quarantine commands that imply unsupported
   parity.
8. **Conversation archive:** keep the durable event log authoritative, add a
   paged read model, and virtualize mounted rows. Do not increase the in-memory
   cap or create a second authoritative transcript.
9. **Unreachable actions/events:** for each one, choose a real product consumer
   backed by an acceptance scenario or delete the action/event and its dead
   projection. Tests alone do not count as a consumer.

If any recommendation is rejected, its replacement needs an equally strong
boundary and acceptance proof before its dependent contract starts.

## Primary workstreams

Each finding has exactly one primary workstream. Dependencies may make one fix
help another workstream, but an ID is not closed twice.

| Workstream | Severity mix | Count | Primary finding IDs |
| --- | ---: | ---: | --- |
| R0 — Trust perimeter | 3 Critical, 1 High | 4 | F6-01, F6-02, F6-04, F6-13 |
| R1 — Update lifecycle | 2 Critical, 4 High, 1 Medium | 7 | F6-05, F6-06, F6-07, F6-08, F6-09, F6-10, F6-19 |
| R2 — Packaging and release supply chain | 1 Critical, 7 High, 1 Medium | 9 | F6-03, F6-11, F6-12, F6-14, F6-15, F6-16, F6-17, F6-18, F6-20 |
| R3 — Cancellation, crash recovery, and terminal truth | 5 Critical, 7 High | 12 | F4-01 through F4-12 |
| R4 — Conversation and real-time orchestration | 10 High, 4 Medium | 14 | F1-07, F1-08, F3-01 through F3-12 |
| R5 — Provider, setup, Git, and project lifecycle | 8 High, 10 Medium | 18 | F1-06, F1-15, F1-21, F2-01 through F2-15 |
| R6 — UI, accessibility, viewport, and archive scale | 8 High, 6 Medium | 14 | F1-16, F5-01 through F5-13 |
| R7 — Reachability, contracts, and observable failures | 5 High, 8 Medium, 2 Low | 15 | F1-01, F1-02, F1-03, F1-04, F1-05, F1-09, F1-10, F1-11, F1-12, F1-13, F1-14, F1-17, F1-18, F1-19, F1-20 |
| **Total** | **11 Critical, 50 High, 30 Medium, 2 Low** | **93** | Every ledger finding exactly once |

## Dependency order

The order is safety-driven. A later gate cannot compensate for an earlier
authority failure.

1. **Contain:** disable or fail closed the exposed source-update/release paths,
   stop use of the old signing key, and authenticate the daemon before broader
   dogfooding.
2. **Restore control truth:** complete R3 so Stop, cancellation, restart, quota,
   and terminal state have one enforceable meaning.
3. **Make project entry safe:** complete R5 before opening valuable or secret-
   bearing repositories.
4. **Make conversation observable:** complete R4 on top of the enforceable
   cancellation/process identities from R3.
5. **Support the declared human interface:** complete R6 after the live data
   path exists, so accessibility and paging consume real state rather than a
   second UI-only model.
6. **Resolve contract drift:** complete R7 by wiring only capabilities the
   product actually intends to expose and deleting the rest.
7. **Rebuild distribution:** complete R0's permanent boundary plus R1 and R2,
   then produce a new installed release candidate from the unified pipeline.

R0 containment is intentionally split from final R0/R1/R2 architecture. It is
valid to disable an unsafe path early; it is not valid to call the finding
closed until the replacement path and its installed proof exist.

## R0 — Trust perimeter

**Primary areas:** `src/daemon.ts`, daemon discovery metadata,
`desktop/src-tauri/src/project.rs`, `desktop/src-tauri/src/selfbuild.rs`,
`desktop/src-tauri/src/newer_version.rs`, release scripts, and updater key
configuration.

**Contracts:**

1. Add per-install/session daemon authentication and reject missing, malformed,
   stale, or wrong credentials before route parsing or dispatcher entry.
2. Restrict consumer daemons to loopback; reject untrusted Host/Origin and
   unsupported content types independently of the authentication test.
3. Compile production Core/runtime paths from installed resources only. Keep
   environment overrides behind a debug build configuration and prove the
   release binary ignores them without executing their target.
4. Remove the substring source-identity classifier from production. Prefer
   removing the production source updater; if retained, require an immutable
   trusted source identity before any repository command is launched.
5. Retire the current update key and implement the approved key/client migration
   without ever writing private-key material to evidence or logs.

**Cleanup:** delete unauthenticated fallback routes, release-mode environment
escape hatches, substring/timestamp identity helpers made obsolete by the
decision, and local-key generation instructions that describe the production
path.

**Exit proof:** every daemon route rejects a credential-free request from a
normal local process; a valid installed client still works; the release binary
cannot execute a supplied Core/Node override; an unrelated repository never
receives or executes an update action; key ACL/secret-scanner evidence contains
metadata only. These are separate exact-boundary tests, not one page-text check.

## R1 — Update lifecycle

**Primary areas:** `desktop/src-tauri/src/newer_version.rs`,
`desktop/src-tauri/src/selfbuild.rs`, project-daemon discovery, update UI state,
and the updater helper.

**Contracts:**

1. Add one durable machine-wide update lease. Acquire it only after every known
   project daemon proves idle, inhibit new work globally, and recheck immediately
   before install handoff.
2. Make project switching, daemon creation, work submission, and update start
   consult the same lease; no React-owned gate is authoritative.
3. Unify source/public installation admission with the same shipped artifact
   verifier, or delete the source-install path. A bare `tauri build` is not an
   update admission test.
4. On public update success, explicitly relaunch and verify the new process.
   Do not map download/install completion to `Restarting` before lifecycle work
   begins.
5. Bind post-update success to the complete artifact identity, not only a
   calendar version.
6. Replace PID-only helper cleanup with executable path, creation time, nonce,
   and expected-parent identity; remove the PID record on every terminal path.
7. Replace source timestamp heuristics with the artifact manifest's build-input
   identity, or remove source freshness from the consumer product.

**Cleanup:** remove the weaker parallel updater branch, stale-marker semantics,
and PID cleanup path after their single replacements are active.

**Exit proof:** two project daemons are exercised simultaneously; update is
refused while either owns work, new work is refused while the update lease is
held, a crash releases/reconciles the lease, the installed app relaunches into
the expected full identity, and a stale/reused PID cannot terminate an unrelated
fixture process.

## R2 — Packaging and release supply chain

**Primary areas:** `desktop/package.json`, `desktop/scripts/prepare-bundle.mjs`,
`stamp-version.mjs`, `release-local.mjs`, `publish-github-release.mjs`,
`verify-release.mjs`, Tauri resource/config files, `Cargo.lock`, and CI release
configuration.

**Contracts:**

1. Build a clean production staging tree containing compiled Core, production
   dependencies, and a pinned runtime. Do not copy the mutable development
   `node_modules` tree.
2. Generate a collision-resistant, monotonic artifact identity and a manifest
   binding clean HEAD, source/config inputs, both lockfiles plus `Cargo.lock`,
   staged bytes, Core/shell identities, installer hash, and platform.
3. Make the local install verifier consume that manifest and reject missing,
   additional, stale, or mixed installed bytes.
4. Make release verification download the candidate, validate the real updater
   signature with the compiled public key, compare its hash/manifest, inspect
   Authenticode, and run before any release becomes public.
5. Publish the exact already-admitted immutable artifact. A failing publication
   or post-upload comparison leaves no public `latest` candidate.
6. Add Rust advisory coverage alongside both npm graphs and record the tool and
   database identity used. Unknown/unavailable is a failed release gate.
7. Add Windows publisher signing and verify the exact installer/executable
   signatures. Keep release signing separate from updater signing.
8. Either implement equivalent Linux/macOS artifacts and install verification
   or remove/quarantine their public build commands and declare Windows-only.
9. Make `ship` and the approved release command share one admission graph;
   local installation and public publication may be separate authorized actions,
   but they cannot certify different bytes.

**Cleanup:** delete full-development-tree resource copying, minute-only version
identity, metadata-only signature checks, publish-before-verify ordering, and
unsupported-platform scripts once replacements are proven.

**Exit proof:** build in a clean environment without ambient Node, install on a
clean Windows user profile, verify every manifest identity, run both dependency
advisory gates, validate Authenticode and updater signatures, then perform an
offline/draft release rehearsal. Actual publication remains a separately
approved external action.

## R3 — Cancellation, crash recovery, and terminal truth

**Primary areas:** `src/manager.ts`, `src/task-control.ts`,
`src/task-resume.ts`, `src/run-state.ts`, `src/resource-ledger.ts`,
`src/open-rounds.ts`, daemon process ownership, workspace inspection, and client
projection.

**Contracts:**

1. Allocate and durably publish the manager/run identity before process spawn,
   so every in-flight provider process is discoverable and stoppable.
2. Make Stop an enforced protocol: inhibit new actions, signal the owned process
   tree, wait for acknowledgement or bounded forced termination, then append one
   terminal cancellation. A recorded cancellation cannot precede live execution.
3. Reconcile reservations with no bound live process and resume transitions
   interrupted between events. Crash at every durable-write boundary in tests.
4. Enforce terminal monotonicity: late callbacks cannot regress cancelled,
   completed, integrated, or otherwise terminal state.
5. Give every quality draft and scheduler wave a unique durable round identity;
   never deduplicate unrelated work using nullable task identity.
6. Keep retryable/partial cleanup failures open and project every actionable
   failure—including taskless and partial-stop cases—into `Needs you`.
7. Make New conversation inspect terminal state and active ownership before it
   requests cancellation; completed history never receives a fabricated stop.
8. Treat failure to append a required closing event as action failure, not
   successful answer completion.

**Cleanup:** remove fire-and-forget stop testimony, projection rules that infer
activity while ignoring cancellation, nullable round-key fallbacks, and any
terminal writer that bypasses the shared transition guard.

**Exit proof:** a fault-injection matrix kills the daemon/process before and
after every reservation, bind, resume, stop, and terminal write. After restart,
there are no ownerless reservations, immortal running tasks, executing cancelled
processes, regressed terminals, or hidden recovery records. The installed UI
must agree with the durable event trail during—not only after—each operation.

## R4 — Conversation and real-time orchestration

**Primary areas:** `src/daemon.ts`, `src/spec-draft-action.ts`,
`src/manager.ts`, adapter command/protocol modules,
`desktop/src/hooks/use-workspace.ts`, `desktop/src/lib/work-thread.ts`, and
`desktop/src/components/workspace/work-tab.tsx`.

**Contracts:**

1. Separate long provider execution from event/output/read-only observation so
   conversation state and inspection remain live while a call runs.
2. Move conversation classification and all plan/spec gates into Core. React
   sends intent and renders typed outcomes; it does not decide which authority
   path a message may use.
3. Give each submit an idempotency identity, disable/reject reentrant duplicates
   at Core, and retain text/attachments until Core durably accepts them.
4. Assemble bounded current-project evidence from the working tree, with exact
   root confinement/refusals and an explicit truncation/retrieval contract.
5. Make file/folder attachment semantics honest: attach readable contents or
   present a label-only reference as such. Never imply folder contents were read
   when only a name was sent.
6. Define New conversation as a real durable boundary or rename it to the weaker
   behavior. A new thread must not inherit hidden message/context identity.
7. Provide one provider-neutral incremental-output protocol. Buffer incomplete
   records across chunks, retain supported plain text, normalize Codex/Claude/
   Grok/OpenCode/Kimi events, and surface parse/transport failure explicitly.
8. Stream planner/manager activity and response text during execution. Hidden
   chain of thought remains hidden; user-visible progress is stage, tool/action,
   elapsed time, and answer text.

**Cleanup:** delete the React classifier/gate branch, duplicate provider-specific
output paths, explicit plain-text no-op, whole-call observation queue, and stale
fallback prompt/context assemblers superseded by the current-tree reader.

**Exit proof:** in the installed app, submit exactly once and sample the named
conversation element while a delayed fake provider runs. The request remains
recoverable until accepted, one provider process starts, stage/text changes are
visible before completion, read-only inspection responds concurrently, split
JSONL/plain-text records arrive intact, and transport failure becomes a scoped
recoverable error. Repeat for every supported protocol with no-paid fixtures;
real provider calls require separate approval.

## R5 — Provider, setup, Git, and project lifecycle

**Primary areas:** `desktop/src-tauri/src/project.rs`, provider registry and
adapter inspection, `desktop/src/lib/provider-authentication.ts`, project session
state, provider list, setup screen, and installed E2E isolation helpers.

**Contracts:**

1. Define provider standing as an evidence-bearing state machine: installed,
   missing, signed in, signed out, unknown/unverifiable, malformed, and failed
   are distinct. Copy and control eligibility follow that typed state.
2. Detect Windows child executable absence through the actual provider process,
   not the successful `cmd.exe` wrapper. A sign-in handoff is successful only
   when the intended CLI started; safe status absence remains unknown.
3. Never preselect an unavailable/unverified provider for a paid action. Every
   selected provider must be deselectable until the explicit action begins, and
   estimated token scope must describe exactly what the click authorizes.
4. Make Kimi/Grok's unverifiable authentication path usable through explicit
   configuration plus a bounded connection proof, without converting unknown to
   signed in. Do not spend without separate approval.
5. Remove automatic execution of detected repository checks. Detection may
   recommend a command; execution requires an answering control and audited
   dispatcher action.
6. Replace shallow Git/setup classification with a confined recursive inventory
   that honors ignore rules, refuses likely secret variants and nested generated
   trees, detects nested source, writes Hivemind shared facts before the initial
   commit, and shows the exact staged set before committing.
7. Make project-open/setup operations carry a request identity. A stale
   completion cannot replace a newer project selection, and a failed manual path
   remains editable in its dialog.
8. Write the recent-project registry atomically, preserve corruption evidence,
   isolate every installed test from the user's registry, and make removal
   recovery reachable from the actual cold-open state.
9. Present malformed provider/project artifacts as corruption with a recovery
   path, never as clean absence. Reject incomplete `.git` markers instead of
   looping through false success.

**Cleanup:** remove wrapper-level `ENOENT` inference, binary signed-in copy,
auto-check effects, shallow top-level source/secret heuristics, non-atomic recent
project writes, stale async completion setters, and clean-absence fallbacks for
parse failures.

**Exit proof:** a fixture matrix covers missing and malformed CLIs/profiles,
unknown auth, unavailable Kimi status, nested source, secret-name variants,
nested dependencies/build output, incomplete Git metadata, failed paths,
concurrent project switching, corrupt registries, and app restart. No repository
command or provider call executes before its exact answering control. The real
recent-project registry is byte-identical before and after every installed test.

## R6 — UI, accessibility, viewport, and archive scale

**Primary areas:** Tauri window configuration, `desktop/src/styles.css`, shared
pressable/dialog/form primitives, Work/Project/Settings surfaces, projection,
thread/history read models, and `desktop/tools/check-reachable.mjs`.

**Contracts:**

1. Choose and enforce one supported minimum outer window. The installed Windows
   client at that exact outer size must have no document-level horizontal
   overflow, overlap, partial clipping, or unreachable critical control.
2. Extend reachability to installed outer-window geometry and reject partial
   clipping and overlap. Each predicate must measure the exact control/surface,
   and the checker must terminate with no orphan process.
3. Make the conversation a labelled, focusable, scrollable log with appropriate
   live-region behavior for replies and functional status. Announce concise
   state, not every token.
4. Give every controlled dialog an explicit initial focus and restoration owner;
   plan approval cannot leave focus behind its overlay.
5. Restore shared visible focus, persistent labels, and reachable explanations
   for provider controls, composer, and disabled actions.
6. Add a paged durable conversation reader and virtualized transcript. Older
   retained content must be reachable without mounting the whole archive.
7. Add paged/virtualized Project history and an indexed/rebuildable projection
   that does not filter the complete event list once per run.
8. Correct the active mojibake strings while preserving the current dark Hivemind
   visual system and structure.

**Cleanup:** remove the contradictory CSS minimum, per-control focus overrides,
placeholder-only labels, title-only disabled explanations, full-array transcript
mapping, full-record data omission, and run-by-full-event filtering once the
shared bounded readers own those paths.

**Exit proof:** installed screenshots and accessibility-tree/focus traces at the
declared minimum, 1280x720, 1366x768, and 1440x900; two captures of live status
three seconds apart under reduced motion; keyboard-only transcript/dialog flows;
and fixed-budget DOM/navigation measurements for a corpus larger than the Phase
5 4,000-event retained thread. Assertions are scoped to the exact element under
test.

## R7 — Reachability, contracts, and observable failures

**Primary areas:** `src/workspace-actions.ts`, action audit metadata, event-name
contracts/producers, dormant quality/convention/quota modules, desktop action
callers/projection, error states, `tools/audit-unreached.mjs`, TypeScript config,
and current project documentation.

**Contracts:**

1. Make an explicit keep/delete decision for each of the eight unreachable
   audited actions. Kept actions require an authorized product consumer and
   installed scenario; deleted actions lose their dispatcher, audit, projection,
   prompt, and test-only compatibility path together.
2. Wire the non-goal quality guard into drafting before ratification, or remove
   the false guarantee. Give convention evidence and provider-quota parsing real
   consumers only if the product decision still requires them.
3. Reconcile declared event names with production transitions. Add a real
   producer/consumer pair or delete the obsolete alias and every dead branch.
4. Centralize typed failure presentation so autonomy, accounts, configuration,
   spend, provenance, and recent-project failures remain visible and retryable.
   Unknown evidence must never strengthen a claim.
5. Correct token-ceiling/provider-quota wording and stale project recovery using
   authoritative typed state.
6. Replace the call-syntax reachability heuristic with import/export/value-flow
   aware checks or narrow its claim to a lead generator. Add unused-code checks
   to normal validation after current debt is removed.
7. Reconcile contradictory historical status text without deleting its dated
   evidence: mark superseded claims explicitly and keep the newest measured
   count authoritative.

**Cleanup:** this is the dedicated dead-path removal stream. Delete every
unselected action, event branch, projection, helper, export, test fixture, stale
prompt builder, and contradictory undated claim. Do not retain compatibility
code without a named active consumer.

**Exit proof:** the action registry report has zero unexplained no-consumer
entries, every declared event has a production producer or an explicit external
input contract, the static scanner has zero known false-positive class in its
claim, normal builds reject unused production declarations, and injected client
failures render an exact retryable state rather than absence/success.

## Release gates

| Gate | Required evidence |
| --- | --- |
| G0 — Contained | Risky update/publication paths cannot execute; old key is no longer used; every daemon route rejects unauthenticated callers; production ignores executable-path overrides. |
| G1 — Durable control | R3 crash/stop matrix passes; no live cancelled process, ownerless reservation, terminal regression, or hidden recovery item exists after restart. |
| G2 — Safe project entry | R5 fixture matrix passes; no automatic repository/provider execution; Git preview contains no refused secret/generated path; registry and project switching survive failures. |
| G3 — Observable conversation | One accepted submit creates one call; live status/text and concurrent inspection work; current-tree context and attachments are honest; failure preserves user input. |
| G4 — Human interface | Installed minimum-window, keyboard, live-region, focus, paging, and long-session budgets pass on exact target elements. |
| G5 — Contract hygiene | Every action/event has an intended live path or is deleted; client failures are explicit; static and source-of-truth checks pass. |
| G6 — Qualified artifact | Clean staged runtime, complete manifest, dependency audits, signatures, offline publication rehearsal, install, relaunch, and exact installed identities all pass for one immutable artifact. |
| G7 — General-use candidate | G0–G6 remain green in one run; the installed app completes the end-to-end scenario below; all 93 findings carry direct closure evidence and no replacement path is duplicated or dead. |

Public publication is not part of G6/G7 execution unless the user separately
approves that external action. Passing a draft/offline rehearsal proves the
mechanism without mutating the public channel.

## Final installed end-to-end scenario

The release candidate is not qualified by a scripted page predicate alone. Use
the installed artifact on a fresh Windows profile and a purpose-built Git
project containing nested source, ignored generated files, secret-name canaries,
a deterministic slow provider fixture, and enough durable history to exercise
paging.

The human-visible walk must prove, in order:

1. Install without ambient Node and verify executable/Core/shell/artifact
   identities and Windows publisher information.
2. Open/select the project through both the OS picker and manual path entry;
   failed entry retains its value and cross-project completions cannot steal
   selection.
3. Preview and complete safe Git initialization; no secret/generated canary is
   staged, and `.hivemind` shared facts are included according to the contract.
4. Inspect provider standing including missing, unknown, malformed, and signed-
   in cases. No paid check runs until its explicit control is pressed.
5. Send one conversation message with file and folder attachments. Observe
   accepted state, live stage/elapsed/output, and concurrent read-only project
   inspection before the delayed process completes.
6. Stop a second run while active, verify its process exits, restart the app,
   and confirm the durable terminal and recovery surfaces agree.
7. Switch between two projects while one is active; state never crosses roots.
8. Navigate the transcript and project archive by keyboard at the supported
   minimum window and at 1440x900; older paged content remains reachable and DOM
   size stays within the declared budget.
9. Attempt an update while either project works and observe a refusal. Then idle
   both, install the exact admitted local candidate, relaunch, and re-verify the
   complete identity and project state.

Record the exact prompts, visible replies, build identity, timestamps, process
identities, screenshots, accessibility/focus trace, and fixture hashes. A human
must read the conversation result and inspect the affected controls; automated
checks provide supporting evidence, not a substitute.

## Validation required for every remediation contract

1. Capture a pre-fix counterexample whose predicate is scoped to the exact
   action, process, event, file, or element under test.
2. Add the smallest independent regression that fails on the old path. For
   during-operation behavior, sample while the operation is active.
3. Implement through the existing authoritative module; do not add a parallel
   gate, store, updater, projection, or provider abstraction.
4. Remove the replaced path and scan for unused imports/functions/modules,
   duplicate implementations, compatibility fallbacks, stale prompts, and
   server code imported into the client.
5. Run targeted tests, then root `npm test`, desktop `npm test`, Rust
   `cargo test`, root and desktop builds, advisory gates, `git diff --check`, and
   the relevant installed probe. Report actual counts rather than carrying this
   document's baseline forward.
6. For an installed/UI/packaging change, run `npm run ship`, verify the installed
   identities, inspect the running app, and record the build number on each
   screenshot.
7. Update `docs/AUDIT-2026-08-26.md`, `docs/STATE.md`, and the relevant design
   rule. Close only the IDs whose direct evidence now passes; keep partial work
   open.
8. Commit one scoped contract and finish with a clean worktree. Do not begin the
   next major remediation gate without approval.

Paid provider calls, public publication, key rotation in an external secret
store, code-signing purchases, and destructive operations on non-fixture
projects remain separate approval boundaries.

## Completion criteria for the full audit objective

The seven-phase audit is complete when this consolidation is committed, not
when the 93 product findings are fixed. The **remediation program** is complete
only when:

- every finding is marked closed with source, regression, and required installed
  evidence;
- every workstream's replaced code is removed and its old-path scan is clean;
- G0 through G7 pass in one current run against one immutable installed artifact;
- all three full suites, builds, dependency/security gates, viewport/accessibility
  checks, crash/recovery matrix, and release rehearsal report their actual
  current results;
- no paid or external action is represented as proof unless it was separately
  authorized and actually completed; and
- the worktree is clean, the release commit matches the artifact manifest, and
  the public channel—if publication was authorized—serves that exact artifact.
