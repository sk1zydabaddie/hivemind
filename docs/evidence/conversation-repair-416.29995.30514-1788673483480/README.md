# U3 installed draft persistence qualification

Installed **416.29995.30514**, source
`b33049c8d841c08723d8476860ff58aa5ad4a737`, artifact
`fd62d2919d83269c989f49eeb821c14a213f0703891d504abaf433624e51330c`.
Installed executable SHA-256:
`d8c698d8cfbfc6c024b2e0645895b34327bfb0f6638ebed43ccf4c377183b65f`.
The normal local installation verified all 4,480 managed files and Core, shell
and Node identities. Installed and workspace `dist/src/update-lease.js` both
hash to `6896e08b1ac0028c35c1514756c0608e5cbee780414fc30237d099edadd1fd22`.

## Actual installed acceptance

`node e2e/phase6-conversation-remediation.mjs` from `desktop` exited **0** using the
installed executable, a real local Core daemon and no-paid Node fixture
providers. The Core suite was not running alongside this check. Exact results
are in `phase6-conversation-remediation.json`; all seven PNGs were inspected.

- Project A's text and attachment references survive Work/Agents navigation,
  switching to project B and back, and WebView reload. Project B retains its
  different text. Neither project invokes a provider during this navigation.
- Removing one attachment stays removed after reload. The restored screenshot
  shows the remaining `notes` chip and the exact unsent text, with saved status.
- An accepted message does not return to the composer after reload during an
  active response. A different next draft is saved while the provider PID is
  still alive and remains through tab navigation and Stop.
- The actual New conversation UI starts with empty text/attachments rather
  than carrying the old conversation's draft into the new one.
- The unchanged four-second first-message deadline passes. A genuine partial
  answer, `This installed fixture re`, is captured inside the answer element
  while its provider is alive. Later samples show the live clock changing from
  3s to 6s. Read-only status settles in **63 ms** while the provider is alive.
  These are fixture observations, not provider performance guarantees.
- Two synchronous form submissions produce one durable message and one
  provider call. Follow-up history and explicit project attachment content
  reach the fixture; New conversation clears the prior history boundary.
- Reload-and-Stop terminates response child PID **65028**, retaining the next
  draft. Planning handoff is visible and Stop terminates child PID **95596**.
- The forced provider failure produces a visible durable failure. Its raw
  diagnostics remain visible: **U17 is not fixed by this checkpoint**.

Recent-project bytes were restored exactly (before/after SHA-256
`9f6c478f93cb98f488fc5e3a1f113abc746e4da228b62ef405a15970e0639d06`).
The check cleaned only its owned fixture processes/directories. No severe
browser logs, paid provider calls, user-project edits, OS preference changes
or public release publication occurred.

## Failures retained, not converted to passes

The earlier candidate exposed a real installed admission defect and was
corrected in this source; see the
[earlier diagnosis](../conversation-repair-416.29953.52423-1788670388798/README.md).
Two attempts on this build failed the strict deadline while full Core testing
was active; [timing evidence](../conversation-repair-416.29995.30514-1788672737304/README.md)
retains those failures and distinguishes eventual admission from a stuck send.
No timing threshold was relaxed, and no causal CPU-contention claim is made.

The immediately preceding quiet run passed reload/draft/Stop checks but typed
into the old composer after changing Core's conversation directly. Its
[sequencing diagnosis](../conversation-repair-416.29995.30514-1788673301611/README.md)
records the harness correction: wait for that actual old element to unmount,
then type into the replacement. It does not retype lost input or weaken draft
assertions. The later actual UI New conversation check also passes here.

## Source validation and limits

Focused desktop checks: **44/44**. Full Desktop: **391/391**, 43 files. Rust:
**65/65**. Live admission/Stop/two-project refusal checks: **7/7**, including
negative-control failure before the classification fix. Production typecheck
and build pass; viewport checks **52/52**, including draft-load failure at all
four sizes. npm and RustSec report zero advisories (483 Windows dependencies
in the Rust check). The existing 713.08 kB bundle-size warning remains.
21st review: zero errors, 15 existing warnings across the two reviewed files.
Final full Core validation: **1,001 total, 999 passed, 2 platform skips,
0 failed/cancelled**, exit 0, **529.418 seconds**. The two Windows skips remain
the live POSIX process-group checks. This final suite ran after the installed
test completed, with no concurrent desktop rebuild or installed fixture run.

Commands used for this correction/qualification (Node 22.23.2 from the pinned
desktop runtime on PATH; commands are relative to the repository unless noted):

- `npm test`: root build and full Core tests; runs alone for final qualification.
- `node --test --test-name-pattern='MCP create_task_contract refuses a dependent' dist/test/mcp.test.js`:
  unchanged isolated readiness-failure follow-up, **1/1 passed**.
- `npm test` and `npm run build` in `desktop`: full desktop tests and production
  typecheck/build. The desktop prehooks rebuild root output, so they must not
  run alongside the full Core suite.
- `cargo test` in `desktop/src-tauri`: native tests.
- `npm run ship` in `desktop`: dependency audits, 52 production viewport checks,
  clean artifact build and verified local installation, not public publication.
- `node e2e/phase6-conversation-remediation.mjs` in `desktop`: installed acceptance.
- `node tools/audit-unreached.mjs`, `node --check desktop/e2e/phase6-conversation-remediation.mjs`
  and `git diff --check`: cleanup/static checks.

The cleanup scan finds no draft action without a production consumer and no
declared event without a production producer. Ten pre-existing test-only export
leads remain outside U3; this heuristic is not whole-program dead-code proof.
The new Core module and desktop session/hook all have active consumers. No
browser-storage fallback, old local submission refs or unconditional attachment
clear remains. Existing historical conversation rendering and saved drafts from
old conversations are retained for history; U3 adds no archive restoration UI.

Attachment references were seeded through Core, not selected using a native
file dialog; this qualifies persistence/chips/context, not picker interaction.
Reload checks wait for confirmed saving; immediate native-close/power-loss
durability is not established. The no-paid fixture does not qualify live-model
quality, long-session scaling, archive draft restoration or every audit finding.
