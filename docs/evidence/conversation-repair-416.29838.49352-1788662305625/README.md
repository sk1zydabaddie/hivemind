# Installed conversation repair — passed, no paid providers

Observed 2026-09-05 America/Los_Angeles (2026-09-06 UTC), at an actual
1440x900 content viewport, devicePixelRatio 1. The harness exited 0.

## Exact installed artifact

- Build: **416.29838.49352**.
- Source: `ab6c88806aaccb9e657f5bcea04159b281f18af7`.
- Artifact: `0551057f8df67581bf706739d69b95da4fa64c1433685f311a5af62a10e9cb4f`.
- Executable SHA-256: `99c9bf8c4323add9cefeef8f268dfba42f9121207ef9daaab19521b17a359b95`.
- `npm run ship` verified all 4,474 managed files, Core, shell and bundled Node.
  The installed harness independently compared executable bytes and payload
  source with the receipt. Later evidence/document commits do not change this
  installed source identity.

## What was measured

The machine-readable [result](phase6-conversation-remediation.json) is the
primary record. The local fixture invoked installed Core and the installed
executable, using a deterministic local provider substitute, not a paid model.

- Received partial text `This installed fixture re` became the exact full reply
  before the provider exited. The scoped elapsed element advanced 3s → 6s.
  One activity row appeared, with no duplicate progress in the header.
- Status inspection returned during the response (34ms in this observation,
  not a performance benchmark). Two synchronous submissions produced one durable
  message and one provider invocation.
- Actual follow-up stdin contained the exact first exchange once. A new
  conversation contained no prior turns and a different conversation identity.
- Stop remained available after full UI reload. Response child PID 107196 was
  alive before Stop and absent after acknowledgment; only one response stage ran.
  Planning child PID 26492 was likewise absent after Stop; exactly the drafting
  and planning calls ran, with no subsequent stage. These are historical fixture
  PIDs, not authority to signal processes currently bearing those numbers.
- Models opened while running; the next unsent draft survived Stop. File/folder
  references reached the existing dispatcher and provider context. A new thread
  archived one active spec pointer, and a forced error appeared in its own row.
- Browser severe logs: none. Recent-projects bytes matched their original hash
  after cleanup. No existing user-project spec/history was edited.

Six PNGs were visually inspected: partial answer, full live answer, later live
clock, stopped response, planning handoff and visible failure. These prove the
recorded states, not every viewport or every possible provider behavior.

## Commands and final source validation

- Root `npm test`, pinned bundled Node 22.23.2: **988 total, 986 passed,
  2 skipped, 0 failed/cancelled**, exit 0 (470.21 seconds). The skips are live
  POSIX process-group cases on Windows.
- Desktop normal `npm test`, including replay generation/Core build:
  **382/382**, 42 files. Native `cargo test`: **65/65**.
- Desktop `npm run verify:reachable`: **48/48** surface/size cases at
  790x610, 1280x720, 1366x768 and 1440x900, including operation/header/elapsed
  checks and a scoped elapsed negative control. Passed standalone and in ship.
- `npm run ship`: exit 0. Production build/typecheck passed. Existing 706.88 kB
  JavaScript chunk and mixed static/dynamic import warnings remain.
- npm/RustSec: 0 advisories (483 Windows Rust dependencies). Static audited
  action/event scan: 0 missing consumers/producers; 10 existing export leads
  remain unproven dead code. `git diff --check` passed before source commit.
- From `desktop`, `runtime/node.exe e2e/phase6-conversation-remediation.mjs`:
  exit 0. Matching WebView driver was resolved from the local driver cache;
  no global browser driver or OS preference was replaced.

## Limits and separate findings

This is no-paid installed lifecycle/input-delivery qualification, not a claim
that real models cannot drift or that every provider streams the same format.
There was no paid end-to-end generation, manager execution or public release.
Attachment context was exercised via the dispatcher, not the native picker.
Older-page replay, connection-only activity replay and long-session resource
use are not qualified by this run.

The findings-only tab probe reproduced **U3**: the exact unsent text
`Keep this unsent draft while I inspect Agents.` became empty after switching
Work → Agents → Work. Screenshot review reproduced **U17**: raw failure output
and its absolute log path appear twice. These remain open in the
[real-world review](../../REAL-WORLD-USE-AUDIT.md), not hidden behind the passing
repair check. Prior failed installed runs are retained in their own directories.

A [second fresh-fixture run](../conversation-repair-416.29838.49352-1788662405989/README.md)
also passed on identical installed bytes, including the previously intermittent
duplicate-row and reload paths. Both sets of six screenshots were inspected.
