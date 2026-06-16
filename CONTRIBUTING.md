# Contributing to Hivemind AI

## M3 Self-Protection Loop

Hivemind changes must go through Hivemind's own gate before they merge.

For each Hivemind feature or fix:

1. Write a C7 task contract under `.hivemind/tasks/<task_id>.contract.json`.
2. Build and submit the change through the harness so `.hivemind/patches/<task_id>/diff.patch` reflects the actual proposed repo diff.
3. Run `npm run build`.
4. From the target branch, run `node scripts/hivemind-protected-merge.mjs <task_id> <feature_ref>`.
5. Treat any non-zero exit as a blocked merge. Fix the contract or patch, resubmit, and rerun the protected merge.

`hivemind intent` remains optional until the M5 orchestrator phase. The required pre-merge safety check is the submitted patch's `hivemind analyze` verdict.
