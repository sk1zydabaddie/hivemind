# Contributing to Hivemind AI

## M3 Self-Protection Loop

Hivemind's protected merge workflow is available, but mandatory dogfooding is deferred through M7. M7 changes continue through the current Axiom-gated, direct scoped-contract workflow. A deliberate self-hosting demonstration may be run after M7 exists; it is not the M7 build mechanism.

When the protected workflow is used for a Hivemind feature or fix:

1. Write a C7 task contract under `.hivemind/tasks/<task_id>.contract.json`.
2. Build and submit the change through the harness so `.hivemind/patches/<task_id>/diff.patch` reflects the actual proposed repo diff.
3. Run `npm run build`.
4. From the target branch, run `node scripts/hivemind-protected-merge.mjs <task_id> <feature_ref>`.
5. Treat any non-zero exit as a blocked merge. Fix the contract or patch, resubmit, and rerun the protected merge.

`hivemind intent` remains optional until the M5 orchestrator phase. The required pre-merge safety check is the submitted patch's `hivemind analyze` verdict.
