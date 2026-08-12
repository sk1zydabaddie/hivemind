import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { agentCatalogue } from "../src/agent-catalogue.js";
import { initProjectForDesktop, inspectProjectConfig, setProjectConfig } from "../src/config-actions.js";
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
    assert.deepEqual(
      view!.adapters.map((entry) => entry.role),
      ["planner", "manager", "worker"]
    );
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
    for (const type of ["config.inspect", "project.init"]) {
      const refused = await executeWorkspaceAction(repo, { type, payload: { approved: true } });
      assert.equal(refused.ok, false);
    }
    const badRole = await executeWorkspaceAction(repo, {
      type: "adapter.connect",
      payload: { role: "orchestrator", agent_id: "codex-terra" }
    });
    assert.equal(badRole.ok, false);
    assert.match(badRole.reason, /role must be one of/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/* The catalogue must not imply integrations that do not exist. One harness is
   proven; everything else has to say what specifically is missing. */
test("the agent catalogue is honest about what has actually been run", () => {
  const supported = agentCatalogue.filter((agent) => agent.status === "supported");
  assert.ok(supported.length > 0);
  assert.deepEqual([...new Set(supported.map((agent) => agent.harness))], ["codex-cli"]);
  for (const agent of agentCatalogue) {
    if (agent.status === "supported") {
      assert.equal(agent.caveat, null);
      assert.notEqual(agent.invoke, null);
      assert.notEqual(agent.usage_parser, null);
      continue;
    }
    assert.ok((agent.caveat ?? "").length > 40, `${agent.id} must say what is missing`);
    assert.equal(agent.invoke, null, `${agent.id} must not be connectable while unproven`);
  }
  // A spending limit built on unverified usage numbers is worse than none, so
  // an agent whose usage reporting is unproven cannot claim support.
  const claude = agentCatalogue.find((agent) => agent.id === "claude-code")!;
  assert.equal(claude.status, "unverified");
  assert.match(claude.caveat!, /never against a live run/u);
});
