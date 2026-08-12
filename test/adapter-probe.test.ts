import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { probeAdapter, probeInvocation, requestedModel, type ProbeObservation } from "../src/adapter-probe.js";
import { findCatalogueAgent } from "../src/agent-catalogue.js";
import { buildProfileForAgent, connectAdapter } from "../src/config-actions.js";
import type { AdapterProfile } from "../src/adapter.js";

/**
 * The probe exists because a flag being ACCEPTED is not a flag being APPLIED.
 * Two regressions in this project were exactly that shape, so every test here
 * asks the same question: when the provider reports something different from
 * what was asked for, does the connection refuse?
 */

const agent = findCatalogueAgent("codex-terra")!;

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-probe-test-"));
  return dir;
}

function observation(overrides: Partial<ProbeObservation> = {}): ProbeObservation {
  return {
    ok: true,
    reason: null,
    stdout: '{"type":"thread.started","thread_id":"abc"}\n{"type":"turn.completed","usage":{"input_tokens":40764,"output_tokens":187}}',
    stderr: "",
    exitCode: 0,
    timedOut: false,
    wallTimeMs: 12_000,
    effectiveTokens: 40_951,
    wroteNonceFile: true,
    ...overrides
  };
}

function readback(overrides: Record<string, unknown> = {}) {
  return async () => ({
    source: "rollout-test.jsonl",
    model: "gpt-5.6-terra",
    sandbox: "workspace-write",
    approvalPolicy: "never",
    workspaceRoots: ["/repo"],
    subagents: "v2",
    ...overrides
  });
}

test("a clean probe verifies every required capability", async () => {
  const repo = await scratch();
  try {
    const profile = buildProfileForAgent(agent, "worker")!;
    const result = await probeAdapter(repo, agent, profile, {
      runner: async () => observation(),
      readback: readback()
    });
    assert.equal(result.ok, true);
    const byId = new Map(result.capabilities.map((entry) => [entry.id, entry]));
    for (const id of ["no_bypass_flags", "non_interactive", "pins_one_model", "confined_to_project", "reports_usage"]) {
      assert.equal(byId.get(id as never)?.status, "verified", `${id} should be verified`);
    }
    // Reported, not requested: the number comes out of the run's own output.
    assert.match(byId.get("reports_usage")!.reported!, /40,951|40,951 tokens|40,951/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* The gpt-5.5 regression: the pin was sent and quietly ignored for months. */
test("a model that does not match the pin refuses the connection", async () => {
  const repo = await scratch();
  try {
    const profile = buildProfileForAgent(agent, "worker")!;
    const result = await probeAdapter(repo, agent, profile, {
      runner: async () => observation(),
      readback: readback({ model: "gpt-5.5" })
    });
    assert.equal(result.ok, false);
    const pinned = result.capabilities.find((entry) => entry.id === "pins_one_model")!;
    assert.equal(pinned.status, "failed");
    assert.equal(pinned.requested, "gpt-5.6-terra");
    assert.equal(pinned.reported, "gpt-5.5");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* The --ignore-user-config regression: a read-only sandbox reported success
   and wrote nothing, and the run was called fine. */
test("a run that writes nothing refuses, however successfully it exited", async () => {
  const repo = await scratch();
  try {
    const profile = buildProfileForAgent(agent, "worker")!;
    const result = await probeAdapter(repo, agent, profile, {
      runner: async () => observation({ wroteNonceFile: false }),
      readback: readback({ sandbox: "read-only" })
    });
    assert.equal(result.ok, false);
    const confined = result.capabilities.find((entry) => entry.id === "confined_to_project")!;
    assert.equal(confined.status, "failed");
    assert.match(confined.detail, /no file appeared/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a provider that reports nothing is unverified, never verified", async () => {
  const repo = await scratch();
  try {
    const profile = buildProfileForAgent(agent, "worker")!;
    const result = await probeAdapter(repo, agent, profile, {
      runner: async () => observation(),
      readback: async () => null
    });
    const pinned = result.capabilities.find((entry) => entry.id === "pins_one_model")!;
    assert.equal(pinned.status, "unverified");
    assert.equal(pinned.reported, null);
    // Unverified is not failure: it does not block, but it never claims support.
    assert.equal(result.ok, true);
    /* The invariant that matters: a capability whose only evidence is a
       readback can never be "verified" without one. `no_bypass_flags` is
       excluded deliberately -- it is a static check of our own argv, decided
       before the agent starts, with nothing to read back. */
    for (const id of ["pins_one_model", "confined_to_project"] as const) {
      const entry = result.capabilities.find((candidate) => candidate.id === id)!;
      assert.notEqual(entry.status, "verified", `${id} claimed support with no readback`);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("usage that cannot be read refuses, because a ceiling would rest on nothing", async () => {
  const repo = await scratch();
  try {
    const profile = buildProfileForAgent(agent, "worker")!;
    const result = await probeAdapter(repo, agent, profile, {
      runner: async () => observation({ stdout: '{"type":"thread.started","thread_id":"abc"}' }),
      readback: readback()
    });
    assert.equal(result.ok, false);
    const usage = result.capabilities.find((entry) => entry.id === "reports_usage")!;
    assert.equal(usage.status, "failed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a timeout is treated as waiting for input", async () => {
  const repo = await scratch();
  try {
    const profile = buildProfileForAgent(agent, "worker")!;
    const result = await probeAdapter(repo, agent, profile, {
      runner: async () => observation({ ok: false, timedOut: true }),
      readback: readback()
    });
    assert.equal(result.ok, false);
    assert.equal(result.capabilities.find((entry) => entry.id === "non_interactive")!.status, "failed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a profile carrying a bypass flag is refused before it is ever run", async () => {
  const repo = await scratch();
  try {
    const profile: AdapterProfile = {
      ...buildProfileForAgent(agent, "worker")!,
      invoke: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-"]
    };
    let ran = false;
    const result = await probeAdapter(repo, agent, profile, {
      runner: async () => {
        ran = true;
        return observation();
      },
      readback: readback()
    });
    assert.equal(ran, false, "a refused profile must never be executed");
    assert.equal(result.ok, false);
    assert.match(result.refusal ?? "", /dangerously-bypass/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* Nothing is recorded unless the probe passed. A project must never hold a
   profile whose capabilities were assumed. */
test("a failed probe writes no profile", async () => {
  const repo = await scratch();
  try {
    const result = await connectAdapter(repo, "worker", "codex-terra", {
      runner: async () => observation({ wroteNonceFile: false }),
      readback: readback({ sandbox: "read-only" })
    });
    assert.equal(result.ok, false);
    await assert.rejects(readFile(path.join(repo, ".hivemind", "adapters", "worker.profile.json"), "utf8"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a passed probe writes the profile and the capabilities it proved", async () => {
  const repo = await scratch();
  try {
    const result = await connectAdapter(repo, "planner", "codex-terra", {
      runner: async () => observation(),
      readback: readback()
    });
    assert.equal(result.ok, true);
    const profile = JSON.parse(
      await readFile(path.join(repo, ".hivemind", "adapters", "planner.profile.json"), "utf8")
    ) as AdapterProfile;
    // The tool name has to BE the role, because that is the name Core resolves.
    assert.equal(profile.tool, "planner");
    assert.equal(requestedModel(profile.invoke), "gpt-5.6-terra");
    const record = JSON.parse(
      await readFile(path.join(repo, ".hivemind", "adapters", "planner.connection.json"), "utf8")
    ) as { agent_id: string; capabilities: unknown[] };
    assert.equal(record.agent_id, "codex-terra");
    assert.ok(record.capabilities.length >= 5);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* An agent nobody has made work cannot be connected by asking nicely. */
test("an agent with no working invocation refuses with its real reason", async () => {
  const repo = await scratch();
  try {
    /* Refused because it was measured and failed, not because nobody wrote an
       adapter for it: its working-directory setting is not a boundary. That is
       the contract working rather than an integration missing. */
    const kimi = await connectAdapter(repo, "worker", "kimi-code");
    assert.equal(kimi.ok, false);
    assert.match(kimi.reason, /not a boundary|absolute path/u);
    /* Attemptable but not yet proven: no usage reader has ever been checked
       against a live run, so no profile can be built for it. */
    const open = await connectAdapter(repo, "worker", "opencode");
    assert.equal(open.ok, false);
    assert.match(open.reason, /no argv|reading of what it spends/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* The probe must exercise the profile's own argv, changing exactly one thing. */
test("the probe drops only --ephemeral, so the readback exists", () => {
  const profile = buildProfileForAgent(agent, "worker")!;
  const probed = probeInvocation(profile.invoke);
  assert.ok(profile.invoke.includes("--ephemeral"));
  assert.ok(!probed.includes("--ephemeral"));
  assert.deepEqual(
    profile.invoke.filter((arg) => arg !== "--ephemeral"),
    probed
  );
});

test("the probe leaves nothing behind in the project", async () => {
  const repo = await scratch();
  try {
    await connectAdapter(repo, "worker", "codex-terra", {
      runner: async ({ repoRoot, nonceFile }) => {
        await writeFile(path.join(repoRoot, ".hivemind", "probe", nonceFile), nonceFile.replace(/\.txt$/u, ""), "utf8");
        return observation();
      },
      readback: readback()
    });
    await assert.rejects(readFile(path.join(repo, ".hivemind", "probe"), "utf8"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
