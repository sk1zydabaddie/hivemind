import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  catalogueModels,
  catalogueProviders,
  innerProviderIdForModelSlug,
  innerProviderStanding,
  judgeInnerProvider,
  supportTierForHarness
} from "../src/agent-catalogue.js";
import { connectDiscoveredAdapter, initProjectForDesktop } from "../src/config-actions.js";
import { discoverProviderModels } from "../src/model-discovery.js";
import { parseAuthenticationStatus } from "../src/provider-auth-status.js";

const run = promisify(execFile);

async function repoWithProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-multiplier-test-"));
  await run("git", ["init"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.test"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(path.join(dir, "package.json"), '{"name":"t","scripts":{"test":"node --test"}}\n', "utf8");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-m", "base"], { cwd: dir });
  return dir;
}

/* ── The slug grammar: the inner provider is the FIRST segment ─────────────
 *
 * Measured against `opencode models` on 1.18.x: `openrouter/anthropic/claude-*`
 * is OPENROUTER's API-key credential reselling an Anthropic model. Reading the
 * second segment would call that combination prohibited when the credential at
 * stake is OpenRouter's, and the whole registry would judge the wrong party. */
test("the inner provider is the slug's first segment, never the model's author", () => {
  assert.equal(innerProviderIdForModelSlug("openai/gpt-5.6"), "openai");
  assert.equal(innerProviderIdForModelSlug("openrouter/anthropic/claude-opus-4.5"), "openrouter");
  assert.equal(innerProviderIdForModelSlug("opencode/deepseek-v4-flash-free"), "opencode");
  /* Alias spellings collapse onto the registry id. */
  assert.equal(innerProviderIdForModelSlug("moonshotai/kimi-latest"), "moonshot");
  /* A slug with no separator names no inner provider — integrated harnesses
     pass bare model names and get no judgement at all. */
  assert.equal(innerProviderIdForModelSlug("gpt-5.6-terra"), null);
  assert.equal(innerProviderIdForModelSlug(null), null);
});

test("judgement: prohibited refuses by name, unchecked warns, unknown stays unchecked", () => {
  const anthropic = judgeInnerProvider("opencode", "anthropic/claude-opus-4.5");
  assert.equal(anthropic.standing?.sanction, "prohibited");
  assert.notEqual(anthropic.refusal, null);
  /* The refusal must point at the door that IS open. */
  assert.match(anthropic.refusal ?? "", /Claude Code is a first-class integration/u);

  /* The same model through OpenRouter is OpenRouter's credential: not the
     banned pattern, and refusing it would misjudge the party involved. */
  const viaOpenRouter = judgeInnerProvider("opencode", "openrouter/anthropic/claude-opus-4.5");
  assert.equal(viaOpenRouter.refusal, null);
  assert.equal(viaOpenRouter.standing?.id, "openrouter");
  assert.equal(viaOpenRouter.standing?.sanction, "unchecked");

  const openai = judgeInnerProvider("opencode", "openai/gpt-5.6");
  assert.equal(openai.refusal, null);
  assert.equal(openai.standing?.sanction, "blessed");

  /* A provider somebody configured locally that Hivemind has never heard of:
     unchecked, not invented into either verdict. */
  const custom = judgeInnerProvider("opencode", "audn/necromicon");
  assert.equal(custom.refusal, null);
  assert.equal(custom.standing?.sanction, "unchecked");

  /* Integrated harnesses get no inner-provider judgement at all. */
  assert.deepEqual(judgeInnerProvider("codex-cli", "gpt-5.6-terra"), {
    standing: null,
    refusal: null
  });

  /* Every registry entry names its evidence and the date it was checked. */
  for (const id of ["openai", "xai", "moonshot", "anthropic", "openrouter"]) {
    const standing = innerProviderStanding(id);
    assert.ok(standing.why.length > 30, `${id} has no recorded evidence`);
    assert.match(standing.checked, /^\d{4}-\d{2}-\d{2}$/u, `${id} has no checked date`);
  }
});

test("the two support claims are distinguishable and attached to the right harnesses", () => {
  assert.equal(supportTierForHarness("opencode"), "multiplier");
  for (const harness of ["codex-cli", "claude", "grok", "kimi"]) {
    assert.equal(supportTierForHarness(harness), "integrated", harness);
  }
  const providers = catalogueProviders();
  const opencode = providers.find((provider) => provider.id === "opencode");
  assert.equal(opencode?.support_tier, "multiplier");
  /* The claim itself travels with the row, and it is the honest one: gates
     hold, economics do not. */
  assert.match(opencode?.tier_claim ?? "", /spending limits in tokens/u);
  assert.match(opencode?.tier_claim ?? "", /cannot be confirmed/u);
  for (const provider of providers.filter((entry) => entry.id !== "opencode")) {
    assert.equal(provider.support_tier, "integrated", provider.id);
  }
  /* Catalogue models carry the standing so pickers can say it before a pick. */
  const opencodeModel = catalogueModels("opencode")[0];
  assert.equal(opencodeModel?.inner_provider?.id, "opencode");
  assert.equal(opencodeModel?.inner_provider?.sanction, "blessed");
  assert.equal(catalogueModels("codex-cli")[0]?.inner_provider, null);
});

/* ── The money gate: a prohibited combination is refused while it costs nothing.
 *
 * Proven to bite: with the gate moved after the probe, `probeRuns` reads 1 and
 * the second assertion fails. The refusal has to happen before any provider
 * call and before any file lands in the project. */
test("anthropic-behind-opencode is refused before the probe and before any write", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    let probeRuns = 0;
    const discoveryRunner = async (spec: { kind: string }) => ({
      ok: spec.kind === "line-list",
      stdout:
        spec.kind === "line-list"
          ? "anthropic/claude-opus-4.5\nopencode/deepseek-v4-flash-free\n"
          : "",
      stderr: "",
      reason: spec.kind === "line-list" ? null : "not installed"
    });
    const refused = await connectDiscoveredAdapter(repo, "worker", "opencode", "anthropic/claude-opus-4.5", {
      discoveryRunner,
      probe: {
        runner: async () => {
          probeRuns += 1;
          throw new Error("the probe must never run for a prohibited inner provider");
        }
      }
    });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /Anthropic/u);
    assert.match(refused.ok ? "" : refused.reason, /Claude Code is a first-class integration/u);
    assert.equal(probeRuns, 0, "a refusal that cost a provider call is not a refusal");
    /* And nothing was written: no profile, no connection record, no harness
       project config for a connection that never happened. */
    const files = await readdir(path.join(repo, ".hivemind", "adapters")).catch(() => []);
    assert.ok(
      !files.some((file) => file.includes("connection")),
      `a refused connection left records: ${files.join(", ")}`
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("discovery marks a prohibited model unselectable and says why, before any pick", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const view = await discoverProviderModels(repo, {
      runner: async (spec) => ({
        ok: spec.kind === "line-list",
        stdout:
          spec.kind === "line-list"
            ? "anthropic/claude-opus-4.5\nopenai/gpt-5.6\ngithub-copilot/gpt-5.6\n"
            : "",
        stderr: "",
        reason: spec.kind === "line-list" ? null : "not installed"
      })
    });
    const opencode = view.providers.find((provider) => provider.provider_id === "opencode");
    assert.equal(opencode?.status, "detected");
    const bySlug = new Map(opencode!.models.map((model) => [model.slug, model]));

    const anthropic = bySlug.get("anthropic/claude-opus-4.5");
    assert.equal(anthropic?.selectable, false);
    assert.equal(anthropic?.inner_provider?.sanction, "prohibited");

    const openai = bySlug.get("openai/gpt-5.6");
    assert.equal(openai?.selectable, true);
    assert.equal(openai?.inner_provider?.sanction, "blessed");

    /* Unchecked is selectable — with the standing carried so the surface can
       say "unchecked" before the pick, which is the whole point of the word. */
    const copilot = bySlug.get("github-copilot/gpt-5.6");
    assert.equal(copilot?.selectable, true);
    assert.equal(copilot?.inner_provider?.sanction, "unchecked");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* ── The auth-list boundary: recognised names cross, raw strings never do ──
 *
 * The fixture is the REAL `opencode auth list` output measured on this
 * machine on 2026-08-22 (ANSI codes included), with one recognised entry per
 * section and one user-configured provider Hivemind has never heard of. */
test("auth-list reaches: registry names cross with their sanction, the rest are only counted", () => {
  const fixture = [
    "T  Credentials [90m~\\.local\\share\\opencode\\auth.json",
    "|",
    "•  audn [90mapi",
    "|",
    "—  1 credentials",
    "",
    "T  Environment",
    "|",
    "•  OpenRouter [90mOPENROUTER_API_KEY",
    "|",
    "—  1 environment variable"
  ].join("\n");
  const standing = parseAuthenticationStatus("opencode", "credential-count", fixture);
  assert.equal(standing.status, "signed_in");
  assert.deepEqual(
    standing.reaches?.providers.map((provider) => [provider.id, provider.sanction]),
    [["openrouter", "unchecked"]]
  );
  /* "audn" is somebody's own configured provider: it is counted, and the
     string itself never crosses the boundary. */
  assert.equal(standing.reaches?.unrecognised, 1);
  assert.ok(!JSON.stringify(standing).includes("audn"));

  /* No entries at all: the field stays absent rather than empty-but-present,
     so old-daemon consumers and new ones read the same shape. */
  const none = parseAuthenticationStatus("opencode", "credential-count", "—  0 credentials");
  assert.equal(none.status, "signed_out");
  assert.equal(none.reaches, undefined);
});
