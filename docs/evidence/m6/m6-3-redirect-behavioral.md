# M6.3 Redirect-First Behavioral Evidence

Date: 2026-07-07

Purpose: close the behavioral acceptance gap for M6.3 by capturing a real LLM-generated redirect correction, not a scripted fixture correction.

## Scenario

- Disposable repo: `C:\Users\ethan\AppData\Local\Temp\hivemind-m6-3-real-redirect-nC1QsU`
- Task: `T-REDIRECT-REAL`
- Contract scope: `README.md` only
- Granted lease: `README.md`
- Controlled drift: the worker/manager declared write-intent for `src/schema.ts`
- Deterministic gate result: `write intent rejected: src/schema.ts is not leased`

The harness used the existing manager redirect path. Scripted proposals created the contract, requested the lease, and submitted the out-of-scope write intent. The correction branch invoked real Codex once through a non-dangerous read-only adapter invocation, then stopped at the step limit before feeding the correction back to the worker.

## Real Orchestrator Correction

Codex CLI:

- Version: `OpenAI Codex v0.141.0`
- Model: `gpt-5.5`
- Sandbox: `read-only`
- Approval: `never`
- Exit code: `0`

Generated correction, verbatim:

```text
Your write intent targets src/schema.ts, but T-REDIRECT-REAL only leases and allows README.md. Re-declare the write intent with intended_files set to ["README.md"] only, then make only the scoped README fixture-note change required by the contract. Do not include src/schema.ts or any other file in the intent or patch; the required validation remains node -e "process.exit(0)".
```

## Event Trail

Observed durable events:

```text
task.created            T-REDIRECT-REAL
lease.approved          T-REDIRECT-REAL  granted README.md
write_intent.submitted  T-REDIRECT-REAL  intended_files=["src/schema.ts"]
write_intent.rejected   T-REDIRECT-REAL  reason="write intent rejected: src/schema.ts is not leased"
task.revision_requested T-REDIRECT-REAL  attempt=1 max_attempts=2 source=write_intent
task.redirected         T-REDIRECT-REAL  correction=<real Codex correction above>
```

Manager step summary:

```text
0 create_task_contract  autonomous  ok
1 request_lease         autonomous  ok
2 check_write_intent    redirect    rejected: write intent rejected: src/schema.ts is not leased
```

Reactive call trace:

```text
initial
after_create_task_contract_ok
after_request_lease_ok
real_correction_prompt
```

## Spend

Real paid provider calls: 1 Codex correction call.

Provider-reported usage from Codex stderr:

```text
tokens used: 17,043
```

Hivemind self-metered ledger for the wrapper adapter recorded 4 total manager adapter calls, because the three setup/proposal calls and the one real correction call all used the same wrapper profile:

```json
{
  "manager": {
    "used": {
      "requests": 4,
      "input_tokens_estimated": 6922,
      "output_tokens_estimated": 1645,
      "wall_time_ms": 31570
    },
    "source": "self-metered"
  }
}
```

## Recovery Continuation

After human judgment approved the correction quality, the same scenario was resumed. The recorded real correction was fed forward through the existing `revision_requested -> in_progress` path: the next write-intent was re-declared for `README.md` only, then the worker ran in the task worktree with the real correction included as redirect context.

Corrected write-intent:

```json
{
  "task_id": "T-REDIRECT-REAL",
  "intended_files": ["README.md"],
  "intended_symbols": [],
  "possible_risks": [],
  "will_not_change": []
}
```

Recovery manager steps:

```text
0 check_write_intent  autonomous      ok
1 create_worktree     autonomous      ok
2 run_worker          human_approval  ok
3 submit_patch        autonomous      ok
4 analyze_patch       autonomous      ok
```

Additional durable events:

```text
write_intent.submitted  T-REDIRECT-REAL  intended_files=["README.md"]
write_intent.approved   T-REDIRECT-REAL  intended_files=["README.md"]
task.run_accepted       T-REDIRECT-REAL  tool=codex-recovery-worker
task.started            T-REDIRECT-REAL  tool=codex-recovery-worker
cache.read              T-REDIRECT-REAL  README.md read for write-context
task.completed          T-REDIRECT-REAL  tool_exit=0 changed_files=1
patch.submitted         T-REDIRECT-REAL  changed_files=1
patch.accepted          T-REDIRECT-REAL  verdict=accept reason="all changes are within scope"
```

The real worker received the correction as durable redirect context:

```text
M6.3 redirect correction from durable task.redirected event:
Your write intent targets src/schema.ts, but T-REDIRECT-REAL only leases and allows README.md. Re-declare the write intent with intended_files set to ["README.md"] only, then make only the scoped README fixture-note change required by the contract. Do not include src/schema.ts or any other file in the intent or patch; the required validation remains node -e "process.exit(0)".
```

Worker response excerpt:

```text
I'll keep this to the leased file only: verify the current README, make the one-line fixture note, run the required no-op Node check, and stop without committing.
```

Worker diff:

```diff
diff --git a/README.md b/README.md
index cca436f..33ffa78 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Redirect behavioral fixture
 
 Only this file is in scope.
+
+Scoped redirect recovery fixture note.
```

Worker validation:

```text
node -e "process.exit(0)"  passed
```

Outcome:

- Worker exit: `0`
- Changed files: `1`
- Changed path: `README.md`
- Analyze verdict: `accept`
- `task.cancelled` events: none
- Full cancel/restart: none

## Continuation Spend

Additional paid provider calls: 1 Codex worker call.

Provider-reported usage from Codex stderr:

```text
tokens used: 63,864
```

Hivemind self-metered delta after continuation:

```json
{
  "codex-recovery-worker": {
    "used": {
      "requests": 1,
      "input_tokens_estimated": 238,
      "output_tokens_estimated": 2330,
      "wall_time_ms": 82046
    },
    "source": "self-metered"
  },
  "manager": {
    "used": {
      "requests": 10,
      "input_tokens_estimated": 24992,
      "output_tokens_estimated": 1864,
      "wall_time_ms": 32058
    },
    "source": "self-metered"
  }
}
```

The `manager` count includes no-paid scripted wrapper proposal calls plus the earlier real correction call because they shared the same disposable adapter profile name.
