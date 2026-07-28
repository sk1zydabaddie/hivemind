# M7.4 Consolidation Behavioral Evidence

## Run Boundary

- Date: 2026-07-27 (America/Los_Angeles)
- Isolated repository: `D:\Projects\hivemind-m7-4-behavioral-20260727-1`
- Adapter: `codex-consolidator`
- Model: `gpt-5.5`
- Sandbox: `read-only`
- Invocation count permitted: one
- Retries performed: zero
- Canon files before run: zero
- Tier-1 events before run: 12
- Tier-1 `memory.proposed` events before run: zero

The adapter was configured to run in Hivemind's disposable consolidation directory with `--ignore-user-config`, `--ignore-rules`, and `--ephemeral`. The seed contains individual file-level rejections, provider/task outcomes with metrics, and shadow-integration results. It does not state a cross-event lesson in prose.

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

## One Approved Run

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

The current consolidation path returns only the adapter exit code for a non-zero process. It did not preserve or expose the child process's stdout/stderr, so no more specific provider-side error text is available from this run. No retry was made.

## Real Proposals (Verbatim)

No proposal JSON was produced.

```json
[]
```

After the run:

```text
Tier-1 event lines: 12
memory.proposed events: 0
canon files: 0
```

## Ledger

Hivemind's self-metered ledger recorded:

```json
{
  "provider": "codex-consolidator",
  "requests": 1,
  "input_tokens_estimated": 1507,
  "output_tokens_estimated": 20,
  "wall_time_ms": 240,
  "source": "self-metered",
  "unmetered": false
}
```

No provider-reported token count or monetary charge was returned. The behavioral quality criterion remains unverified because the adapter exited before producing proposals.
