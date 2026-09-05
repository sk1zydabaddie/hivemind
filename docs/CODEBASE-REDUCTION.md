# Behavior-preserving codebase reduction

Approved scope: generated-data cleanup, documentation consolidation, then an
audit and reduction of redundant implementation. Each phase has a separate
commit and evidence. No feature, authority boundary, failure state, test
coverage, or original run evidence may be removed to meet a line-count target.

## Baseline — 2026-09-04

Source: clean `ebc2fa4`. `git ls-files | cloc --list-file=- --timeout 0
--by-file-by-lang --csv --quiet` counted 755 recognized, deduplicated text
files: 209,894 nonblank/noncomment lines, 15,212 comment lines and 16,291 blank
lines (241,397 physical lines). There are 1,337 tracked files in total; binaries
and unrecognized files are not represented by that text count.

Programming languages outside `docs/` account for 120,183 nonblank/noncomment
lines, including tests and tooling. JSON accounts for 58,972 lines, Markdown
29,402, and other counted text 1,337. These categories are not equivalent to
application complexity. Lockfiles, whitespace and safety explanations are not
deletion targets merely because the counter includes them.

## Phase 1 — generated replay data

Invariant: a clean checkout can reproduce all existing replay scenarios before
any supported npm consumer runs. Recorded events, patches and output must not
change; the same timelines and successful/failed projections must remain.

The active path is `desktop/tools/collect-replay.mjs` reading original
`docs/evidence` and `desktop/test/fixtures/replay` inputs and projecting them
through freshly built Core. `desktop/tools/replay-data.json` is derived output,
not original evidence. It is now ignored rather than committed. The `dev`,
`build`, `test` and `verify:reachable` lifecycle hooks regenerate it. Direct
tool invocations require `npm run replay:collect` first. Generation reuses
Core's atomic JSON writer rather than publishing a partially written file.

The original tracked capture was compared against a fresh collection: all 28
scenario IDs, event counts, projection-presence flags, timeline counts, and
SHA-256 hashes of recorded events/patches/output agree. Three historical
freshness refusals were present in both versions and remain explicit failures;
no synthetic successful projection was substituted. Scratch paths, timestamps,
check durations and generated IDs are expected to vary, so byte identity of
the whole derived file is not the acceptance criterion.

`desktop/test/replay-generation.test.ts` retains the compact capture inventory
and checks the npm entrypoint ordering. Existing rendered-content and viewport
checks remain consumers of the real regenerated data. No source evidence,
lockfile, provider, or product capability is removed. No paid calls are needed.

Regeneration exposed two stale harness assumptions: old timestamps aged an
in-flight capture into recovery, and the replay omitted the shell's explicit
no-pending-relaunch response. Projections now use each capture's timestamp and
unknown historical process liveness; recorded events stay unchanged. The
liveness assertion now reads only the recorded planner article, not any clock
elsewhere on the page. All 44 surface/viewport combinations pass again.

A concurrent validation attempt failed six Desktop five-second source scans
and two Core daemon starts. Desktop passed 380/380 when rerun without heavy
build contention, with unchanged timeouts. Failed Core startup also leaked its
test-owned daemon before ownership reached the caller's cleanup block. The
test helper now disposes failed startup, with an injected-failure regression;
no production daemon behavior changed. The original Core run was 959 passed,
2 failed and 2 skipped, not a pass; its two owned leaked daemons were stopped.

Validation: missing-file `npm test` generated its input and passed 379/379;
the additional capture-clock regression brings Desktop to 380/380. Deliberately
changing a captured scenario ID failed the new inventory guard. Rust passed
64/64; production builds, Desktop typecheck and the corrected 44-case
reachability run passed. Final Core rerun: **962 passed, 2 skipped, 964 total,
zero failed/cancelled, exit 0**. It includes the failed-startup cleanup regression.
Product code and installed behavior are unchanged in this phase; no reinstall
or paid calls are claimed. Phase commit follows this record.

## Phase 2 — current documentation and historical evidence

Keep `docs/STATE.md` and `desktop/DESIGN-NOTES.md` as concise current entrypoints.
Separate historical decisions and validation narratives into explicitly dated
archives, preserving their text and working references. Reconcile obsolete
top-level status statements with the current qualified tier. Keep original
contracts, raw evidence and current invariants. Check links, preserved archive
content, source references and the full validation suite before committing.
Moving history improves orientation; it is not counted as repository LOC saved.

Completed: current STATE is 138 lines and DESIGN-NOTES is 172, replacing 9,142
lines of mixed current/historical entrypoints. Their full original bodies were
moved into dated archives; both normalized SHA-256 hashes match the originals.
All 33 local Markdown links in changed documents resolve. The user guide now
describes ship/install and bundled Node accurately, and the remediation record
labels its initial NO-GO as historical rather than today's verdict.

No contract or raw evidence was deleted. No executable files changed in this
phase; the preceding green Core (962 passed, 2 skipped), Desktop (380/380), Rust
(64/64), builds and 44-case replay apply to the identical executable tree.
Source checks found no test/runtime consumer that parses the changed documents.
This phase adds a short current index while retaining history; it does not
claim net repository-line savings. No paid calls or runtime changes.

## Phase 3 — redundant implementation

Audit active callers, exports and duplicated behavior before selecting changes.
Remove only proven dead paths or consolidate equivalent implementations with
one clearly owned existing path. No parallel replacement systems, minification,
feature deletion or weakened tests. Validate each selected subsystem with
behavior-focused regressions, full Core/Desktop/Rust suites, builds,
reachability and installed proof where runtime behavior could be affected.
Record net implementation reduction separately from generated data and docs.

Implemented scope:

- 57 identical structural object guards now use `src/json.ts`; 38 equivalent
  Node-error guards use `src/error-detail.ts`, including the formerly exported
  spec-format helper. Its callers now import the owner directly; no shim remains.
- Cache and status share integration-queue/status observation in
  `src/integration-state.ts`, including the original legacy validator. Task-file
  enumeration lives once in `src/contract.ts`. The required integration gate
  still refuses a missing queue; only the observational reader maps it to empty.
- Removed four exports with no named caller in production, tests or tools:
  `probeDirectoryExists`, `adapterDirectoryNames`, `writeTextFile` and
  `endpointSurfaceKnown`, together with their unused imports. The package is
  private with a CLI entrypoint, not a published TypeScript export contract.
- No new production module or parallel replacement path. Existing tests remain,
  with five added regressions covering object/prototype semantics, strict and
  inherited error codes, getter exceptions, missing/malformed/legacy disk state,
  real non-ENOENT filesystem failures and task-file selection/order.

The audit deliberately retained Git wrappers with different buffer/trim/error
semantics, domain-specific lease-store narrowing, and the ten tests-only export
leads that are not sufficient evidence of dead behavior. Broader validation,
schema migration, gates, concurrency and routing were not rewritten. The four
shared state-reader bodies were token-compared before moving; only names,
ownership and call sites changed. No fallback was relaxed or test removed.

Measured implementation reduction: Core `src/` falls from **43,909 to 43,637
nonblank/noncomment lines** (272 fewer); its physical-line reduction is **377**.
This excludes generated JSON, documentation and added test code. The source
audit reports **zero unconsumed audited actions and zero unproduced durable
events**, with dead-export leads reduced from 14 to 10. Targeted guard/cache/
status checks pass **15/15**, and the production no-unused build passes.
An AST-based review compared all 1,229 retained top-level function bodies in
changed production files, allowing only the three named reader-call renames:
no unexpected body changes. It accounts for 107 removed declarations (95
guards, eight duplicated observations and four dead exports) and six shared
declarations. CRLF/LF normalization is excluded from that source comparison;
the first raw-text pass correctly required that distinction rather than
mistaking line-ending changes for rewritten logic.
Final Core suite: **967 passed, 2 skipped, 969 total**, zero failures or
cancellations, exit 0. Rust: **64/64**, exit 0. Desktop: **380/380** across 42
files; production typecheck/build and all **44** surface/viewport combinations
passed, exit 0. The build retains its existing bundle-size and mixed-import
warnings. Final dead-path scans and staged/unstaged whitespace checks passed.
Implementation committed as `5c69d80` (Phase 1 `abd4ee8`, Phase 2 `0e3a674`).

The subsequent `npm run ship` stopped at admission, **exit 1**, before build or
installation: existing Core dependency `fast-uri@3.1.5` has four high-severity
advisories. The audit also reports moderate advisories for `qs@6.15.2`; Desktop
production dependencies are clean. Both arrive transitively through the MCP
SDK. No dependency manifest or lockfile changed in these three phases.
`npm explain` confirmed the installed chains; registry lookup shows a newer
compatible fast-uri 3.x release. This is a dependency-maintenance follow-up,
not evidence that the consolidation introduced the advisory or proof of an
exploitable application path. No reproduction or paid calls were attempted.

The safety gate was not bypassed. The installed app remains the previous build;
no installed qualification or new release is claimed. Completing installation
requires a separately approved dependency update, fresh validation, then ship
and observation of the installed result. The three code/document phases are
committed, but that delivery requirement remains open.

Completion requires scoped commits, a clean worktree, measured before/after
counts, explicit retained compatibility paths, and no unsupported promise that
passing tests proves equivalence for every possible input.

## Approved dependency follow-up — 2026-09-04

The user approved resolving the installation blocker. Targeted npm update with
lifecycle scripts disabled changed only `fast-uri` 3.1.5 to 3.1.7 and `qs`
6.15.2 to 6.16.0 in the root lockfile. Both satisfy existing transitive ranges;
no direct dependency, override, application path or audit policy was added.
The two installed package versions were checked against that lockfile.

The official npm gate reports zero vulnerabilities in both production graphs
and both full reports. The pinned RustSec gate reports zero vulnerabilities
across 483 Windows x64 dependencies, database
`5a0ebedfe8bdd2e295b171f4162f8c977bcad9a5`. The initial sandboxed Rust run was
63 passed / 1 failed because test-owned process termination was denied. That
run ended; its test processes were gone when inspected. The unchanged suite
rerun with process-control access passed **64/64**, exit 0. Fresh Core validation
against the updated dependencies passed **967 tests, 2 skipped, 969 total**,
zero failures or cancellations, exit 0. Desktop passed **380/380** across 42
files, and its production typecheck/build passed with the existing chunk-size
and mixed-import warnings. The exact lockfile delta was asserted to contain
only the two named packages; installed-tree dependency inspection, dead-path
audit and whitespace checks passed. Clean-source packaging and installed
observation follow the dependency commit.
