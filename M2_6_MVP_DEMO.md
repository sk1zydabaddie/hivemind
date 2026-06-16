# M2.6 MVP Demo

This document records the M2.6 demo shape for the local MVP gate.

## No-Paid Deterministic Demo

The automated M2.6 gate uses local fake adapters, not paid provider calls.

The test creates a disposable repo on `main`, then:

1. Creates two disjoint task contracts.
2. Grants file leases for each task.
3. Runs two fake agents concurrently in separate Hivemind worktrees.
4. Submits both patch bundles.
5. Runs the deterministic analyzer for both patches.
6. Confirms the in-scope patch is accepted.
7. Confirms the out-of-scope patch is rejected and names the edited file.
8. Queues both tasks for shadow integration.
9. Runs `hivemind integrate --shadow`.
10. Confirms only the accepted patch is applied, tests pass, and the shadow branch is removed.
11. Runs `hivemind status` and verifies it reports tasks, leases, patch verdicts, queue state, and integration status.

This proves the Phase-1 MVP safety path without relying on external model availability, account state, or quota.

## Optional Real-Adapter Manual Demo

The same flow can be run manually with real adapter profiles after explicit approval for provider usage:

```powershell
hivemind lease T-001
hivemind lease T-002
hivemind run T-001 --tool codex --allow-dangerous-adapter
hivemind run T-002 --tool claude --allow-dangerous-adapter
hivemind submit T-001
hivemind submit T-002
hivemind analyze T-001
hivemind analyze T-002
hivemind integrate --shadow
hivemind status
```

Use disposable task scopes for the manual demo. Do not treat real-provider output as required automated evidence for M2.6.

## Boundaries

- `hivemind status` is read-only.
- `integrate --shadow` never merges to `main`.
- Final merge remains a separate human-approved action.
- Event logging is not part of M2.6; it begins in M2.7.
- Dashboard, daemon, MCP status tools, and manager-agent behavior remain later milestones.
