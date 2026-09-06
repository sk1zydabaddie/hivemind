# U3 installed negative control — 416.29953.52423

This is a **failed qualification**, not a release or U3 closure.

- Installed source: `af1d0c2fdaaedc80c163ab3057c2e77c1c06a5fd`.
- Artifact: `5eb74c8d5fdd726fa755321035452568444f42a4f1fc7e4ff78b18fcaad64c89`.
- Installed executable SHA-256: `730b02628793be097b696dc97d2a86df3f72a09dfb8baff70c55a46a487aaa44`.
- Normal `npm run ship` verified all 4,480 managed files plus Core/shell/Node identities.
- Command (from `desktop`): `runtime/node.exe e2e/phase6-conversation-remediation.mjs`.
- Result: exit 1, exact composer draft never reported a completed load/save after
  reload during `STOP_RESPONSE`. Screenshot and JSON are in this directory.

The live first answer passed partial streaming, exact 3s-to-6s elapsed change,
and a 67ms read-only status request while the provider was alive. The second
message passed: two synchronous form submits produced exactly one adapter call
and one durable user message, with the first exchange in provider input.

Reload during the third response left the composer read-only and displayed
“Hivemind is preparing an update; try this action again after it finishes.” The
actual response provider PID was 30556 and its operation remained in `reading`.
There was no real update: `src/update-lease.ts` incorrectly classified the new
draft actions as work, so they tried to acquire the admission held by that
response. The stored submitted text/identity remained on disk; this failure is
not proof that an unsent next draft was lost. The earlier no-coordinator daemon
test did not exercise this installed-only precondition.

## Earlier diagnostic attempts on the same unchanged installation

- `../conversation-repair-416.29953.52423-1788669798782/` and
  `../conversation-repair-416.29953.52423-1788670072235/` stopped at the second
  submission. Core had only the first request and the next draft was retained.
- `../conversation-repair-416.29953.52423-1788670253226/` captured two native
  submit events, both prevented by the existing handler.
- `../conversation-repair-416.29953.52423-1788670311450/` added temporary,
  read-only owner diagnostics: the live session was still `sending: true`,
  although its first receipt was finished. The test had checked only native
  `isEnabled()`, ignoring the shared Button's accessible disabled state.
- The corrected test waits for native enabled **and** `aria-disabled != true`.
  It then passed second-send/duplicate protection on the same installed bytes
  and reached the real reload/admission defect above. No product change was
  needed for that readiness issue. Temporary event/React-owner instrumentation
  was removed from the maintained test.

Only generated fixture projects and no-paid Node adapters were used. Each
attempt restored the recent-project registry byte-for-byte and stopped/removed
its own fixture processes and folders. The saved screenshots contain fixture
content, not the user's project. No paid model, public release, OS accessibility
preference change, or native attachment-picker qualification is claimed.
