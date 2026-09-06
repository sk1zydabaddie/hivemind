# U4 installed regression and completion evidence

Installed **416.30061.58188**, source
`c8ecdf0ae865f208d2a839aa4449541cd51acb24`, artifact
`6829361a0553d5f6e955d639b48045c798d3d99e4ef521c612b3500ed5a45ff8`.
Installed executable SHA-256:
`24214d7e2db7b12c1798c8727797a50c034f5b3ce8a5eea799ddefa983c67df9`.
All 4,480 managed files and Core/shell/Node identities were verified by local
installation; the installed harness independently checks executable and source
identity against the receipt. No public release was published.

## Installed results

`node e2e/phase6-conversation-remediation.mjs` in `desktop` exited **0** using
the installed app and no-paid fixture providers. All seven PNGs were inspected.

- The actual partial answer is `This installed fixture re` while its provider
  is alive. The scoped elapsed clock advances from **3s → 6s**; one live row
  remains. The unchanged four-second initial-message deadline passes.
- Read-only status settles in **16ms** while the provider is alive. This is one
  fixture measurement, not a latency guarantee or live-model benchmark.
- Two synchronous submissions produce one durable message and one provider
  invocation. Follow-up history and explicit file/folder context reach the
  fixture; New conversation starts a fresh history boundary.
- Reload-and-Stop terminates response PID **63184** and preserves the different
  next unsent draft. Planning handoff is visible; Stop terminates PID **60752**.
- Exact draft text and attachment references survive Work/Agents, both project
  switches and reload. A removed chip stays removed. Accepted content does not
  return as unsent input; actual UI New conversation becomes empty/editable.
  Navigation invokes zero providers in either project.
- The forced provider failure is visible. Its raw diagnostic is still shown:
  **U17 remains open**, not repaired by U4.
- Recent-project bytes are restored exactly, SHA-256
  `9f6c478f93cb98f488fc5e3a1f113abc746e4da228b62ef405a15970e0639d06`.
  No severe browser logs, paid calls, user-project edits or OS changes occurred.

U4's separate native live-stream tests pass at
[1440×900](../conversation-scroll-416.30061.58188-1788676826860/README.md) and
[790×610](../conversation-scroll-416.30061.58188-1788676886706/README.md):
**0px** maximum earlier-history anchor shift, versus **422px** in the retained
old-installed negative control. Latest restores log focus and remains at the
end during further output. The actual provider is alive while sampling and
dead after Stop. See those reports for exact samples and limitations.

## Failed attempts retained

Three earlier full regressions failed the final menu-opening deadline. The
[element-scoped diagnostic](../conversation-repair-416.30061.58188-1788677160919/README.md)
records the old closed menu still mounted when the next click arrived. The
harness now waits for that exact old surface to unmount before starting the
next interaction; it never retries a click or relaxes the opening deadline.
All five menu openings then pass. Rapid clicking during the closing transition
is still an observed application limitation, not fixed by this harness change.

The subsequent run failed with a
[stale test handle](../conversation-repair-416.30061.58188-1788677266579/README.md)
while New conversation replaced the composer. The predicate now reads both
required fields from the currently mounted composer atomically. Its same
empty/editable requirement and 10-second deadline pass in this final run.
No failed attempt is counted as a complete regression pass.

## Source validation and cleanup

- Focused Desktop checks: **62/62**. Full Desktop: **392/392**, 43 files.
- Full Core, run alone: **1,001 total, 999 passed, 2 platform skips,
  0 failed/cancelled**, exit 0, **472.142 seconds**. Skips are the two live POSIX
  process-group checks on Windows. Rust: **65/65**.
- Production typecheck/build passes. Shipping passes **56/56** viewport checks
  across four sizes. npm/RustSec report zero vulnerabilities, including 483
  Windows x64 dependencies in the Rust check. Existing 714.04 kB chunk and
  mixed static/dynamic window-import warnings remain.
- 21st review: zero errors, 15 pre-existing warnings. Existing primitives and
  design tokens were reused; no catalogue installation or paid generation.
- Removed the obsolete event-count force-scroll effect, end ref and hidden
  sentinel. The existing shared VirtualList now owns pinning and keyed-row
  anchoring; Project's non-following lists keep their mode. No parallel scroll
  owner, compatibility fallback or new authority path remains.
- Cleanup scan: no action without a production consumer and no declared event
  without a producer. Ten pre-existing test-only export leads remain; this is
  not whole-program dead-code proof. The isolated geometry fixture has an
  explicit replay consumer and is absent from the production app bundle.

Commands run, with the pinned Node 22.23.2 runtime on PATH:

- Root: `npm test`; `node tools/audit-unreached.mjs`; `git diff --check`.
- Desktop: `npx vitest run test/thin-client.test.ts test/work-thread.test.ts test/composer-draft.test.ts`
  (focused run); `npm test`; `npm run build`; `npm run ship`.
- Native: `cargo test` in `desktop/src-tauri`.
- Desktop installed checks: `node e2e/phase6-conversation-remediation.mjs`, plus
  `--scroll-only` and `--scroll-only --minimum` in separate runs.
- Syntax: `node --check desktop/e2e/phase6-conversation-remediation.mjs`.

The final harness-only changes and documentation do not alter installed
production bytes, so the full production suites and artifact identity above
still refer to source `c8ecdf0`. The final installed regression exercises the
updated harness. No production change was made to bypass its failures.

## Limits and remaining work

**3 of the original 17 findings are closed: U3, U4, U10.** Fourteen remain,
including the U1 spec decision. Minimum-width header labels are visibly clipped
and rapid menu clicks during the old closing transition can be ignored; both
additional observations are recorded in the ledger for separate bounded work.
The 56 viewport checks do not qualify those behaviors or every visual detail.

Attachment references are seeded through Core, not selected via a native file
dialog. Reload follows confirmed saving; immediate-close/power-loss durability,
arbitrary long sessions, archive restoration and live-model quality are not
qualified here. Finite no-paid fixtures are not a real-provider performance test.
