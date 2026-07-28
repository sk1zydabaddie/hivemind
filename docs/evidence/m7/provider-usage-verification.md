# Provider Usage Verification

Date: 2026-07-28

Purpose: verify Hivemind's Codex JSONL usage parser and dual-channel ledger against one real provider response.

## Invocation

- Provider calls that reached a model: 1
- Adapter mode: `codex exec --json`
- Sandbox: `read-only`
- Prompt: `Reply exactly OK. Do not inspect files, call tools, or modify anything.`
- Process exit: `0`
- Wall time: `5,362 ms`
- Model output: `OK`

A preceding local harness attempt failed at Windows process startup with `spawn EINVAL` while trying to launch `codex.cmd` directly. Codex never started, so that attempt made no provider request and incurred no provider usage. The successful run used the established `cmd.exe /d /s /c codex.cmd ...` wrapper.

## Captured Provider Usage

```json
{
  "status": "captured",
  "parser": "codex-jsonl",
  "input_tokens": 19155,
  "cached_input_tokens": 0,
  "output_tokens": 5,
  "reasoning_tokens": null,
  "total_tokens": 19160
}
```

The live Codex JSONL usage record did not expose a separate reasoning-token field for this request. Hivemind records that component as `null`; it does not infer or fabricate it.

## Self-Measured Usage

```json
{
  "requests": 1,
  "input_tokens_estimated": 18,
  "output_tokens_estimated": 1,
  "wall_time_ms": 5362
}
```

## Reconciliation

```json
{
  "self_measured_tokens_for_reported_requests": 19,
  "provider_reported_total_tokens": 19160,
  "absolute_divergence_tokens": 19141,
  "provider_to_self_ratio": 1008.421052631579,
  "accounting_source": "provider_reported",
  "routing_source": "profile_policy"
}
```

The provider-reported total is the effective token count for ceiling/accounting purposes. The provider did not report a dollar amount, so monetary spend cannot be stated from this evidence.

## Claude Status

Claude JSON usage parsing remains fixture-tested but unverified against a real Claude provider response. No Claude provider call was made in this verification.

## Fixed Per-Call Overhead

The Hivemind-authored prompt was estimated at 18 input tokens, while Codex reported 19,155 input tokens. The difference is approximately 19,137 input tokens of Codex-owned system instructions, tool schemas, and harness context that Hivemind cannot observe before invocation.

Corroborating real-call totals already recorded in the repo:

- This trivial verification: 19,160 total tokens.
- M7.4 consolidation: 14,351 total tokens.
- First M6.3 correction: 17,043 total tokens.

The observed fresh-call floor is therefore approximately 14K-19K tokens. At the manager's current roughly one-call-per-action cadence, 10-11 calls for a small task imply approximately 140K-209K tokens before worker variability. Eight such tasks imply approximately 1.1M-1.7M manager-call tokens before worker calls.

## Prompt-Cache Investigation

No additional provider calls were made for this investigation.

- Codex supports cached-input accounting in `codex exec --json`. The official non-interactive documentation includes a `turn.completed` example with `input_tokens: 24763` and `cached_input_tokens: 24448`.
- The same documentation defines `--ephemeral` as disabling persisted session rollout files. It defines `--ignore-user-config` and `--ignore-rules` as suppressing local config and rule loading. None of these flags is documented as disabling provider prompt caching.
- Current Codex source constructs a `prompt_cache_key` for every Responses request and defaults it to the Codex session ID.
- Hivemind starts a fresh `codex exec` process/session for each manager action. Therefore the default cache key changes across actions even when Hivemind's own prompt prefix is byte-identical. Removing `--ephemeral` alone would persist rollout files but would not make separate `codex exec` invocations resume the same session.
- This verification is the only real Hivemind JSONL usage record with a cached-input breakdown, and it reported `cached_input_tokens: 0`. M6.3 and M7.4 recorded text-mode provider totals without a cached-input component. A repo-wide evidence scan found no nonzero real Hivemind cached-input observation.

The evidence supports intra-session cache capability but does not demonstrate cross-action cache reuse in Hivemind. The fresh-session/default-session-key pattern likely partitions those actions into separate cache buckets. No adapter flag was changed.

Official sources:

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)
- [Codex client prompt-cache key implementation](https://github.com/openai/codex/blob/1def0a8925cd9df462cbd7cec355458198015473/codex-rs/core/src/client.rs)
