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
