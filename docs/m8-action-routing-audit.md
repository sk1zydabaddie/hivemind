# M8 Workspace Action Routing Audit

M8 follows two fixed rules: chat steers while typed actions authorize, and the React/Tauri workspace is a thin client over deterministic Core. The shared dispatcher is `executeWorkspaceAction()`; `hivemind workspace <typed-action-json-file>`, daemon `POST /workspace/action`, and Tauri `workspace_action` all reach that same function. React contains only the typed Tauri invocation. External callers use loopback HTTP. Mutations retain the serialized writer queue; event/output publication and the closed read-only action set bypass a long provider wait so observation remains live. While a workspace action already owns the mutation queue, nested project-file reads re-enter the same audited dispatcher in-process and never call the daemon back over HTTP.

## Action Registry

| Workspace action | Core primitive | Authorization and deterministic floors | Fail-closed behavior |
| --- | --- | --- | --- |
| `autonomy.set` | `setProjectAutonomyLevel()` | Accepts only the closed project-level enum `auto | review_plan | review_everything`, atomically updates repo-local config, and appends `autonomy.level_changed`. It grants no action authority itself; the next plan/manager decision reloads the durable policy. | Invalid/extra fields, unreadable or invalid config, unsupported level, or atomic-write/event failure refuses. Missing policy defaults to Auto; malformed policy never does and instead fails toward interruption. |
| `manager.start` / Work `Retry manager` | `startWorkspaceManagerSession()` -> `startManagerSession()` | Requires the active spec and the exact prepared plan to be ratified. Core derives the durable planning-session id rather than accepting one from the client, so planning, manager, and worker calls share one session ceiling. M9.3 derives the first happy-path proposal from the exact ratified plan and current durable state without a manager call. Retry after a refusal retains the same typed recovery path and marks the next continuation for LLM judgment rather than silently replaying later mechanical work. | Missing/invalid spec, absent or changed prepared plan, missing exact-hash ratification, invalid prepared-session evidence, malformed durable state, existing session identity, or an unprovable next transition refuses before execution. Guidance or a non-happy state switches to the confined/ceiling-bound judgment adapter; neither can authorize its proposal. |
| `manager.continue` | `continueAutonomousManagerLoop()` | Consumes the exact durable proposal stored by `manager.start`, then M9.3 re-reads the ratified plan, contracts, events, leases, intent, worktrees, patches, queue, and verification evidence to derive only the next proven mechanical action/batch. Every member retains M9.2's immutable proposal id/cursor and independently uses the existing deterministic action primitive and floors. For M9-configurable `run_worker` / `integrate_shadow`, Auto and Review-plan still create the same exact pending identity/hash and send it through the same pending-action disposer with durable `authorization_source: autonomy_policy`; Review-everything leaves it for explicit human disposal. Pending guidance or non-happy state uses the existing proposal adapter for judgment instead of deterministic advancement. | The first refusal, worker failure/crash/timeout, Critical/sensitive escalation, policy ambiguity, stale pending identity/state, Tier-3 stop, oracle block, quota stop, ceiling stop, or unknown state records normally, discards unexecuted work, and stops. Continuation never implies blanket approval, never advances past unobserved evidence, cannot replace an unconsumed proposal, and refuses ambiguous state rather than guessing. Adoption is not a manager action and cannot be derived. |
| `manager.retry_blocked` / Work `Retry` | `retryBlockedManagerAction()` then existing `continueAutonomousManagerLoop()` | Requires the exact consumed proposal and failed execution recorded by Core. For an explicit LLM-reactive session it preserves the existing behavior and re-presents only that action. For an M9.3 deterministic session it clears no underlying failure and records `manager.judgment_requested`; the next continuation invokes the existing manager proposal adapter for redirect/cancel/re-plan/escalation rather than mechanically replaying the failed step. The retry action itself executes nothing and spends nothing. | Missing, malformed, unconsumed, or execution-history-mismatched blocked state is refused. A deterministic session cannot continue into later mechanical work before the judgment turn, and any resulting Tier-2 action still receives a fresh pending identity and current durable-state hash. |
| `guidance.record` | `recordHumanGuidance()` | Accepts only `target: orchestrator` and narrative text. The guidance module has no approval, plan, memory-promotion, integration, quality-admission, or routing dependency. Pending guidance is injected once into the next already-scheduled proposal, then its audit events are excluded from later proposal context. | Extra authority-shaped fields are refused. Malformed durable guidance is refused during assembly rather than skipped or interpreted. Guidance never launches a provider call, mutates a running worker, or satisfies a gate. |
| `conversation.submit` | `submitConversationMessage()` -> `draftSpecFromPrompt()` and, only for a newly drafted request, `prepareWorkspaceTentativePlan()` | Accepts one UUID request identity, narrative prompt, fixed planner tool, and up to 20 structured project-relative file/folder references. Core alone inspects lifecycle state, classifies the turn, assembles bounded current-working-tree evidence through nested audited `files.read`, and decides whether the result is an advisory reply or an unsigned draft plus tentative plan. The durable message is written before a provider starts. | The UUID is idempotent in flight and against the durable trail. Duplicate submits start no second process. Existing project work makes the turn answer-only; message prose cannot approve, ratify, start a manager, integrate, or ship. Invalid attachments, unreadable current-tree evidence, provider failure, or durable output/event failure is explicit. |
| `plan.prepare` | `prepareWorkspaceTentativePlan()` -> existing generation / grounding / lint / exact `ratifyPlan()` path | Treats prompt text only as planning steering. Uses the active ratified spec, confined adapter profile, token preflight, Git-grounded scope, and every existing plan-lint rule including `SKELETON_TRAP_ACCEPTANCE`. It records `plan.prepared` with the exact review hash and level. Auto then calls the same exact-hash ratification primitive with policy source; Review-plan and Review-everything retain the human ratification boundary. | Draft/missing spec, unsafe profile, budget exhaustion, malformed output, grounding uncertainty, lint/review failure, unreadable policy, or exact-hash mismatch surfaces the reason. Prompt prose cannot choose the level or satisfy ratification. |
| `plan.review` | `reviewPlanForRatification()` | Read-only hash of the current grounded, lint-passed tentative plan. | Missing, ungrounded, or lint-failing plans are not reviewable. |
| `plan.ratify` | `ratifyPlan()` | Requires the exact reviewed SHA-256; stores an immutable ratified artifact and durable `plan.ratified`. Contract creation and plan-backed dependency execution read that artifact. | A changed hash, malformed event, missing artifact, hash mismatch, or unratified tentative plan refuses contract creation/execution. |
| `manual_task.review` | `reviewManualTaskForAuthorization()` | Read-only hash review for a hand-authored contract, available only when the active ratified spec has no tentative or ratified plan artifact at all. | Any plan artifact, unreadable plan state, inactive/draft spec, missing contract, or mismatched task id refuses review. A task omitted from a tentative plan cannot enter this path. |
| `manual_task.authorize` | `authorizeManualTask()` | Requires the exact reviewed contract-file SHA-256 and appends durable `manual_task.authorized`. Execution re-hashes the live contract and requires the exact event. | Changed contract bytes, caller authority claims, any tentative/ratified plan, malformed authorization evidence, or absent exact hash refuses execution. This preserves hand-authored workflows without an unratified compatibility bypass. |
| `plan.amend` | `queuePlanAmendment()` | Reuses full plan parsing/grounding shape checks. Additions and not-started edits are advisory queued amendments with no authority until the resulting plan is grounded, linted, and ratified. | Existing-task add, missing-task edit, malformed group, invalid scope, or any edit after a task starts is refused. Running contracts are never mutated. |
| `manager.approve_pending` | `approvePendingManagerAction()` | Requires the daemon-issued pending id, action type, subject, and expected durable-state hash. Core reloads the pending artifact, re-hashes status, reclassifies the action, then invokes the same deterministic manager executor. | Caller claims such as `approved` or `force`, stale state, mismatched identity, malformed pending state, or an action that no longer requires approval are refused. A downstream gate rejection is stored as a stopped manager action, never success. |
| `task.redirect` | `requestTaskRedirect()` | The workspace derives `source: human`. Core requires a real task contract and the latest unhandled durable `write_intent.rejected`, then reuses M6.3 `revision_requested -> redirected`; the next intent still goes through the write-intent gate. | No current rejected boundary, malformed rejection evidence, duplicate handling, terminal state, or exhausted redirect bound refuses. A correction never approves the rejected intent. |
| `task.stop` | `requestTaskStop()` / `finalizeTaskCancellation()` | Requires a real task contract. Appends `task.cancel_requested`, durably records worker PID plus instance identity, performs bounded SIGTERM/SIGKILL or awaited Windows `taskkill /t /f`, proves death through PL-1, waits for the adapter's durable stopped boundary, then removes the worktree and patch before releasing the lease last. | Unknown/terminal tasks and malformed requests are refused. Unproven liveness, timeout, or cleanup failure emits terminal retryable `task.failed`; the lease remains held whenever debris remains. A second stop retries finalization. Restart reconciliation reclaims only a PL-1-definitively-dead worker; Unknown/EPERM never releases ownership. |
| `run.stop` | `cancelManagerRun()` -> existing `requestSystemTaskStop()` / `finalizeTaskCancellation()` | Requires the exact durable manager session. Appends `scheduler.run_cancel_requested` first, making later scheduler launches ineligible, then derives active tasks from the ratified plan and durable state and invokes the same task-stop engine once per lane. It has no separate termination, cleanup, lease, or reservation logic. | Malformed/foreign session state refuses before fan-out. Each lane retains task-stop's PL-1 death proof and cleanup-before-lease-release ordering. Partial cleanup emits durable `scheduler.run_cancel_failed`, keeps unresolved ownership held, and is retryable; siblings are never double-stopped. |
| `status.inspect` | `inspectWorkspace()` over `getStatus()` and existing durable readers | Read-only project status plus Core-derived plan review, one per-task/per-group concurrent projection shared by Work and Swarm, Needs you/Later membership, active session, settled-plus-reserved ledger totals, scheduler capacity evidence, and bounded per-lane no-progress diagnosis. Stall recovery reuses only the existing typed `manager.start`, `manager.continue`, or `task.stop` action; inspection grants no new authority. React polls and renders the published result, while a dropped connection is presented as client transport state rather than fabricated project truth. | Missing optional work returns an empty presentation section; malformed or unreadable authoritative state returns an error and the client does not fill gaps. PL-1 `Unknown`, malformed process identity, unreadable timeout evidence, or malformed scheduler/reservation state cannot create a confident worker-stall or capacity verdict; uncertainty resolves against invented truth. |
| `trail.inspect` | `readEventPage()` | Read-only access to an explicitly bounded page of the append-only project trail so older conversation and Project history remain reachable without loading the complete archive. | Invalid cursors, limits above 500, and invalid trail data are refused; inspection cannot mutate or authorize. |
| `change.inspect` | patch-bundle reader in `executeWorkspaceAction()` | Read-only access to the selected task's durable patch artifact. | Missing task patch returns not found; no mutation or acceptance is implied. |
| `files.list` / `files.read` | `listProjectFiles()` / `readProjectFile()` | Read-only access to the project's own working tree so a file tree and a file viewer have something to stand on. Every path is realpath-resolved and judged on where it lands, not how it is spelled; `.hivemind/` is refused entirely and the refusal names the audited action that does serve that state (`trail.inspect`, `change.inspect`, `config.inspect`); `.git/` is refused. A listing omits those two roots rather than erroring, because a tree that will not draw its own root is useless. | `..`, absolute paths, globs and NUL bytes are refused lexically; anything resolving outside the repo root is refused on resolution, which is what stops a symlink or junction named innocuously. A directory is not readable as a file and a file is not listable as a directory; non-text is refused rather than returned as mojibake; a long file is truncated and says so. No writing verb exists in the module, asserted against its source. Confinement is tested from all three callers -- in process, over the CLI, and over the daemon route -- each with a non-vacuous positive case. |
| `checks.inspect` | `readCheckOutput()` over the trail's `checks_run_id` | Read-only access to what the project's checks printed on the most recent recorded run. Output is stored beside the trail under `.hivemind/checks/<checks_run_id>/`, never inside events, and bounded per stream. The run is located through `verification.completed` rather than by sorting a directory. | Takes no fields. An invalid or absent run identifier refuses; a project with no recorded run is told so rather than served an invented one. Reading a record is not running one -- re-running remains `verification.rerun` behind its own gate, and is not reachable from this action or the pane over it. A failure to store output never fails the verification; the event records `checks_run_id: null` so absent output is distinguishable from empty output. |
| `checks.inspect` — provenance field | `latestCheckOutput()` reading the run's bound `provenance` | Read-only. Reports what the recorded pass was standing on: which adapter produced each task's code and whether its probe still describes it, who authored each check (contract / project config / fail-safe fallback), whether the checks ran against the integrated set or one worktree, and the build identity. | Advisory only — **nothing gates on it**, asserted by test across integrate, adoption and verification. `adversarial_coverage` is always `unknown` and is present rather than omitted, because an absent field reads as nothing to say and this one has something to say. Null for a run recorded before provenance existed, which is distinct from an empty one. It records WHERE inputs came from and never how deeply a check tests — Core runs a command and reads an exit code. |
| `provider.auth.inspect` / `provider.auth.start` | `inspectProviderAuthentication()` / `startProviderAuthentication()` | Inspection runs only a fixed provider-owned, no-cost login-status command and reduces its output to signed in, signed out, or unknown; it never returns raw account output. Start launches one fixed catalogue-owned sign-in command in an external terminal. Browser, device code, provider choice, and credential storage remain owned by that CLI and its browser. | Both actions reject extra fields; start accepts only `provider_id`. Executable, argv, URL, token and environment cannot be supplied by the client. Unknown providers refuse. A CLI with no safe status command remains unknown, and only `adapter.connect` proves that a model satisfies Hivemind's capability contract. |
| `models.discover` / `adapter.connect_model` | `discoverProviderModels()` / `connectDiscoveredAdapter()` | Discovery runs only each catalogue-owned CLI's no-cost model-list/help surface, with the selected account home applied through the existing allowlisted environment. It sends no prompt, reads no credential file, and returns only provider ids, model slugs, labels, provenance and a plain failure. Model connection repeats discovery in Core, builds the bounded provider profile for that exact returned slug, then enters the same capability probe and atomic record path as `adapter.connect`. | Both actions have exact payloads: discovery takes none; connection takes `role`, `provider_id`, and `model_slug`. Runtime and output are bounded, malformed slugs are refused, and the client cannot supply executable/argv. A stale or forged slug that is absent from a fresh CLI result refuses before the paid probe. Newly detected models receive conservative standard-tier/100K metadata rather than an unmeasured cheap/strong routing claim. Nothing is written unless the existing probe admits it. |
| `accounts.inspect` / `accounts.add` / `accounts.select` | `inspectProviderAccounts()` / `addAccount()` / `selectAccount()` | Which account each harness runs as. **Hivemind never handles credentials**: an account is a directory the harness itself owns and wrote its own credentials into, and selecting one sets exactly ONE allowlisted directory variable -- `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, each read out of the shipped artifact rather than assumed. Nothing is read inside the directory. Selection is keyed by harness so `runAdapterProcess` resolves it itself and no call site can forget or override it. | Any variable outside the allowlist is refused, and any credential-shaped name is refused again by shape at the spawn -- two checks, because an allowlist alone is one careless widening from gone. A harness Hivemind cannot point anywhere is refused rather than guessed at. A registered path must exist and be a directory; an empty one is accepted, because checking for a login inside it is the thing this promised not to do. **Switching invalidates the capability verification for every role on that harness**, since a probe result is evidence about the tool, the profile AND the account: a different plan can change which models can be pinned and whether usage is reported at all. The prior capabilities are kept and marked stale rather than deleted -- "measured, but not for what is running now". |
| `sharing.inspect` / `sharing.untrack` | `trackedMachineFiles()` / `untrackMachineFiles()` | Which of this project's MACHINE evidence git is still carrying, and stopping it. `.hivemind/` mixed two kinds of thing: project facts a team wants identical (tier globs, ceilings, promoted routing policy) and evidence about one binary on one machine under one account (connection records, adapter profiles, accounts, the ledger, the trail). Sharing the second kind is the capability contract accepting a declaration again -- a verdict made by somebody else's computer instead of by a config file -- and it was the DEFAULT, because `initProject` wrote no ignore rule and `initialize_git` runs `git add -A`. | Inspect reads `git ls-files` and nothing else. Untrack runs `git rm --cached` on exactly the paths inspect returns: it stages, never commits, and never deletes -- the files are live state this project is using and a verification somebody paid for. Neither takes a payload, and a stray field is refused. Both are scoped to `.hivemind/`, so no action here can touch project source. The allowlist decides what is shared, so a directory Core adds later is not shared until somebody says so. |
| `verification.rerun` | `reverifyQueuedPatchSet()` -> existing `integrateShadow()` | Core derives the current queue, requires each immutable contract still targets the live configured base, revalidates active lease coverage, and then re-runs the existing patch gates, real configured checks, tier/oracle floor, and shadow cleanup. Only the verifier may emit the new immutable verification-set manifest. The prior verification remains append-only and is referenced only as superseded. | Empty/duplicate queue, moved base, invalid contract, missing/foreign lease, gate refusal, failed checks, oracle block, cleanup failure, or missing fresh manifest refuses. Guidance, manager, MCP, and caller-supplied task identities cannot trigger or shape the run. No adapter or provider call is reachable. |
| `adoption.review` / `adoption.execute` | `reviewVerifiedSetAdoption()` / `adoptVerifiedSet()` | Review does not mutate the base; it durably records and returns a daemon-issued pending identity bound to the exact verification id, expected base HEAD, and durable-state hash. Execute requires that complete typed identity, revalidates the immutable verification-set manifest, current base, contracts, patch hashes, config/oracle evidence, existing gates, and active file leases, then constructs one candidate commit and performs one guarded set transition. | Missing or caller-shaped approval, guidance/prose, stale/malformed/partial verification, changed HEAD/input, missing or foreign lease, oracle-floor failure, dirty base worktree, candidate-tree mismatch, or any uncertainty refuses. Reconciliation completes an already-performed exact transition without replay; an indeterminate third state remains blocked. MCP exposes no adoption tool. |
| `verify.characterize` | `generateCharacterizationCandidate()` | Reuses M7.6e admission, adapter/ledger ceilings, immutable candidate storage, M7.6c test-only `runGate()`, base-pass validity, and identity-verified disposal. | Unconfigured test paths, tier/ceiling/profile failures, non-test changes, base failure, or indeterminate identity cannot produce a valid candidate. It cannot integrate or adopt itself. |
| `quality.best_of_n` | `generateBestOfN()` | Reuses M7.7a promoted-policy admission, `routeTaskProvider()` tier floor, per-call and session ceilings, isolated drafts, existing `runGate()`, shadow verification, and advisory selection. | Low tier, unpromoted Medium, stale policy, provider downgrade, exhausted ceiling, gate/shadow failure, or cancellation refuses/stops before canonical mutation. |
| `quality.draft_refine` | `generateDraftRefine()` | Uses the same M7.7 admission, routing, ceilings, isolated disposer, and deterministic advisory selection as best-of-N. | The refinement has no privilege over the draft; any failed floor makes it ineligible and no artifact can adopt itself. |
| `quality.cancel` | `cancelQualityRun()` / `finalizeQualityRunCancellation()` | Requires one uniquely admitted quality run. Durable cancellation immediately revokes later call authorization; provider process identity is durable, an active adapter receives bounded termination, and the existing speculative disposer cleans its checkout before `quality.cancelled`. | Missing/ambiguous admission, malformed stage evidence, unproven worker death, or the 10-second cleanup bound emits terminal retryable `quality.cancel_failed`. Startup reconciliation converts open cancellations to `quality.cancelled` only after every worker is provably dead; Unknown/EPERM remains failed and unreclaimed. The complete named interrupt set is `task.stop`, `run.stop`, and `quality.cancel`. |
| `memory.review_handoff` | local CLI handoff to `reviewMemoryProposalInteractively()` | Returns the exact local review command only. Promotion remains M7.3's TTY and exact-id confirmation door. | React, daemon, MCP, headless, and programmatic callers receive no canon-write capability. If an interactive TTY is unavailable, promotion remains unavailable. |

## Deliberately Absent Actions

The registry exposes no direct lease grant, worker run, value-quality admission, patch acceptance, general shadow integration, tier change, ceiling override, or canon promotion action. Those operations occur only inside the existing audited workflows. `verification.rerun` is the one narrow wrapper over `integrateShadow()`: Core fixes its input to the authoritative queued set and adds lease/base preconditions; callers cannot select tasks or weaken checks. Verified-set adoption is the sole base-branch mutation action and requires its daemon-issued exact typed identity. Manual-task authorization is deliberately narrower than plan ratification: it is exact-contract-hash authorization and is structurally unavailable as soon as any plan exists. In particular, the workspace cannot call `integrateShadow()` with caller-chosen inputs, `admitValueQuality()`, or `reviewMemoryProposalInteractively()` directly.

MCP exposes no workspace action or promotion tool. If an M8 control later needs a new action, this table, the closed TypeScript action union, the daemon route tests, and the React thin-client tests must change deliberately before the control ships.

## Queue Exception

Long-running manager and quality generation use the serialized daemon mutation queue. `task.stop`, `run.stop`, and `quality.cancel` are the only mutation interrupts permitted outside that queue so one worker or an entire run can be stopped. A closed read-only set (`status.inspect`, trail/change/spec/plan/config/files/checks/account/provider/model/sharing inspection plus the matching GET status/quota routes) also executes concurrently: observation is not an interrupt and cannot mutate or authorize. Durable event and output writers publish immediately after their atomic append, so subscribers do not wait for the provider action to return. `run.stop` records the no-new-launch boundary and delegates each active lane to the existing task-stop disposer; it does not implement a second stop path. None of these exceptions can admit, generate, select, adopt, or mutate accepted canonical state.

The in-process transport is not a queue exception. It exists only while the outer daemon request already owns the queue and invokes the exact registered daemon route locally. The full dispatcher regression asserts that a complete task lifecycle entering through `/workspace/action` emits no nested HTTP route. CLI, MCP, and Tauri transports remain unchanged.

## Daemon Build Identity

The desktop refuses to attach or submit a workspace action unless the live daemon's startup-captured Core build identity matches the currently configured Hivemind CLI build. Missing identity is treated as a mismatch for a live daemon. The shell never responds to a mismatch by starting a second daemon; it surfaces the stale-build condition so the human can restart the existing writer deliberately. This check is transport provenance, not an authorization override, and it changes no gate semantics.

## Desktop Shell Build Identity

The native shell embeds a deterministic hash of the React, Rust, package/lockfile, and Tauri configuration inputs used to build it. On project connect and again before every workspace action, the Rust transport asks the current Core CLI for the expected shell identity and refuses before daemon attach, launch, health use, or action transport when the values differ. The returned connection carries both identities and React also requires them to match. This makes a stale embedded frontend a visible refusal instead of allowing obsolete controls to transact against current Core; it adds no action authority and changes no deterministic floor.

## Spec review (2026-08-11)

Two actions added for the single first-run review.

- `spec.review` — read-only. Returns the spec as the review screen shows it:
  goal, drafted non-goals, acceptance, open questions, and the verbatim prompt
  it was drafted from. Mutates nothing.
- `spec.adopt` — the human signature. Writes the person's answer to "anything
  this should not do?", takes out a convergence authorization against the
  document *as they are adopting it*, spends it, and ratifies the spec. Refuses
  while any open question remains, naming them. The orchestrator cannot propose
  this action, and `markIdeationConvergence` refuses a user signature without an
  authorization no matter who calls it.
- `conversation.submit` — the sole conversation front door. One UUID-bound
  request records the message durably, then Core assembles current-working-tree
  evidence through nested audited `files.read`. Structured file attachments
  promote exact files; folder attachments promote bounded descendants. The pack
  is capped at 8 files, 12 KiB per file, 48 KiB total, 16 read attempts, and a
  10,000-name inventory. Files outside the pack remain names and can be attached
  on the next turn; `.hivemind` and `.git` remain refused. Core alone chooses a
  reply or unsigned spec, and only a new spec proceeds to tentative planning.
  Existing work forces answer-only behavior. The former standalone
  `spec.draft` workspace action was deleted because it duplicated this boundary
  and had no production consumer. No reply or project evidence can authorize,
  ratify, approve, execute, integrate, or ship anything.
- `task.resume` — continues a task that paused for capacity, reusing the
  contract, lease and worktree that survived the pause. Applies every gate a
  fresh run applies (ratified spec, task in the approved plan, lease still this
  task's, worktree present) and refuses with a plain sentence if any went stale.
  Never re-plans and never re-ratifies: none of that state was lost.

## Settings and bring-your-own-agent

Five actions make first run possible without editing project files or opening a
terminal by hand. None can widen a gate: inspection and discovery are read-only,
configuration is key-whitelisted, initialization wraps the existing
`initProject`, sign-in launches only a fixed provider-owned flow, and both
connection actions write only what a probe confirmed.

- `config.inspect` — `inspectProjectConfig()`. Read-only projection of the
  resolved config, the three adapter roles Core resolves by name, each
  installed profile with the problems `validateAdapterProfile` found, and the
  agent catalogue with its real status. Holds no secret because Hivemind never
  holds a provider credential. Takes no fields; anything supplied refuses.
- `config.set` — `setProjectConfig()`. Accepts a fixed key list
  (`low_globs`/`medium_globs`/`high_globs`/`critical_globs`, `test_command`,
  `run_ceiling_tokens`, `session_ceiling_tokens`, `max_concurrent_workers`,
  `task_type_routing`) and refuses anything else rather than merging it.
  `task_type_routing` chooses which agent handles which KIND of work and is
  validated by `parseTaskTypePreferences`, which refuses an unknown task type
  rather than dropping it. It is the weakest of routing's three inputs by
  construction: it is applied to a candidate pool the tier floor has ALREADY
  narrowed, so it can never promote a cheap provider into Critical work; it
  never touches the promoted-policy path, so a preference cannot launder itself
  as learned evidence; and a provider whose `pins_one_model` is not `verified`
  (or whose verification went stale when its account changed) cannot be aimed at
  deliberately, because a model choice nobody can confirm is not a choice. Every write is re-validated by
  the same `validateConfig` the loader uses and written atomically, so a value
  this action cannot express cannot be reached through it. It cannot lower a
  routing floor: the floors are derived from tier, and only the glob lists that
  *assign* a tier are writable.
- `checks.try` — `tryProjectCheck()`. Runs ONE candidate check command in the
  project, through `runNamedCheck` — the same executor the verification gate
  uses, so a command cannot pass validation under different rules than the ones
  that will later decide whether a change ships. It takes `command` and an
  optional `accept_failing` that must be exactly `true`, and refuses any other
  field.

  The routing-relevant property is what it may WRITE. The decision lives in
  Core, not in the caller, because a client that ignored the outcome could
  otherwise store a command that never ran: `passed` stores the command with its
  trial and clears a recorded absence; `failed` records the trial and stores the
  command only under `accept_failing`; `not_runnable` and `timed_out` store
  nothing at all, under any confirmation, because a string that does not run is
  not a check and an unfinished run is not a pass. The trial can only be written
  by the code that watched the run, so a passing trial cannot be claimed. Every
  write goes through the same `validateConfig` and atomic write as `config.set`,
  and the key list it can reach is narrower — `test_command`,
  `test_command_trial`, and the removal of `no_tests_declared` — so it cannot
  reach a gate or a routing floor.

  Why it exists: an empty verification command is refused by integration, so the
  setup field that answers it blocked progress, and a field that blocks progress
  gets filled with whatever unblocks it. `npm test` typed into a project with no
  test script was accepted as that project's check and then failed every
  integration AFTER the planning and worker calls were paid for — strictly worse
  than the declared absence (A-03) the person could have chosen instead.
- `agents.propose` — `proposeAgentsFileAction()`. Read-only. Detects what the
  repository contains (stack, layout, check commands, tooling) with no model
  call, renders a starter AGENTS.md section, and returns a unified diff plus the
  hashes of the current file and the proposed one. Writes nothing. Refuses when
  nothing was detected, because a file of guesses is worse than no file.
- `agents.apply` — `applyAgentsFileAction()`. The only action that writes
  AGENTS.md, and the routing-relevant property is what it will NOT accept: the
  client sends back only `proposed_sha` and `existing_sha`, never file content.
  Core re-derives the proposal from the repository and refuses if either hash
  has moved, so a surface cannot use this door to write arbitrary text into a
  file that every harness reads verbatim as untrusted context. It also refuses
  content carrying permission or gate vocabulary (`findAuthorityLanguage`), and
  anything over the 16 KB ceiling, since the file is injected into every worker
  call.

  AGENTS.md carries knowledge and never authority: nothing written through here
  can widen a lease, narrow a gate, or change what is checked. The property that
  holds it is stronger than the wording — the same run with and without the file
  must produce identical gates, leases and checks. A lesson that would change
  what Hivemind PLANS belongs in canon instead, behind its human door; this
  action cannot reach canon and canon cannot reach this file.
- `conversation.new` — `startNewConversation()`. Creates a durable conversation
  identity and archives the prior active-request pointer before appending the
  boundary. Earlier message, spec and plan artifacts remain immutable history,
  but they cannot control the new thread. If the boundary append fails, Core
  restores the pointer; if either transition cannot be proven, the action
  refuses. Takes no fields and carries `advisory_only` plus
  `authorization_effect: none` -- a conversation boundary is never permission.
- `project.init` — `initProjectForDesktop()`. Wraps `initProject` and then
  writes default tier globs, because a project with no globs infers High for
  every path and routes all work to the most expensive provider. It deliberately
  writes **no** adapter profile: a profile written here would be a declaration
  no probe had checked, which is the exact thing `adapter.connect` exists to
  replace.
- `provider.auth.start` — `startProviderAuthentication()`. Opens the selected
  provider CLI's fixed sign-in command in a separate terminal. Hivemind does
  not receive the browser callback, device code, or credential. This is
  deliberately separate from `adapter.connect`: opening a
  sign-in flow proves nothing, while a successful capability probe proves the
  configured model can actually run in this project.
- `provider.auth.inspect` — `inspectProviderAuthentication()`. Runs only the
  fixed no-cost status command published by Codex, Claude Code, and OpenCode,
  with bounded output and runtime. It returns only a tri-state and generic
  detail; raw output, account email, organization, and credentials never cross
  the boundary. Grok and Kimi expose no equivalent safe command in the installed
  versions, so they remain unknown until a capability probe supplies stronger
  current-project evidence.
- `models.discover` — `discoverProviderModels()`. Runs the provider-owned,
  no-cost list surface for the selected account and returns only bounded model
  identifiers plus provenance. It never sends a model prompt, reads a provider
  credential file, or accepts an executable from React.
- `adapter.connect_model` — `connectDiscoveredAdapter()`. Repeats discovery in
  Core, refuses a slug the CLI did not just publish, and then reuses the exact
  `adapter.connect` probe-and-record path. A newly seen model is conservatively
  standard tier with a 100K context ceiling until measured metadata exists; it
  cannot gain a cheap or strong routing claim by appearing in a list.
- `adapter.connect` — `connectAdapter()`. Builds the profile server-side from
  the catalogue, refuses bypass flags and refused orchestration modes before
  spawning anything, runs one real probe, and records the profile **only** if
  every required capability came back verified. The recorded
  `<role>.connection.json` stores what the provider reported, not what was
  requested. A failed probe writes nothing at all.
  Since 2026-08-14 the probe also determines **where the harness sends your
  code** (`known_endpoint`). A prompt carries the contents of every file in
  scope, and a base URL -- `ANTHROPIC_BASE_URL`, Codex's `base_url`, OpenCode's
  `baseURL` -- redirects all of it while every other capability still reads
  verified. A configured endpoint is not a violation, because somebody chose
  it; it is recorded and named. An endpoint that cannot be determined refuses,
  on the same asymmetry as confinement: being wrong is unbounded. Evidence class
  is `static`, not `readback`, because no harness reports its endpoint -- Codex's
  `turn_context` carries the model, sandbox, approval policy and workspace roots
  and no endpoint at all.

The probe is the point. `validateAdapterProfile` checks fields and
`findDangerousAdapterArgs` refuses flags at spawn; neither has ever confirmed a
flag took effect, and this project has twice shipped a flag that was accepted
and ignored. So the connection compares the provider's own startup readback
against the request and reports the delta. A capability with no readback is
reported `unverified` and never `verified`.
