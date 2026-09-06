# Where Hivemind stands

Current entrypoint, reconciled 2026-09-05. A claim without evidence is a plan.
Historical measurements are dated evidence, not a promise about today's build.

## Readiness and remaining limits

Hivemind is an accepted **unsigned beta**, not a fully qualified production
distribution. The [audit ledger](AUDIT-2026-08-26.md) records 93 findings,
92 closed and one High open: **F6-17, Windows publisher identity**. The user
deferred that purchase until revenue exceeds $200 MRR. Production release gates
G6/G7 remain NO-GO; the separately disclosed unsigned-beta tier is GO. This
ledger count is not a claim that no other bugs exist.

The protected beta publication recorded on 2026-08-31 is **416.22689.46153**,
source `fa14cbcaacfea709a7065932aefaafe6b31ddc2c`. Its exact installer bytes,
updater signature, manifests, public assets and SmartScreen disclosure were
verified. This is a historical publication result, not a live latest-release
lookup. Updater signing and Windows publisher signing are separate checks.
The retired in-app source/public update execution path remains disabled;
publication of an installer does not restore that consumer authority.

Latest installed candidate: **416.30061.58188**, source `c8ecdf0ae865f`,
artifact `6829361a0553d5f6e955d639b48045c798d3d99e4ef521c612b3500ed5a45ff8`.
All 4,480 managed files and Core/shell/Node identities matched. **U4 is closed**:
installed live-stream checks measure **0px** reading-anchor movement at 1440×900
and 790×610, versus 422px on the preceding build. Latest resumes following,
restores keyboard focus, and Stop terminates the owned provider. The complete
installed conversation/draft/Stop regression passes. Full Core: **999 passed,
2 platform skips, 0 failed/cancelled** (1,001 total); Desktop **392/392**, Rust
**65/65**, production viewport checks **56/56**. No paid calls or public release.
[Installed qualification and limits](evidence/conversation-repair-416.30061.58188-1788677425018/README.md).
The real-world audit has **3/17 closed (U3, U4, U10), 14 open**. Additional
minimum-width header clipping and ignored rapid menu clicks during closing
transitions are recorded as open observations; this is not whole-UI qualification.

Earlier installed candidate: **416.29995.30514**, source `b33049c8d841c`,
artifact `fd62d2919d83269c989f49eeb821c14a213f0703891d504abaf433624e51330c`.
All 4,480 managed files and Core/shell/Node identities matched. The strict
installed check now passes draft/attachment persistence across tabs, projects
and reload, accepted-send reconciliation, next-draft saving during a live
response, reload-and-Stop and New conversation separation. Final full Core
validation passes: **999 passed, 2 platform skips, 0 failed/cancelled** (1,001
total). Desktop **391/391**, Rust **65/65**, viewport **52/52**. **U3 is closed.**
[Installed proof and limits](evidence/conversation-repair-416.29995.30514-1788673483480/README.md).
Earlier first-message timing failures during concurrent full-suite validation
remain recorded; no timing threshold was relaxed.
[Timing evidence](evidence/conversation-repair-416.29995.30514-1788672737304/README.md).
The preceding `af1d0c2` candidate's reload/admission failure remains recorded in
the [earlier diagnostic evidence](evidence/conversation-repair-416.29953.52423-1788670388798/README.md).

Earlier installed maintenance build: **416.29883.15117**, source `cb9f1f9e8c7e`,
artifact `f524e5f29824a2dd109b5b52ad2b80b856be4d0d2ff502152fa7a6826ef2dbc8`.
All 4,474 managed files and Core/shell/Node identities matched. U10's installed
reader now passes the bounded-read test that failed on the preceding build,
plus short-read and error/change handle checks (3/3). [U10 evidence](evidence/audit-u10-416.29883.15117/README.md)
records the exact reader hash, commands, full-suite counts and limitations.

Earlier conversation qualification: **416.29838.49352**, source `ab6c88806aacc`,
artifact `0551057f8df67581bf706739d69b95da4fa64c1433685f311a5af62a10e9cb4f`.
All 4,474 managed files and Core/shell/Node identities matched. The strict
no-paid installed check passed conversation history delivery, genuine partial
answer display, one live row, reload-and-Stop recovery, owned response/planning
process termination, duplicate-submit protection, attachments and visible failure.
[Installed evidence and limits](evidence/conversation-repair-416.29838.49352-1788662305625/README.md)
include an observed unsent-draft loss across tabs; this is not a claim that the
broader usability audit is resolved or that live-model quality was qualified.

Earlier maintenance build: **416.28392.32244**, source `b9858afcf378`,
artifact `496daf6a156442ada5fb770dd5df05761354d4741532609c1e4bb4feb4c4daa3`.
All 4,471 managed files and Core/shell/Node identities matched. The no-paid
installed check visibly reached setup Done and exercised project previews and
refusals. [Evidence and limits](evidence/remediation-phase7-416.28392.32244/README.md)
include a transient Grok status disagreement, not a paid-provider qualification.
The earlier pre-boot daemon fix and its protected-PID evidence remain in the
[dated state archive](archive/STATE-2026-09-04.md).

The real-project, real-provider prompt-to-shipped run is older than that fix.
Do not describe a no-paid installed check, replay or unit suite as a fresh
real-model end-to-end qualification. Provider capability readback measures one
session/configuration, not permanent confinement or complete usage accounting.
Hidden provider-owned modes and imported project instructions remain limits
to disclose, not assumptions that deterministic gates may trust.

## Current work and where to look

- The 17-finding real-world-use remediation is active. **U3 and U10 are installed
  and closed; 15 remain open.** Project/conversation-owned unsent drafts passed
  installed testing and final full Core validation. U1 still needs
  the spec-ratification/tentative-planning product-rule decision; independent
  findings continue. [Per-finding evidence and open scope](REAL-WORLD-USE-AUDIT.md).
  U4's reader-owned scrolling is now in source: one virtual-list owner replaces
  unconditional/event-count scrolling. The old installed check reproduces a
  422px anchor shift during live output; controlled geometry passes at all four
  sizes, Desktop passes 392/392 and Rust 65/65. Full Core passes 999 tests with
  two platform skips and no failures; new installed proof is pending, so this
  is not an installed U4 closure.

- [Conversation reliability repair](CONVERSATION-REPAIR.md): the approved
  history, cancellation, phase-reporting and transcript-alignment checkpoints
  are implemented and installed with no-paid behavioral proof. Final source
  validation: Core **986 passed, 2 platform skips, 0 failed** (988 total),
  Desktop **382/382**, Rust **65/65**, production viewport **48/48**,
  zero npm/RustSec advisories. That qualification used installed source `ab6c888`; the report retains
  the failed attempts that exposed buffered replies, duplicate header progress,
  reload admission and event-key-order defects before final qualification.
  Legacy history rendering remains for old trails. Duplicate footer/header
  progress and the obsolete route-local merge path have been removed.
- [Real-world use review](REAL-WORLD-USE-AUDIT.md): 15 product/scale findings
  plus two verification gaps. The user authorized fixing all 17; **U3 and U10
  are fixed and installed, 15 remain open**. U10's historical qualification
  passed 18 focused tests, Core 990 passed/2 platform skips, Desktop 382, Rust
  65, viewport 48 and 3 installed reader checks. U3's latest counts and installed
  draft proof are above. U1 still awaits the documented planning/ratification
  contract decision. Remaining priorities:
  active-spec answer-only routing prevents normal conversational revision, and
  the conversation lacks a typed live-run/check context. The earlier installed
  draft-loss reproduction is now fixed; scroll stability and raw failure-detail
  presentation remain in the authorized remediation goal.
- [Codebase reduction](CODEBASE-REDUCTION.md): generated-data cleanup,
  current-document consolidation and behavior-preserving implementation audit;
  all three implementation phases committed through `5c69d80`; approved
  dependency follow-up `b9858af` clears the advisory blocker and is installed.
  Fresh Core, Desktop, Rust, advisory and viewport checks passed. Measured
  counts and the installed observation scope belong in that report.
- [Desktop design](../desktop/DESIGN-NOTES.md): current visual and interaction
  contract, without superseded design narratives.
- [User guide](USER_GUIDE.md): installation, setup and provider-mode limits.
- [Audit ledger](AUDIT-2026-08-26.md): individual findings and closure evidence.
- [Remediation record](REMEDIATION-2026-08-27.md): chronological execution;
  early NO-GO statements describe their dated audit targets.
- [Overview](../Hivemind_AI_Overview.md) and
  [build contracts](../Hivemind_Build_Tasks.md): authoritative product intent
  and numbered contracts. [AGENTS.md](../AGENTS.md) governs repository work.

## Active architecture and boundaries

- TypeScript Core in `src/` owns authority; React in `desktop/src/` is a thin
  client; Rust in `desktop/src-tauri/` owns the narrow native shell boundary.
  Desktop mutations go through the audited dispatcher. No embedded terminal,
  editor or preview that bypasses the recorded workflow.
- `.hivemind/` on disk is authoritative. Shared writes are atomic; append-only
  logs use the contract's complete-line append exception. SQLite is rebuildable
  cache. Durable events and project files must rebuild the observed state.
- Lease grants, diff-scope checks, ceilings and integration are deterministic,
  with no model/provider-network dependency. A granting function checks its own
  preconditions. Ambiguous confinement or ownership refuses; worker assertions
  about files, tests or completion never replace independent verification.
- Conversation proposes, answers and steers; it cannot approve, ratify, run,
  integrate or ship. Typed actions and explicit authority remain separate.
  Requests and retries use durable identity; stopping means observing process
  death before releasing ownership, not merely setting a client flag.
- Project questions can receive bounded file contents through audited
  `files.list`/`files.read`: at most 8 files, 12 KiB per file, 48 KiB total,
  16 read attempts and 10,000 inventory entries. Explicitly requested paths
  take priority. Limits/omissions are reported; do not silently feed a whole
  repository. Reads are root-confined and refuse `.git` and `.hivemind`.
- Conversation history is rebuilt from the current thread's durable events,
  not client memory or provider sessions. The input keeps the opening exchange
  and a recent suffix: at most 24 prior turns and 48 KiB serialized UTF-8, with
  individual message text bounded to 4 KiB including JSON escaping. Shortening
  and omissions are explicit; original events remain intact. Assistant proposals
  carry no approval authority. Unreadable history refuses before provider spawn.
- Supported direct CLI harnesses: Codex, Claude Code, Grok Build and OpenCode.
  Kimi Code is retired, including its direct paths and mark. Moonshot selected
  inside OpenCode is a backend, not a restored fifth harness. Presence, sign-in,
  project capability verification and product qualification are distinct facts.
- Windows CLI discovery uses one spawn environment: inherited PATH first, then
  known existing per-user CLI locations, never repository executable search.
  CLI presence is not desktop-app presence. Grok's explicit signed-out marker
  overrides cached model headings; unknown output is not guessed into success.
- Loopback is transport, not authentication. Daemon reads, streams and actions
  authenticate the intended client. Consumer execution uses packaged Core,
  shell and pinned Node identities; debug overrides stay out of release paths.
- A PID is reusable, not an identity. Restart may retire a record only with
  definite death or identity disproof, including a record predating OS boot
  with the existing clock slack. Unknown preserves ownership and refuses a
  second writer. Machine-wide installation admission covers all project work.

## Verification and maintenance rules

1. Recheck the relevant contract/source before changing behavior. Enumerate
   every input and grant path around a failed guard, not just the reported case.
   Scope a mitigation to the shared exposure, not merely where it was found.
2. Use no-paid checks first. Verify actual provider distribution/version and
   the instrument before spending on a capability measurement. Recorded output
   develops parsers; it does not independently qualify a live provider.
3. Scope assertions to the exact element/field under test. For streaming or
   liveness, sample during the operation. Use negative controls and an unmutated
   passing baseline. Source scans must distinguish code from explanatory prose.
4. Check both sides of string-based seams: native registration, dispatcher
   actions, queue kinds and event producers/consumers. `npm run audit:unreached`
   generates leads; an unused export is not automatically a missing feature or
   safe deletion. A reachable caller must exercise the intended capability.
5. Capture real trails **and project files at the same instant**. Historical
   replay uses capture-time projection, not today's process identities. Keep
   originals; generated replay data is regenerated before supported npm consumers.
6. Test on the platform's native filesystem and control inherited test
   environment. Own unique temporary paths and clean up only owned processes,
   including failed startup. Bound the largest unit actually timed. Read exit
   codes, failures, cancellations and skips; `fail 0` alone is not green.
7. Run Core `npm test` with the bundled Node 22 runtime first, then Desktop
   `npm test`, Rust `cargo test`, builds and `git diff --check`. Avoid a root
   build cleaning `dist/` while a running test needs it. Report actual counts
   and unresolved failures. Dependency audit and RustSec are separate checks.
8. Run Desktop `npm run verify:reachable`: production assets, actual CSP,
   loaded-image/error checks, clipping and interaction checks at four client
   sizes including 790x610. Unbounded component tests cannot prove visibility.
9. For a product fix, `npm run ship` in `desktop/` builds **and installs**, then
   verifies the artifact/version. Observe the installed path, record build and
   actual result, and distinguish human observation from automated predicates.
   A compiled property or successful script is not screen-level proof.
10. Preserve old durable records with shared response types and deliberate
    compatibility handling. Missing data is not zero or success; unsupported
    usage guarantees must be disclosed. Branch on typed failure codes, not
    Hivemind message text. Bounded parsing of external tools is a separate seam.
11. Reuse existing ownership, remove replaced paths safely, scan dead/duplicate
    code, update the relevant status record and make scoped commits. Do not
    delete explanations, tests, lockfiles or original evidence to lower a count.
    Axiom MCP is disabled and is not a prerequisite for repository work.

## Historical record

The full 4,024-line previous state document is preserved in
[the 2026-09-04 archive](archive/STATE-2026-09-04.md), with a normalized-content
hash. It contains original evidence, superseded findings and the incidents
behind these rules. Read the relevant history when needed; do not restore an
obsolete behavior merely because an early section describes it as current.
