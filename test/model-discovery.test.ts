import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverProviderModels,
  parseDiscoveryOutput
} from "../src/model-discovery.js";

test("every provider-owned output shape yields only valid model arguments", () => {
  assert.deepEqual(
    parseDiscoveryOutput(
      "app-server",
      JSON.stringify({
        data: [
          { model: "gpt-visible", displayName: "GPT Visible", hidden: false },
          { model: "gpt-hidden", displayName: "GPT Hidden", hidden: true }
        ]
      })
    ),
    [{ slug: "gpt-visible", label: "GPT Visible" }]
  );
  assert.deepEqual(
    parseDiscoveryOutput(
      "help-aliases",
      "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name"
    ).map((entry) => entry.slug),
    ["fable", "opus", "sonnet"]
  );
  assert.deepEqual(
    parseDiscoveryOutput("line-list", "provider/model-a\nnot a slug\nprovider/model-b\n").map((entry) => entry.slug),
    ["provider/model-a", "provider/model-b"]
  );
  assert.deepEqual(
    parseDiscoveryOutput(
      "headed-list",
      "Default model: grok-4.6\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n"
    ).map((entry) => entry.slug),
    ["grok-4.6", "grok-4.5"]
  );
  assert.deepEqual(
    parseDiscoveryOutput(
      "alias-config",
      '{"providers":{"custom":{}},"models":{"coding":{"provider":"custom","model":"model-v1"}}}'
    ),
    [{ slug: "coding", label: "coding · model-v1" }]
  );
});

test("discovery reports empty and failed providers without inventing fallback models", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-model-discovery-test-"));
  try {
    const result = await discoverProviderModels(repo, {
      runner: async (spec) => {
        if (spec.kind === "app-server") {
          return {
            ok: true,
            stdout: '{"data":[{"model":"gpt-a","displayName":"GPT A","hidden":false}]}',
            stderr: "",
            reason: null
          };
        }
        if (spec.kind === "headed-list") {
          return { ok: false, stdout: "", stderr: "", reason: "not signed in" };
        }
        if (spec.kind === "alias-config") {
          return { ok: true, stdout: '{"providers":{},"models":{}}', stderr: "", reason: null };
        }
        return { ok: true, stdout: "", stderr: "", reason: null };
      }
    });
    assert.deepEqual(
      result.providers.find((entry) => entry.provider_id === "codex-cli")?.models,
      /* An integrated harness's models carry no inner-provider judgement and
         are always selectable — the multiplier fields exist but say nothing. */
      [{ slug: "gpt-a", label: "GPT A", inner_provider: null, selectable: true }]
    );
    assert.equal(result.providers.find((entry) => entry.provider_id === "grok")?.status, "unavailable");
    assert.equal(result.providers.find((entry) => entry.provider_id === "kimi")?.status, "empty");
    assert.deepEqual(result.providers.find((entry) => entry.provider_id === "kimi")?.models, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
