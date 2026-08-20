import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { agentCatalogue, catalogueAgentForDiscoveredModel, catalogueModels, catalogueProviders, findCatalogueAgent } from "../src/agent-catalogue.js";
import { describePrice, priceForModel, priceIsStale } from "../src/model-prices.js";
import { ROLE_RECOMMENDATIONS, modelChoiceAllowed, modelChoiceRefusal, recommendationFor } from "../src/role-recommendations.js";
import { validateConfig } from "../src/config.js";
import { isMachineSpecific, trackedMachineFiles, untrackMachineFiles } from "../src/project-sharing.js";
import { currentMachine, machineStanding } from "../src/verification-standing.js";
import { buildProfileForAgent, connectAdapter, connectDiscoveredAdapter, initProjectForDesktop, inspectProjectConfig, setProjectConfig, startProviderAuthentication } from "../src/config-actions.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";

const run = promisify(execFile);

async function repoWithProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-config-test-"));
  await run("git", ["init"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.test"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(path.join(dir, "package.json"), '{"name":"t","scripts":{"test":"node --test"}}\n', "utf8");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-m", "base"], { cwd: dir });
  return dir;
}

test("project.init leaves a project that is not in its most expensive shape", async () => {
  const repo = await repoWithProject();
  try {
    const result = await initProjectForDesktop(repo);
    assert.equal(result.ok, true);
    const view = result.ok ? (result.value as { config: { low_globs: string[]; medium_globs: string[] } }) : null;
    /* A project with no tier globs infers High for every path, and High's
       floor excludes every cheap provider -- so it would route every task to
       the strongest model it has. Core's own init fills the missing keys; this
       asserts the result rather than a second copy of the defaults, because
       two sources of truth for one default is how the second one clobbers the
       first. */
    assert.ok(view!.config.low_globs.length > 0);
    assert.ok(view!.config.medium_globs.length > 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/**
 * `initProject` writes default profiles so a first prompt has something to
 * resolve. They are declarations: nothing has run them, so nothing knows
 * whether their flags take effect. `config.inspect` must say so rather than
 * showing them as working, which is the whole distinction this build adds.
 */
test("profiles init wrote are reported as installed but never as verified", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const inspected = await inspectProjectConfig(repo);
    const view = inspected.ok
      ? (inspected.value as {
          adapters: Array<{ role: string; installed: boolean; connected_at: string | null; capabilities: unknown[] }>;
        })
      : null;
    /* Three roles, but FIVE profiles: `initProject` writes a three-member
       worker pool so the tier floor has somewhere to land -- `worker` (strong),
       `worker-standard` and `worker-cheap`. Reporting one row per role hid two
       thirds of what routing would actually pick from. */
    assert.deepEqual(
      view!.adapters.map((entry) => entry.role),
      ["planner", "manager", "worker", "worker", "worker"]
    );
    const pool = view!.adapters.filter((entry) => entry.role === "worker");
    assert.equal(pool.length, 3, "the default worker pool is what makes tier routing reachable");
    for (const adapter of view!.adapters) {
      assert.equal(adapter.installed, true);
      assert.equal(adapter.connected_at, null, `${adapter.role} was never probed, so it cannot claim a check`);
      assert.deepEqual(adapter.capabilities, []);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("config.set changes what it is allowed to and refuses everything else", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);

    const ok = await setProjectConfig(repo, { run_ceiling_tokens: 250_000, test_command: "npm test" });
    assert.equal(ok.ok, true);
    const view = ok.ok ? (ok.value as { config: { run_ceiling_tokens: number; test_command: string } }) : null;
    assert.equal(view!.config.run_ceiling_tokens, 250_000);
    assert.equal(view!.config.test_command, "npm test");

    /* The whitelist IS the safety property: anything outside it is refused
       rather than merged, so no future caller can reach a gate through here. */
    for (const forbidden of [
      { repo_root: "/somewhere/else" },
      { forbidden_globs: [] },
      { manager_autonomy: { level: "auto" } },
      { verification: { checks: [] } },
      { stack: "typescript-node" }
    ]) {
      const refused = await setProjectConfig(repo, forbidden as Record<string, unknown>);
      assert.equal(refused.ok, false, `${Object.keys(forbidden)[0]} must be refused`);
      assert.match(refused.reason, /cannot change/u);
    }

    // And a value the validator rejects never lands.
    const bad = await setProjectConfig(repo, { max_concurrent_workers: 99 });
    assert.equal(bad.ok, false);
    const after = await inspectProjectConfig(repo);
    const stillFine = after.ok ? (after.value as { config: { max_concurrent_workers: number } }) : null;
    assert.notEqual(stillFine!.config.max_concurrent_workers, 99);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("config.inspect reports the roles Core resolves, so the client stops guessing", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const result = await executeWorkspaceAction(repo, { type: "config.inspect", payload: {} });
    assert.equal(result.ok, true);
    const view = result.ok ? (result.value as { roles: string[]; writable_keys: string[]; limits: { observed_worker_call_tokens: { high: number } } }) : null;
    assert.deepEqual(view!.roles, ["planner", "manager", "worker"]);
    assert.ok(view!.writable_keys.includes("run_ceiling_tokens"));
    assert.equal("catalogue" in (result.ok ? (result.value as object) : {}), false);
    /* Measured on this project's own runs, not guessed: a ceiling below one
       real worker call is a trap that stops a run after the money is spent. */
    assert.ok(view!.limits.observed_worker_call_tokens.high > 100_000);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the dispatcher refuses stray fields on the read-only settings actions", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    for (const type of ["config.inspect", "project.init", "models.discover"]) {
      const refused = await executeWorkspaceAction(repo, { type, payload: { approved: true } });
      assert.equal(refused.ok, false);
    }
    const badRole = await executeWorkspaceAction(repo, {
      type: "adapter.connect",
      payload: { role: "orchestrator", agent_id: "codex-terra" }
    });
    assert.equal(badRole.ok, false);
    assert.match(badRole.reason, /role must be one of/u);
    const modelWithStrayField = await executeWorkspaceAction(repo, {
      type: "adapter.connect_model",
      payload: {
        role: "worker",
        provider_id: "codex-cli",
        model_slug: "gpt-5.6-terra",
        approved: true
      }
    });
    assert.equal(modelWithStrayField.ok, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* The catalogue must not imply integrations that do not exist. One harness is
   proven; everything else has to say what specifically is missing. */
test("the agent catalogue is honest about what has actually been run", () => {
  const supported = agentCatalogue.filter((agent) => agent.status === "supported");
  assert.ok(supported.length > 0);
  assert.deepEqual([...new Set(supported.map((agent) => agent.harness))], ["codex-cli", "grok"]);
  for (const agent of agentCatalogue) {
    if (agent.status === "supported") {
      assert.equal(agent.caveat, null);
      assert.notEqual(agent.invoke, null);
      assert.notEqual(agent.usage_parser, null);
      continue;
    }
    assert.ok((agent.caveat ?? "").length > 40, `${agent.id} must say what is missing`);
    /* This used to require `invoke === null` for anything unproven, on the
       reasoning that an unproven agent must not be connectable at all. That
       rule has been replaced by a better one: the PROBE is the gate. An agent
       may carry the argv the probe will run -- that is how it earns a status
       instead of keeping one forever -- and `connectAdapter` still records
       nothing unless the probe passes. What must never happen is `supported`
       without a live run, which the branch above asserts.
       An `unsupported` agent is a different case: it has been measured and
       refused, so there is nothing to attempt. */
    if (agent.status === "unsupported") {
      assert.equal(agent.invoke, null, `${agent.id} was refused, so it has nothing to run`);
    }
    /* An agent with an invocation must also have a usage reader, or its probe
       refuses on a capability nothing could ever satisfy. */
    if (agent.invoke !== null) {
      assert.notEqual(agent.usage_parser, null, `${agent.id} can be run with nothing to read`);
    }
  }
  // A spending limit built on unverified usage numbers is worse than none, so
  // an agent whose usage reporting is unproven cannot claim support.
  const claude = agentCatalogue.find((agent) => agent.id === "claude-code")!;
  assert.equal(claude.status, "unverified");
  assert.match(claude.caveat!, /live Claude Code 2\.1\.233 probe verified all nine/u);
});

/* Config validation is closed-world, and it was not before.
 *
 * `normalizeConfig` rebuilt its result field by field, so an unknown key never
 * reached anything that could reject it. The validator saw the raw object the
 * whole time and was simply never asked. That is worse than a permissive
 * validator because it LOOKS closed: a mistyped key was accepted, dropped, and
 * the project ran on a default with the file on disk still saying what the
 * person meant.
 */
test("a config field nobody supports is refused, and the field is named", async () => {
  const problems = validateConfig({
    version: 1,
    stack: "typescript-node",
    repo_root: "/tmp/x",
    test_command: "npm test",
    allowed_globs: ["**/*"],
    forbidden_globs: [],
    definitely_not_a_setting: true
  });
  assert.ok(
    problems.some((problem: string) => problem.includes("definitely_not_a_setting")),
    `an unknown field was accepted: ${problems.join("; ")}`
  );

  /* Named, not merely counted. "unsupported config field" with no field is the
     message that sends someone hunting the wrong file. */
  assert.match(problems.join("; "), /unsupported config field: definitely_not_a_setting/u);

  /* And a near-miss of a real key is caught, which is the case that actually
     happens: a typo silently ran the project on the default. */
  const typo = validateConfig({
    version: 1,
    stack: "typescript-node",
    repo_root: "/tmp/x",
    test_commnd: "npm test",
    allowed_globs: ["**/*"],
    forbidden_globs: []
  });
  assert.match(typo.join("; "), /unsupported config field: test_commnd/u);
});

test("every field the config type carries is known to the validator", () => {
  /* Non-vacuous in the other direction: a real config must still pass. If a
     field is added to the type and not to the known set, this fails at the
     person who added it rather than later at whoever relies on it. */
  const problems = validateConfig({
    version: 1,
    stack: "typescript-node",
    repo_root: "/tmp/x",
    test_command: "npm test",
    allowed_globs: ["**/*"],
    forbidden_globs: [],
    base_branch: "main",
    low_globs: [],
    medium_globs: [],
    high_globs: [],
    critical_globs: [],
    resource_policy: {},
    execution: { max_concurrent_workers: 2 },
    task_type_routing: { ui: { tool: null, preference: "strongest" } }
  });
  assert.deepEqual(
    problems.filter((problem: string) => problem.startsWith("unsupported config field")),
    []
  );
});

/* ── Provider / model / role, and the floors that survive the split ───────── */

test("a provider is a harness, not a harness-and-model pair", () => {
  const providers = catalogueProviders();
  const codex = providers.find((entry) => entry.id === "codex-cli");
  assert.ok(codex, "codex is a provider");
  /* Multiple catalogue models collapse to one provider row. Internal routing
     vocabulary is no part of what a person is choosing here. */
  assert.equal(providers.filter((entry) => entry.id === "codex-cli").length, 1);
  assert.equal(codex!.label, "Codex");
  assert.ok(!/balanced|cheaper|strongest/iu.test(providers.map((p) => p.label).join(" ")));

  /* And the caveats survive the split -- they are properties of the harness. */
  const claude = providers.find((entry) => entry.id === "claude");
  assert.ok(claude!.caveat && claude!.caveat.length > 40, "the honest part is kept");
});

test("provider rows distinguish product evidence from a current project check", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const connected = await connectAdapter(repo, "worker", "codex-terra", {
      runner: async () => ({
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
      }),
      readback: async () => ({
        source: "test rollout",
        model: "gpt-5.6-terra",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        workspaceRoots: [repo],
        subagents: "v2"
      })
    });
    assert.equal(connected.ok, true);

    const inspected = await inspectProjectConfig(repo);
    const providers = inspected.ok
      ? (inspected.value as { providers: Array<{ id: string; checked_here: boolean; connectable: boolean }> }).providers
      : [];
    assert.equal(providers.find((provider) => provider.id === "codex-cli")?.checked_here, true);
    assert.equal(providers.find((provider) => provider.id === "claude")?.checked_here, false);
    assert.equal(providers.find((provider) => provider.id === "grok")?.connectable, true);
    assert.equal(providers.find((provider) => provider.id === "kimi")?.connectable, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("provider sign-in launches only the catalogue-owned command and returns no credential", async () => {
  const repo = await repoWithProject();
  try {
    let launched: readonly string[] | null = null;
    let launchedFrom = "";
    const result = await startProviderAuthentication(repo, "grok", {
      launcher: async (invocation, options) => {
        launched = invocation;
        launchedFrom = options.cwd;
      }
    });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    assert.deepEqual(
      launched,
      process.platform === "win32"
        ? ["grok.cmd", "login", "--oauth"]
        : ["grok", "login", "--oauth"]
    );
    assert.equal(launchedFrom, repo);
    assert.equal(JSON.stringify(result).match(/token|credential|password/giu), null);

    let called = false;
    const unknown = await startProviderAuthentication(repo, "not-a-provider", {
      launcher: async () => {
        called = true;
      }
    });
    assert.equal(unknown.ok, false);
    assert.equal(called, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("Grok receives its prompt as the value of the final --single flag", () => {
  const grok = findCatalogueAgent("grok-build");
  assert.ok(grok);
  const profile = buildProfileForAgent(grok, "worker");
  assert.ok(profile);
  assert.equal(profile.prompt_arg, "arg");
  assert.equal(profile.invoke.at(-1), "--single");
  assert.equal(profile.invoke.includes("grok-code-fast-1"), false);
  assert.equal(profile.invoke.includes("grok-4.6"), true);
});

test("every catalogue model carries the actual slug passed to its CLI", () => {
  const models = catalogueModels("codex-cli");
  assert.deepEqual(
    models.map((model) => model.slug),
    ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    "cheapest first, by real slug"
  );
  for (const model of models) {
    assert.ok(!/balanced|cheaper|strongest/iu.test(model.label), model.label);
  }
  /* Claude's invocation has always passed `--model sonnet`; presenting it as
     "whatever the harness chooses" hid a real pin from both pickers. */
  const claude = catalogueModels("claude");
  assert.deepEqual(claude.map((model) => model.slug), ["sonnet"]);
});

test("a detected model has a reversible durable id and conservative unknown metadata", () => {
  const agent = catalogueAgentForDiscoveredModel("codex-cli", "gpt-5.5");
  assert.ok(agent);
  assert.equal(agent!.model, "gpt-5.5");
  assert.equal(agent!.routing_tier, "standard");
  assert.equal(agent!.context_window, 100_000);
  assert.equal(findCatalogueAgent(agent!.id)?.model, "gpt-5.5");
  assert.equal(catalogueAgentForDiscoveredModel("codex-cli", "bad slug"), null);
});

test("a model picker choice is re-discovered in Core before the existing probe records it", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const discoveryRunner = async (spec: { kind: string }) => ({
      ok: true,
      stdout:
        spec.kind === "app-server"
          ? JSON.stringify({ data: [{ model: "gpt-5.5", displayName: "GPT-5.5", hidden: false }] })
          : spec.kind === "alias-config"
            ? '{"providers":{},"models":{}}'
            : "",
      stderr: "",
      reason: null
    });

    const forged = await connectDiscoveredAdapter(repo, "planner", "codex-cli", "gpt-forged", {
      discoveryRunner
    });
    assert.equal(forged.ok, false);
    assert.match(forged.ok ? "" : forged.reason, /not in the current model list/u);

    const connected = await connectDiscoveredAdapter(repo, "planner", "codex-cli", "gpt-5.5", {
      discoveryRunner,
      probe: {
        runner: async () => ({
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
        }),
        readback: async () => ({
          source: "test rollout",
          model: "gpt-5.5",
          sandbox: "workspace-write",
          approvalPolicy: "never",
          workspaceRoots: [repo],
          subagents: "v2"
        })
      }
    });
    assert.equal(connected.ok, true, connected.ok ? undefined : connected.reason);
    const inspected = await inspectProjectConfig(repo);
    assert.equal(inspected.ok, true);
    const planner = inspected.ok
      ? (inspected.value as { adapters: Array<{ role: string; provider_id: string | null; model: string | null }> }).adapters.find((entry) => entry.role === "planner")
      : null;
    assert.equal(planner?.provider_id, "codex-cli");
    assert.equal(planner?.model, "gpt-5.5");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("every priced model has provenance, and staleness is computed not assumed", () => {
  for (const model of catalogueModels()) {
    const price = priceForModel(model.slug);
    if (price === null) continue;
    assert.ok(price.source.length > 10, `${model.slug} must say where the number came from`);
    assert.match(price.checked, /^\d{4}-\d{2}-\d{2}$/u);
    /* API list price, never presented as what a subscription user pays. */
    assert.equal(price.basis, "api_list");
    assert.match(describePrice(price), /not what you pay on a subscription/u);
    /* Fresh on the day it was checked, stale long after -- the point is that
       it goes visibly stale rather than silently rotting. OpenAI cut Luna's
       input price 80% on 30 July 2026, a fortnight before this was written. */
    assert.equal(priceIsStale(price, new Date(`${price.checked}T12:00:00Z`)), false);
    assert.equal(priceIsStale(price, new Date("2027-01-01T00:00:00Z")), true);
  }
});

test("aiming at a model is gated on the RECORDED probe, never the catalogue", () => {
  /* The whole point of the capability contract: the catalogue says what a
     profile ASKS for, and only the connection record says what came back.
     Deciding this from the catalogue would make pins_one_model a declaration
     again. */
  const verified = { capabilities: [{ id: "pins_one_model", status: "verified" }], connected_at: "now" };
  const unverified = { capabilities: [{ id: "pins_one_model", status: "unverified" }], connected_at: "now" };
  const neverProbed = { capabilities: [], connected_at: null };

  assert.equal(modelChoiceAllowed(verified as never), true);
  assert.equal(modelChoiceAllowed(unverified as never), false);
  assert.equal(modelChoiceAllowed(neverProbed as never), false);

  assert.equal(modelChoiceRefusal(verified as never), null);
  assert.match(modelChoiceRefusal(unverified as never)!, /did not report which model/u);
  assert.match(modelChoiceRefusal(neverProbed as never)!, /Connect this first/u);
});

test("a recommendation is advice with a reason, and suggests one worker", () => {
  for (const role of ["planner", "manager", "worker"] as const) {
    const advice = recommendationFor(role);
    assert.ok(advice, `${role} has a suggestion`);
    assert.ok(advice!.why.length > 40, "a reason a person can disagree with");
    assert.match(advice!.reviewed, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok(findCatalogueAgent(advice!.agent_id), "it names a real agent");
  }
  /* One worker on a first run: each connection runs the agent once for real, so
     suggesting a three-model pool up front turns a first run into five probes
     before a line of code is written. */
  assert.equal(ROLE_RECOMMENDATIONS.filter((entry) => entry.role === "worker").length, 1);
});

test("connecting a worker adds to the pool instead of replacing it", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const before = await readdir(path.join(repo, ".hivemind", "adapters"));
    const workers = before.filter((entry) => /^worker.*\.profile\.json$/u.test(entry));
    /* init writes a three-member pool so the tier floor has somewhere to land.
       `adapter.connect` used to write `worker.profile.json` for every worker
       connection, so exactly one of the three could ever be verified and the
       other two kept routing work on profiles nobody probed. */
    assert.equal(workers.length, 3, "the default pool");

    const codex = findCatalogueAgent("codex-terra")!;
    assert.equal(buildProfileForAgent(codex, "worker")!.tool, "worker-codex-terra");
    assert.equal(buildProfileForAgent(codex, "planner")!.tool, "planner");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* ── Machine evidence must not travel, and must not be inherited ─────────── */

test("init splits project facts from machine evidence, before git can take them", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    /* Hivemind's own first-run button for an untracked folder. It runs
       `git add -A`, so before the split it committed five adapter profiles and
       the trail on the person's behalf. */
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-m", "Start tracking this project"], { cwd: repo });
    const tracked = (await run("git", ["ls-files", "--", ".hivemind"], { cwd: repo })).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .sort();

    /* Project facts, and nothing else. */
    assert.deepEqual(tracked, [".hivemind/.gitignore", ".hivemind/config.json"]);
    for (const shared of tracked) {
      assert.equal(isMachineSpecific(shared), false, `${shared} is machine evidence`);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a project that already shares them is detected and can stop", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    /* A repository from before the split: the evidence is already in the index
       and an ignore rule does nothing to a file git already has. */
    await writeFile(
      path.join(repo, ".hivemind", "adapters", "planner.connection.json"),
      '{"agent_id":"codex-sol"}\n',
      "utf8"
    );
    await run("git", ["add", "-A", "-f", ".hivemind"], { cwd: repo });
    await run("git", ["commit", "-m", "legacy"], { cwd: repo });

    const before = await trackedMachineFiles(repo);
    assert.ok(before.includes(".hivemind/adapters/planner.connection.json"));

    const fixed = await untrackMachineFiles(repo);
    assert.equal(fixed.ok, true);
    assert.deepEqual(await trackedMachineFiles(repo), []);
    /* Staged, not deleted: these are live state this project is using now, and
       a verification somebody paid for. */
    const stillThere = await readFile(
      path.join(repo, ".hivemind", "adapters", "planner.connection.json"),
      "utf8"
    );
    assert.match(stillThere, /codex-sol/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a verdict from another machine reads as unverified, not as valid", async () => {
  const here = currentMachine(null);
  /* The record that used to be inherited silently. */
  assert.equal(machineStanding({ ...here, host: "someone-elses-laptop" }, here).stale !== null, true);
  assert.match(machineStanding({ ...here, host: "otherbox" }, here).stale!, /otherbox/u);
  /* A different OS is the case that also leaves the argv unable to spawn. */
  assert.match(
    machineStanding({ ...here, platform: here.platform === "win32" ? "linux" : "win32" }, here)
      .stale!,
    /Reconnect it to check it here/u
  );
  /* A different account home changes what the harness can do. */
  assert.notEqual(machineStanding({ ...here, account_home: "/somewhere/else" }, here).stale, null);
  /* Checked here: nothing to say. */
  assert.equal(machineStanding(here, here).stale, null);
  /* A record older than the field cannot be confirmed, and says so rather than
     being treated as either valid or foreign. */
  assert.match(machineStanding(undefined, here).stale!, /before Hivemind recorded which machine/u);
});

test("connecting records where the probe ran", async () => {
  const repo = await repoWithProject();
  try {
    await initProjectForDesktop(repo);
    const agent = findCatalogueAgent("codex-terra")!;
    const profile = buildProfileForAgent(agent, "planner")!;
    /* The argv is generated on the machine that connects -- `codexInvoke`
       branches on `process.platform` -- so what is recorded alongside it has to
       name that machine too, or the pair cannot be checked later. */
    assert.ok(profile.invoke.length > 0);
    const machine = currentMachine(null);
    assert.equal(typeof machine.host, "string");
    assert.equal(machine.platform, process.platform);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
