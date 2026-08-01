# M8 real workspace adoption evidence

Date: 2026-08-01

Target repository: `D:\Projects\hivemind-workspace-e2e-20260731`

This is the deterministic continuation of the paid M8 workspace E2E. No provider was called during re-verification or adoption.

## Fresh verification

- The pre-M8.7 `integration.passed` result at `2026-08-01T05:43:02.361Z` had no verification manifest and was not backfilled.
- The Work-tab dead end explained that the old checks predated verified-set provenance and offered the audited `verification.rerun` action.
- The action re-ran the existing shadow verifier over queued tasks `T-001` and `T-002`, re-evaluated both scope gates, and ran the configured `npm test` command.
- The fresh disposable tree passed 7/7 tests.
- Verification id: `V-3cb6eede-625e-47ed-a6bd-1c24527c17b5`.
- Manifest: `.hivemind/resource/verification-sets/V-3cb6eede-625e-47ed-a6bd-1c24527c17b5/manifest.json`.
- Manifest SHA-256: `b224502319e7ab57885139600fccaf4831555312e425534431c4542b7f6cd567`.
- Verified result tree: `ca4e97a9f6732c2775179ec38e45d709bf528686`.

## Exact-set adoption

- Typed review id: `PA-27cf51d6-062b-45ac-ac53-10715c52d463`.
- Adoption id: `A-eb48f0d2-1a2f-46aa-8aa8-7cee9d4afdfe`.
- Base branch: `master`.
- Pre-adoption ref: `e440496766928f27fa527576e1855138ccf81b2e`.
- Adopted ref: `8bdd03f6bc0a544e5015e8d47d4c0966aa746ed1`.
- Adopted tree: `ca4e97a9f6732c2775179ec38e45d709bf528686`.
- The adopted commit's sole parent is the recorded pre-adoption ref.
- The durable `adoption.completed` event records both refs under `recoverability`; automatic rollback is false.
- Both task leases were released only after the guarded base transition and cleanup completed.
- An independent post-adoption `npm test` against `master` passed all 7 tests; the seed branch had contained 2.

## UI stages

1. `01-dead-end.jpg` - missing provenance is surfaced with a reason and a **Run checks again** action.
2. `02-fresh-verification.jpg` - the real verifier has produced a new immutable verification set.
3. `03-adoption-authorization.jpg` - typed authorization names `T-001 + T-002`, four changed files, and base `e4404967`.
4. `04-post-adoption.jpg` - Work shows zero pending decisions and **Merged** only after `adoption.completed` reconciles with the actual base ref.
5. `05-history.jpg` - History is terminal and states that both planned tasks merged into the project.

## Experience notes

The dead-end explanation was clear and made the recovery path discoverable. Re-verification completed in a few seconds and required no paid call. The authorization screen clearly identified the exact task set, file count, and base ref, which was enough to understand the atomic transition being authorized. It did not show the exact file list or patch content on the final screen; a reviewer wanting code-level confidence still has to inspect the task/change view first. That is the main remaining final-step information gap. The success toast was also generic, but the post-action Work and History projections correctly reconciled from durable adoption evidence.

