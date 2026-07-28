# M7.4 Consolidation Behavioral Evidence

## Run Boundary

- Date: 2026-07-27 (America/Los_Angeles)
- Isolated repository: `D:\Projects\hivemind-m7-4-behavioral-20260727-1`
- Adapter: `codex-consolidator`
- Model: `gpt-5.5`
- Sandbox: `read-only`
- Initial adapter-startup attempts: one failed before reaching the model
- Paid behavioral invocations after diagnosis: one
- Retries performed within either attempt: zero
- Canon files before run: zero
- Tier-1 events before run: 12
- Tier-1 `memory.proposed` events before run: zero

The adapter was configured to run in Hivemind's disposable consolidation directory with `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, and a read-only sandbox. The seed contains individual file-level rejections, provider/task outcomes with metrics, and shadow-integration results. It does not state a cross-event lesson in prose.

## Seeded Tier-1 History (Verbatim)

```jsonl
{"ts":"2026-07-28T03:36:45.818Z","type":"patch.rejected","task_id":"T-101","data":{"run_id":"run-2026-07-02-01","task_type":"schema_migration","allowed_files":["src/migrations/add-profile-v2.ts"],"read_only_files":["src/schema/profile.ts"],"changed_files":["src/migrations/add-profile-v2.ts","src/schema/profile.ts"],"rejected_file":"src/schema/profile.ts","reason":"path is read-only under the granted lease"}}
{"ts":"2026-07-28T03:36:45.819Z","type":"patch.rejected","task_id":"T-107","data":{"run_id":"run-2026-07-05-03","task_type":"schema_migration","allowed_files":["src/migrations/add-ledger-v3.ts"],"read_only_files":["src/schema/ledger.ts"],"changed_files":["src/migrations/add-ledger-v3.ts","src/schema/ledger.ts"],"rejected_file":"src/schema/ledger.ts","reason":"path is read-only under the granted lease"}}
{"ts":"2026-07-28T03:36:45.819Z","type":"patch.rejected","task_id":"T-112","data":{"run_id":"run-2026-07-09-02","task_type":"schema_migration","allowed_files":["src/migrations/add-group-v2.ts"],"read_only_files":["src/schema/group.ts"],"changed_files":["src/migrations/add-group-v2.ts","src/schema/group.ts"],"rejected_file":"src/schema/group.ts","reason":"path is read-only under the granted lease"}}
{"ts":"2026-07-28T03:36:45.820Z","type":"task.completed","task_id":"T-201","data":{"run_id":"run-2026-07-11-01","provider":"codex","model":"gpt-5.5","task_type":"small_cli_command","wall_time_ms":42118,"input_tokens":5310,"output_tokens":1842,"revision_count":0,"patch_outcome":"accepted","integration_outcome":"passed","changed_files":["src/commands/add-person.ts","test/add-person.test.ts"]}}
{"ts":"2026-07-28T03:36:45.820Z","type":"task.completed","task_id":"T-204","data":{"run_id":"run-2026-07-12-04","provider":"codex","model":"gpt-5.5","task_type":"small_cli_command","wall_time_ms":47266,"input_tokens":5688,"output_tokens":2031,"revision_count":0,"patch_outcome":"accepted","integration_outcome":"passed","changed_files":["src/commands/list-people.ts","test/list-people.test.ts"]}}
{"ts":"2026-07-28T03:36:45.821Z","type":"task.failed","task_id":"T-209","data":{"run_id":"run-2026-07-14-02","provider":"claude","model":"claude-sonnet","task_type":"small_cli_command","wall_time_ms":120000,"input_tokens":7044,"output_tokens":196,"revision_count":0,"adapter_exit_code":124,"reason":"adapter timed out before producing a patch","changed_files":[]}}
{"ts":"2026-07-28T03:36:45.821Z","type":"task.completed","task_id":"T-213","data":{"run_id":"run-2026-07-16-01","provider":"claude","model":"claude-sonnet","task_type":"small_cli_command","wall_time_ms":138412,"input_tokens":9162,"output_tokens":3180,"revision_count":2,"patch_outcome":"rejected","integration_outcome":"not_run","changed_files":["src/commands/settle.ts","src/ledger.ts","package.json"]}}
{"ts":"2026-07-28T03:36:45.822Z","type":"integration.failed","task_id":"T-301","data":{"run_id":"run-2026-07-18-01","task_type":"mission_type_change","changed_files":["src/missions/types.ts"],"test_command":"npm run test:save","failed_test":"loads persisted mission fixture v3","error":"fixture v3 missing required field missionKind","exit_code":1}}
{"ts":"2026-07-28T03:36:45.822Z","type":"integration.failed","task_id":"T-305","data":{"run_id":"run-2026-07-20-02","task_type":"mission_type_change","changed_files":["src/missions/generator.ts","src/missions/types.ts"],"test_command":"npm run test:save","failed_test":"loads persisted mission fixture v2","error":"unknown mission type daily_combo while loading save v2","exit_code":1}}
{"ts":"2026-07-28T03:36:45.823Z","type":"integration.failed","task_id":"T-308","data":{"run_id":"run-2026-07-21-03","task_type":"mission_type_change","changed_files":["src/missions/rewards.ts","src/missions/types.ts"],"test_command":"npm run test:save","failed_test":"round-trips persisted mission fixture v3","error":"persisted rewardScale value does not satisfy the current mission schema","exit_code":1}}
{"ts":"2026-07-28T03:36:45.824Z","type":"integration.passed","task_id":"T-309","data":{"run_id":"run-2026-07-22-01","task_type":"mission_type_change","changed_files":["src/missions/types.ts","src/save/migrations/v4.ts","test/missions/types.test.ts","test/save/migrations-v4.test.ts"],"test_commands":["npm run test:missions","npm run test:save"],"test_count":38,"exit_code":0}}
{"ts":"2026-07-28T03:36:45.824Z","type":"integration.passed","task_id":"T-315","data":{"run_id":"run-2026-07-25-02","task_type":"mission_type_change","changed_files":["src/missions/rewards.ts","src/save/migrations/v5.ts","test/missions/rewards.test.ts","test/save/migrations-v5.test.ts"],"test_commands":["npm run test:missions","npm run test:save"],"test_count":42,"exit_code":0}}
```

The exact first 12 event lines remained unchanged through diagnosis and the paid run. Their UTF-8 JSONL SHA-256 is:

```text
0CFB278F8F2568339103852F0A005811A1E3D9C8297CE4E7C61F867FB5483008
```

## Initial Adapter-Startup Failure

Command:

```text
node D:\Projects\Hivemind AI\dist\src\cli.js memory consolidate --tool codex-consolidator
```

Observed process result:

```text
exit_code: 1
outer_wall_time_ms: 540
error: consolidation adapter "codex-consolidator" exited 1
```

The original adapter path discarded child stderr, so this first attempt did not expose a provider-side reason. No retry was made.

## Observability Fix And Diagnosis

Commit `d10dc7a` (`fix: preserve adapter failure diagnostics`) made every adapter invocation retain exit code, stdout, stderr, and a durable `.hivemind/log/runs/*.adapter.log` path. It also preserved nested daemon/fetch causes and applied the same diagnostic shape to ideation, planning, manager, redirect, Scout, consolidation, and worker-run failures.

Reproducing startup with an empty `CODEX_HOME` and no provider API keys then surfaced the exact original failure:

```text
consolidation adapter "codex-consolidator" exited 1; output log:
D:\Projects\hivemind-m7-4-behavioral-20260727-1\.hivemind\log\runs\2026-07-28T04-09-15-970Z-memory-consolidation-c3a060d4-c1c9-4416-8b53-42f1ed9cf776.adapter.log:
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

The consolidation mechanism intentionally launches the read-only adapter in an OS temporary directory, not in the target repository or a task worktree. The profile therefore needed the standard Codex `--skip-git-repo-check` flag. Codex CLI `0.145.0` accepted the remaining profile flags and model.

After adding only that flag, a second no-auth startup probe reported:

```text
workdir: C:\Users\ethan\AppData\Local\Temp\hivemind-consolidation-mIm13c
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
ERROR: 401 Unauthorized: Missing bearer or basic authentication
```

This probe proves the profile cleared Git/flag/model startup and reached the deliberately absent authentication boundary. It could not consume a paid model call. The 12-event seed hash remained unchanged.

### Quarantined Git Metadata

`D:\Projects\hivemind-m7-4-accidental-git-metadata-20260727` was a reversible quarantine of an accidental `D:\Projects\.git` directory created by an earlier fixture-setup `git init` run from the parent directory. It contained only standard empty-repository Git metadata. It was not the consolidation fixture, was not the OS temporary working directory used by the adapter, and was not involved in the startup failure.

Fixture setup now uses `scripts/create-isolated-fixture-repo.mjs`, which requires one absolute new target directory, creates only that directory, runs every Git command with its verified real path as `cwd`, and verifies that Git reports the same repository top-level. Regression tests prove that missing and pre-existing targets are refused before Git can touch the caller. After that fix passed, the user-approved quarantine was deleted following an exact real-path and parent-directory check.

## One Approved Paid Behavioral Run

Command:

```text
node D:\Projects\Hivemind AI\dist\src\cli.js memory consolidate --tool codex-consolidator
```

Observed process result:

```text
exit_code: 0
outer_wall_time_ms: 13909
source_event_count: 12
proposal_count: 5
```

## Real Proposals (Verbatim)

The adapter's exact stdout was:

```json
{"proposals":[{"title":"Proposed routing policy: schema migrations must not edit read-only schema files","lesson":"Routing policy proposal: schema_migration tasks should be scoped so workers update only the granted migration file, and any required schema source change should be split into a separate task with an explicit writable lease.","evidence":["events.jsonl#L1","events.jsonl#L2","events.jsonl#L3"]},{"title":"Proposed project decision: mission type changes require save migration coverage","lesson":"Project decision proposal: any mission_type_change that alters persisted mission shape, enum values, or reward fields must include the corresponding save migration and save-fixture tests in the same scoped task.","evidence":["events.jsonl#L8","events.jsonl#L9","events.jsonl#L10","events.jsonl#L11","events.jsonl#L12"]},{"title":"Proposed playbook: validate mission changes with both mission and save test suites","lesson":"Playbook proposal: run both mission-specific tests and save persistence tests for mission_type_change tasks, because failures surfaced in persisted fixture loading and round-tripping even when the changed code was under missions modules.","evidence":["events.jsonl#L8","events.jsonl#L9","events.jsonl#L10","events.jsonl#L11","events.jsonl#L12"]},{"title":"Proposed routing policy: prefer Codex for small CLI command tasks under current adapter settings","lesson":"Routing policy proposal: route small_cli_command tasks to Codex by default unless new evidence changes the pattern, because Codex completed comparable tasks with accepted patches and passing integration while Claude timed out or produced an out-of-scope rejected patch.","evidence":["events.jsonl#L4","events.jsonl#L5","events.jsonl#L6","events.jsonl#L7"]},{"title":"Proposed playbook: constrain small CLI command leases to command and test files","lesson":"Playbook proposal: small_cli_command tasks should receive narrow writable leases covering the command implementation and its focused test, with shared modules and package metadata excluded unless the contract explicitly requires them.","evidence":["events.jsonl#L4","events.jsonl#L5","events.jsonl#L7"]}]}
```

After the run:

```text
Tier-1 event lines: 17
original seed lines: 12
memory.proposed events: 5
canon files: 0
```

No proposal was promoted to canon.

## Spend And Ledger Reconciliation

The pre-paid-run Hivemind ledger baseline was:

```json
{
  "provider": "codex-consolidator",
  "requests": 3,
  "input_tokens_estimated": 4521,
  "output_tokens_estimated": 2276,
  "wall_time_ms": 15759
}
```

The post-run Hivemind ledger was:

```json
{
  "provider": "codex-consolidator",
  "requests": 4,
  "input_tokens_estimated": 6028,
  "output_tokens_estimated": 4965,
  "wall_time_ms": 29372
}
```

Paid-run delta:

```text
requests: 1
input_tokens_estimated: 1507
output_tokens_estimated: 2689
wall_time_ms: 13613
provider_reported_total_tokens: 14351
```

Codex authenticated through the user's ChatGPT login and did not expose a monetary charge, so no dollar amount is available.

## Human Behavioral Judgment

The user reviewed the unchanged raw seed and the five proposals and marked M7.4's behavioral acceptance **passed**:

- all three seeded cross-event patterns were found;
- two additional legitimate insights were produced;
- evidence citations were accurate and discriminating, including the fifth proposal correctly excluding the timeout event because it had no `changed_files`;
- the outputs were substantive distillations rather than placeholders or copied conclusions.

One non-blocking reasoning-quality note remains for future prompt tuning: proposal 3 inferred "run both suites" from successful runs that executed both suites, while the stronger causal distinction in the evidence was that the passing tasks also included the required save migration. This is loose causality, not an M7.4 acceptance failure.
