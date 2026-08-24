import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { connectAdapter, initProjectForDesktop } from "../src/config-actions.js";
import {
  readCachedVerdict,
  verdictCacheDirectory,
  verdictKey,
  writeCachedVerdict
} from "../src/verdict-cache.js";
import { currentMachine } from "../src/verification-standing.js";
import { findCatalogueAgent } from "../src/agent-catalogue.js";
import { readAdapterVersion } from "../src/adapter-version.js";
import { harnessConfigDigest } from "../src/harness-config-digest.js";

const run = promisify(execFile);

async function repoWithProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-verdict-test-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.test"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(
    path.join(dir, "package.json"),
    '{"name":"t","scripts":{"test":"node --test"}}\n',
    "utf8"
  );
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

/** An isolated state directory, so a test never reads or writes the real one. */
async function isolatedState(): Promise<{ dir: string; restore: () => void }> {
  const previous = process.env.HIVEMIND_STATE_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-state-"));
  process.env.HIVEMIND_STATE_DIR = dir;
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env.HIVEMIND_STATE_DIR;
      else process.env.HIVEMIND_STATE_DIR = previous;
    }
  };
}

const CAPABILITIES = [
  {
    id: "confined_to_project" as const,
    label: "Can write in this project, and only here",
    status: "verified" as const,
    evidence: "readback" as const,
    requested: "workspace-write",
    reported: "workspace-write",
    detail: "measured",
    required: true
  }
];

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: CAPABILITIES,
    effective_tokens: 42_711,
    readback_source: "test rollout",
    provider_version: "1.2.3",
    measured_at: "2026-08-23T00:00:00.000Z",
    machine: currentMachine("C:/home/codex"),
    config_digest: "digest-a",
    ...overrides
  } as Parameters<typeof writeCachedVerdict>[1];
}

function inputs(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "codex-luna",
    harness: "codex-cli",
    providerVersion: "1.2.3",
    configDigest: "digest-a",
    machine: currentMachine("C:/home/codex"),
    ...overrides
  } as Parameters<typeof readCachedVerdict>[0];
}

/* ── The cache lives outside every repository ──────────────────────────────
 *
 * This is the whole separation from a verdict that arrived by clone. Connection
 * records are gitignored because a measurement from somebody else's machine
 * must never be inherited; a machine-scoped cache is a different object because
 * it is not in a working tree at all. */
test("the cache is stored outside any project, in the user's own state directory", async () => {
  const state = await isolatedState();
  const repo = await repoWithProject();
  try {
    assert.equal(verdictCacheDirectory(), state.dir);
    await writeCachedVerdict(inputs(), verdict());

    /* Nothing was written into the project, so git cannot see it and a clone
       cannot carry it. */
    const tracked = await run("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repo
    });
    assert.equal(tracked.stdout.trim(), "");
    const stateFiles = await readdir(state.dir);
    assert.ok(stateFiles.length > 0, "the verdict was not written to the state directory");
  } finally {
    state.restore();
    await rm(repo, { recursive: true, force: true });
    await rm(state.dir, { recursive: true, force: true });
  }
});

/* ── Every input that could change the answer is part of the key ───────────
 *
 * A probe measures one binary, one account, one machine. Change any of those,
 * or the harness configuration it ran under, and the old measurement describes
 * something else. */
test("a different version, digest, account or machine misses the cache", async () => {
  const state = await isolatedState();
  try {
    await writeCachedVerdict(inputs(), verdict());
    assert.notEqual(await readCachedVerdict(inputs()), null, "the exact inputs must hit");

    for (const [name, changed] of [
      ["a newer binary", inputs({ providerVersion: "1.2.4" })],
      ["a changed instruction file", inputs({ configDigest: "digest-b" })],
      ["a different account home", inputs({ machine: currentMachine("C:/home/other") })],
      ["a different agent", inputs({ agentId: "codex-terra" })]
    ] as const) {
      assert.equal(await readCachedVerdict(changed), null, `${name} must miss`);
    }

    /* And a different MACHINE misses even when everything else matches --
       the case that keeps a synced home directory or a copied profile from
       handing over a measurement this machine never made. */
    const stranger = { ...currentMachine("C:/home/codex"), host: "somebody-elses-laptop" };
    assert.equal(await readCachedVerdict(inputs({ machine: stranger })), null);

    /* The forgery that matters: an entry sitting under THIS machine's key while
       the measurement inside it says it came from somewhere else. The key is a
       hash, so it can be arrived at; the stored identity is compared anyway,
       which is what makes the guarantee local rather than a property of the
       key. (The first version of this test wrote the entry under the
       stranger's key and then read with ours, which only re-proved that a
       different key misses -- and passed against a cache that trusted its
       keys.) */
    await writeCachedVerdict(inputs(), verdict({ machine: stranger }));
    assert.equal(await readCachedVerdict(inputs()), null, "a foreign entry was adopted");
  } finally {
    state.restore();
    await rm(verdictCacheDirectory(), { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the key covers each input, so no two situations collide", () => {
  const base = verdictKey(inputs());
  for (const changed of [
    inputs({ agentId: "codex-terra" }),
    inputs({ harness: "claude" }),
    inputs({ providerVersion: "9.9.9" }),
    inputs({ configDigest: "digest-b" }),
    inputs({ machine: currentMachine("C:/home/other") })
  ]) {
    assert.notEqual(verdictKey(changed), base);
  }
  /* Same inputs, same key -- otherwise nothing would ever hit. */
  assert.equal(verdictKey(inputs()), base);
});

/* ── A second project adopts rather than paying again ──────────────────────
 *
 * The friction this exists to remove: three providers on a new project meant
 * three real provider calls and about a minute of waiting, per project, to
 * re-learn what this machine already knew.
 *
 * Proven to bite: remove the cache lookup from `connectCatalogueAgent` and the
 * second project's probe count goes from 0 to 1. */
test("a second project adopts this machine's verdict without a provider call", async () => {
  const state = await isolatedState();
  const first = await repoWithProject();
  const second = await repoWithProject();
  try {
    await initProjectForDesktop(first);
    await initProjectForDesktop(second);

    let probes = 0;
    const probeOnce = {
      runner: async () => {
        probes += 1;
        return {
          ok: true,
          reason: null,
          stdout:
            '{"type":"thread.started","thread_id":"abc"}\n{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":20}}',
          stderr: "",
          exitCode: 0,
          timedOut: false,
          wallTimeMs: 100,
          effectiveTokens: 1020,
          wroteNonceFile: true
        };
      },
      readback: async () => ({
        source: "test rollout",
        model: "gpt-5.6-luna",
        sandbox: "workspace-write" as const,
        approvalPolicy: "never",
        workspaceRoots: [first],
        subagents: "none",
        version: "1.2.3"
      })
    };

    /* The first connection measures. A supplied runner deliberately bypasses
       the cache -- a caller testing the probe must not have it skipped -- so
       this also seeds nothing, and the seeding path is exercised below. */
    const firstConnect = await connectAdapter(first, "worker", "codex-luna", probeOnce);
    assert.equal(firstConnect.ok, true, firstConnect.ok ? undefined : firstConnect.reason);
    assert.equal(probes, 1);

    /* Seed the cache with the inputs CONNECT will compute, not invented ones.
       The version is read from the installed binary for free, so a made-up
       string cannot hit -- which is how the first version of this test failed,
       and is the cache behaving correctly. */
    const machine = currentMachine(null);
    const agent = findCatalogueAgent("codex-luna");
    assert.ok(agent?.invoke, "codex-luna has no invocation to read a version from");
    const version = await readAdapterVersion(agent!.invoke!, second).catch(() => null);
    const digestNow = await harnessConfigDigest(second, () => null);
    const recorded = JSON.parse(
      await readFile(path.join(first, ".hivemind", "adapters", "worker-codex-luna.connection.json"), "utf8")
    ) as { capabilities: unknown[] };
    await writeCachedVerdict(
      {
        agentId: "codex-luna",
        harness: "codex-cli",
        providerVersion: version,
        configDigest: digestNow,
        machine
      },
      verdict({
        capabilities: recorded.capabilities,
        provider_version: version,
        config_digest: digestNow,
        machine
      })
    );

    const adopted = await connectAdapter(second, "worker", "codex-luna");
    assert.equal(adopted.ok, true, adopted.ok ? undefined : adopted.reason);
    const record = JSON.parse(
      await readFile(path.join(second, ".hivemind", "adapters", "worker-codex-luna.connection.json"), "utf8")
    ) as { verdict_source?: { kind: string; measured_at: string }; capabilities: unknown[] };
    /* Adopted, and RECORDED as adopted: this project did not pay for a probe
       and the record must not imply that it did. */
    assert.equal(record.verdict_source?.kind, "machine_cache");
    assert.equal(typeof record.verdict_source?.measured_at, "string");
    assert.ok(record.capabilities.length > 0);
  } finally {
    state.restore();
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
    await rm(verdictCacheDirectory(), { recursive: true, force: true }).catch(() => undefined);
  }
});
