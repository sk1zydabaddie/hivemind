# Codex Prompt-Cache Experiment

Date: 2026-07-28

Purpose: test whether fresh Codex sessions miss prompt caching and whether sharing only a stable `prompt_cache_key` improves cache reuse without carrying conversation state.

Production Hivemind adapter profiles and the installed Codex binary were not modified.

## Prompt

All paid calls used:

> Reply exactly OK. Do not inspect files, call tools, or modify anything.

Model: `gpt-5.5`

Mode: `codex exec --json --ephemeral --sandbox read-only --ignore-user-config --ignore-rules --skip-git-repo-check`

## Paid Results

| Observation | Session shape | Input | Cached input | Output | Total | Validity |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Prior fresh baseline | Fresh installed CLI | 19,155 | 0 | 5 | 19,160 | Real, but its complete rendered invocation was not preserved well enough to prove byte identity with the new calls |
| A2 | Fresh installed CLI | 13,539 | 4,480 | 5 | 13,544 | Valid fresh-session observation |
| Intended B1 | Fresh isolated binary | 13,569 | 1,408 | 5 | 13,574 | Invalid as stable-key evidence; wire key remained a fresh UUID |
| Intended B2 | Fresh isolated binary | 13,569 | 1,408 | 5 | 13,574 | Invalid as stable-key evidence; wire key remained a fresh UUID |

New paid usage in this experiment:

```json
{
  "provider_calls": 3,
  "input_tokens": 40677,
  "cached_input_tokens": 7296,
  "output_tokens": 15,
  "total_tokens": 40692,
  "dollar_amount": null
}
```

The fresh installed-CLI observation disproves the absolute claim that fresh sessions receive no cache hits. Fresh sessions can receive partial cached input.

The intended stable-key pair does not test a stable key. It must not be used to estimate stable-key savings.

## Experiment-Harness Diagnosis

The installed Codex CLI `0.145.0` does not expose a supported cache-affinity option. Passing a top-level config value does not override the request key; the request builder defaults to the generated session ID.

An isolated build from the exact `rust-v0.145.0` source was used because its core already contains an internal `prompt_cache_key_override`. The first experiment patch populated that field during client construction. Normal session construction later called the internal override setter with `None`, replacing the experiment value. A localhost request capture therefore observed a generated UUID:

```json
{
  "prompt_cache_key": "019fab04-1f97-74c2-971e-4ac6140694b9",
  "model": "gpt-5.5",
  "store": false
}
```

After the paid-call limit was reached, the isolated harness was corrected so the experiment environment override is resolved at request construction time. A free localhost capture then proved that the corrected binary sends:

```json
{
  "prompt_cache_key": "hivemind-cache-proof-20260728-v1",
  "model": "gpt-5.5",
  "store": false,
  "input_items": 3
}
```

No further provider call was made. The stable-key cold/warm pair will not be run because the production CLI cannot expose the tested cache-only control.

## Statelessness Finding

`prompt_cache_key` is a request cache-routing/matching field, not a transcript identifier. The corrected wire capture retained `store=false` and fresh Codex thread construction. Changing this field alone does not invoke `codex exec resume`, provide a `previous_response_id`, or replay a rollout.

The shipped CLI currently does not expose that cache-only override. Its supported continuity mechanism is session resume, which does carry Codex-owned transcript state and is not an acceptable substitute for Hivemind's stateless-over-durable-store model.

If a supported cache-only override becomes available, its safe namespace should be derived from exact provenance rather than a global label: provider, model, Codex build, adapter/tool schema, repo identity, governing instructions/configuration, and a hash of the stable rendered prefix. This preserves fresh sessions while preventing unrelated repos or materially different write-influencing prefixes from sharing a cache-affinity namespace.

## Economic Result

The measured incremental saving from a stable key is unknown because no valid stable-key provider pair ran. The current eight-task estimate therefore remains approximately 1.1M-1.7M manager tokens before worker calls. No lower evidence-based number can be stated.

## Final Decision

Status: `WON'T DO` unless a future shipped Codex CLI exposes a supported cache-only override.

The premise that fresh Codex sessions never cache is false: A2 observed 4,480 cached input tokens out of 13,539, a 33.1% partial hit. The statelessness question is also settled: `prompt_cache_key` only affects cache routing/matching and does not itself resume or replay a transcript.

The optimization is nevertheless not adoptable today. Hivemind would have to vendor a patched Codex build solely for a cost optimization, or use `codex exec resume` and accept Codex-owned conversation history. The former creates an unjustified provider-CLI maintenance fork; the latter violates M6.6.

No replacement experiment calls will be made. Production adapters remain on fresh ephemeral sessions. The cost action is to reduce orchestrator call count, because the observed approximately 14K-19K harness floor is provider-owned and repeats per action.

If upstream exposes cache-only affinity later, the design remains exact-provenance scoped: provider, model, Codex build, adapter/tool schema, repository identity, governing instructions/configuration, and a hash of the stable rendered prefix.

## Sources

- [OpenAI Responses API reference: `prompt_cache_key`](https://platform.openai.com/docs/api-reference/responses-streaming/response/mcp_call_arguments)
- [Codex `rust-v0.145.0` request-key implementation](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/core/src/client.rs)
- [Codex request for cache affinity without transcript replay](https://github.com/openai/codex/issues/26283)
