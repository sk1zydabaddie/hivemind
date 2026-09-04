# Where Hivemind stands

Current entrypoint, reconciled 2026-09-04. A claim without evidence is a plan.
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

Latest recorded installed functional fix: **416.23196.55488**, source
`cb7f0354e00d`, artifact
`f688465393e419ea8ae03b94c756c4aeecabc5dbfd86ecf5043f792e4756d7d4`.
Opening Test Game retired a pre-boot daemon record, reached **Set up the folder:
Done**, and left the unrelated live `svchost.exe` PID untouched. Evidence and
earlier validation remain in the [dated state archive](archive/STATE-2026-09-04.md).

The real-project, real-provider prompt-to-shipped run is older than that fix.
Do not describe a no-paid installed check, replay or unit suite as a fresh
real-model end-to-end qualification. Provider capability readback measures one
session/configuration, not permanent confinement or complete usage accounting.
Hidden provider-owned modes and imported project instructions remain limits
to disclose, not assumptions that deterministic gates may trust.

## Current work and where to look

- [Codebase reduction](CODEBASE-REDUCTION.md): generated-data cleanup,
  current-document consolidation and behavior-preserving implementation audit;
  measured counts and validation belong there.
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
