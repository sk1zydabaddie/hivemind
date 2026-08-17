import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { probeAdapter, probeInvocation, readGrokSession, readKimiSession, requestedModel, type ProbeObservation } from "../src/adapter-probe.js";
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

const execFileAsync = promisify(execFile);

test("Grok readback requires the exact file tools, empty integrations, and workspace sandbox", async () => {
  const stdout = [
    JSON.stringify({ type: "available_commands", tools: ["read_file", "search_replace", "list_dir", "grep", "search_tool", "use_tool", "write"] }),
    JSON.stringify({
      type: "hivemind.grok.session",
      summary: { info: { cwd: "D:/repo" }, current_model_id: "grok-4.6", sandbox_profile: "workspace" }
    })
  ].join("\n");
  const readback = await readGrokSession(stdout, "D:/repo", async () => true);
  assert.equal(readback?.model, "grok-4.6");
  assert.equal(readback?.sandbox, "workspace-write");
  assert.equal(readback?.subagents, "none");

  const terminal = stdout.replace('"write"]', '"write","run_terminal_command"]');
  assert.equal((await readGrokSession(terminal, "D:/repo", async () => true))?.sandbox, null);
  assert.equal((await readGrokSession(stdout, "D:/repo", async () => false))?.sandbox, null);
});

test("Kimi readback verifies only the exact Hivemind-bounded tool snapshot", async () => {
  const bounded = [
    "mcp__hivemind_files__read_file",
    "mcp__hivemind_files__write_file",
    "mcp__hivemind_files__replace_in_file",
    "mcp__hivemind_files__list_files",
    "mcp__hivemind_files__search_files"
  ];
  const stdout = [
    JSON.stringify({ type: "system.version", version: "0.36.1" }),
    JSON.stringify({
      type: "hivemind.kimi.session",
      state: { cwd: "D:/repo" },
      profile: {
        modelAlias: "kimi-code/kimi-for-coding",
        activeToolNames: bounded,
        disallowedTools: ["Bash", "Agent", "AgentSwarm", "Read", "Write", "Edit", "Grep", "Glob"],
        subagents: []
      },
      tools: { tools: bounded.map((name) => ({ name })) }
    })
  ].join("\n");
  const readback = await readKimiSession(stdout);
  assert.equal(readback?.model, "kimi-code/kimi-for-coding");
  assert.equal(readback?.sandbox, "hivemind-bounded-files");
  assert.match(readback?.approvalPolicy ?? "", /exact bounded MCP tools/u);
  assert.equal(readback?.subagents, "none");
  assert.equal(readback?.version, "0.36.1");

  const unsafe = stdout.replace("mcp__hivemind_files__read_file", "Read");
  assert.equal((await readKimiSession(unsafe))?.sandbox, null);
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-probe-test-"));
  /* A real repository, because `leaves_change_uncommitted` is measured by
     comparing HEAD before and after. A directory git cannot read answers
     "unknown", which the contract refuses -- correctly, and it caught this
     fixture the moment the capability was added. */
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@example.test"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(path.join(dir, "seed.txt"), "seed\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: dir });
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
    assert.equal(pinned.status, "mismatched");
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
    assert.equal(confined.status, "mismatched");
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
    /* Unverified is not the same as failure -- but what it COSTS depends on the
       capability, and the contract decides that rather than this file.
       An unreadable model pin degrades: routing switches off and the agent is
       still admitted. An unconfirmed BOUNDARY refuses, because being wrong
       about it is unbounded. This probe reports nothing at all, so the
       connection is refused and the reason names the boundary. */
    assert.equal(result.ok, false);
    assert.match(result.refusal ?? "", /where this agent is allowed to write/u);
    assert.ok(
      result.degraded.includes("tier_routing"),
      "an unreadable pin has to switch routing off, not be shrugged at"
    );
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
    assert.equal(usage.status, "mismatched");
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
    assert.equal(result.capabilities.find((entry) => entry.id === "non_interactive")!.status, "mismatched");
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

/* A complete profile is not a claim that the hosted account exists. */
test("Kimi remains fail-closed when its account-backed run cannot start", async () => {
  const repo = await scratch();
  try {
    const kimi = await connectAdapter(repo, "worker", "kimi-code", {
      runner: async () => observation({ ok: false, reason: "no Kimi provider is configured", exitCode: 1, wroteNonceFile: false }),
      readback: async () => null
    });
    assert.equal(kimi.ok, false);
    assert.match(kimi.reason, /could not be connected|no Kimi provider/u);
    assert.equal(await readFile(path.join(repo, ".hivemind", "kimi-agent.md"), "utf8").then(() => true), true);
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
        await writeFile(path.join(repoRoot, ".hivemind-probe", nonceFile), nonceFile.replace(/\.txt$/u, ""), "utf8");
        return observation();
      },
      readback: readback()
    });
    await assert.rejects(readFile(path.join(repo, ".hivemind-probe"), "utf8"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a worker connection record is attached to the exact pool member", async () => {
  const repo = await scratch();
  try {
    const result = await connectAdapter(repo, "worker", "codex-terra", {
      runner: async ({ repoRoot, nonceFile }) => {
        await writeFile(path.join(repoRoot, ".hivemind-probe", nonceFile), nonceFile.replace(/\.txt$/u, ""), "utf8");
        return observation();
      },
      readback: readback()
    });
    assert.equal(result.ok, true);
    const exact = await readFile(path.join(repo, ".hivemind", "adapters", "worker-codex-terra.connection.json"), "utf8");
    assert.match(exact, /"agent_id": "codex-terra"/u);
    await assert.rejects(readFile(path.join(repo, ".hivemind", "adapters", "worker.connection.json"), "utf8"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
