# Capability probe — first live connect, 2026-08-11

The first time Hivemind verified a coding agent instead of believing it.

`codex-cli 0.147.0`, a scratch git repository, `project.init` then
`adapter.connect` for the `worker` role. Ten seconds, 42,032 tokens.

## What was compared

Every line is a readback, not a request. `asked` is what the profile's argv sent;
`got` is what the provider itself reported.

| Capability | Asked | Got | Verdict |
| --- | --- | --- | --- |
| Carries no permission-bypass flags | — | — | verified (static, before spawn) |
| Runs without asking you anything | no prompts | `never` | verified |
| Can write in this project, and only here | `workspace-write` | `workspace-write` | verified |
| Runs the one model you chose | `gpt-5.6-terra` | `gpt-5.6-terra` | verified |
| Reports what it spent | `codex-jsonl` | 42,032 tokens | verified |
| Does not start agents of its own | off | `v2` | **unverified** |

`worker.connection.json` is the record it wrote; `worker.profile.json` is the
profile it wrote *after* the probe passed. A failed probe writes neither.

## How the readback was found

Three live runs, because the design could not be guessed:

1. `codex exec --json` emits `thread.started`, `turn.started`, `item.*` and
   `turn.completed`. **It names no model and no sandbox anywhere.** From the
   stream alone, four of the five required capabilities are unverifiable.
2. Codex writes a session rollout file per run — but `--ephemeral`, which every
   profile carries, suppresses it.
3. Dropping only `--ephemeral` produces a rollout whose `turn_context` record
   carries `model`, `sandbox_policy`, `approval_policy`, `workspace_roots` and
   `multi_agent_version`.

So the probe runs the profile's own argv with exactly one flag removed, and
locates the rollout by the `thread_id` the run prints on its own stdout — exact,
never a newest-file guess. That flag only decides whether the session is
persisted; probing a different invocation would prove nothing about the one that
runs real work.

## The two regressions this exists for

Both were a flag **accepted** and not **applied**:

- `--ignore-user-config` silently forced a read-only sandbox, and a worker that
  could not write anything was reported as fine.
- A model pin was silently ignored for months while config said otherwise.

Confinement is therefore proved twice over — the reported sandbox policy *and*
whether the file the agent was told to write is actually on disk, because a
silently read-only run reports success and writes nothing.

## What is proven live, and what is proven by test

The readback **mechanism** is live: a real run, a real rollout file, real values
compared. The **mismatch branches** are covered in `test/adapter-probe.test.ts`
with a stubbed readback — one test per regression — because making Codex
genuinely ignore its own `--model` is not something a test can arrange.

`unverified` is never `verified`. Only a failed required capability refuses a
connection; a capability with no readback is reported as unconfirmed and stays
that way on screen.
