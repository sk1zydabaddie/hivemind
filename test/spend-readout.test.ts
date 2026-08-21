import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { probeUsageSessionId } from "../src/adapter-probe.js";
import { inspectWorkspace } from "../src/workspace-inspection.js";

const execFileAsync = promisify(execFile);

/**
 * The number a person reads has to be the money they spent.
 *
 * Drafting bills to the spec and everything after it bills to the run, because
 * `spec.draft` happens before a run exists. Summing only the run session showed
 * the walk below as 2 calls and 179.4K when the ledger said 3 calls and 199.7K
 * -- a third of the calls invisible, in the direction that flatters us.
 *
 * So this asserts the readout against a REAL captured project rather than a
 * fixture, and derives the expected figures from that project's own settled
 * reservations rather than restating them. A fixture cannot fail this way: the
 * two-session split only appears when a spec is drafted and then run, which is
 * exactly the shape a first run has and a hand-built ledger does not.
 */

const CAPTURED = path.resolve("docs/evidence/e2e-2026-08-11-walk4/project-state-after");

test("the spend readout equals every call the run actually paid for", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "hivemind-spend-")));
  try {
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo, windowsHide: true });
    await git(["init"]);
    await git(["config", "user.email", "test@example.test"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(repo, "README.md"), "# captured\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);

    /* The whole `.hivemind` from a clean install that went prompt to shipped.
       Only repo_root is rewritten, because it is an absolute path and nothing
       else in the capture is. */
    await cp(CAPTURED, path.join(repo, ".hivemind"), { recursive: true });
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { repo_root: string };
    config.repo_root = repo;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    // What the run really cost, read off its own settled usage artifacts.
    const reservations = path.join(repo, ".hivemind", "resource", "reservations");
    const files = (await readdir(reservations)).filter((name) => name.endsWith(".usage.json"));
    let spentCalls = 0;
    let spentTokens = 0;
    for (const name of files) {
      const artifact = JSON.parse(await readFile(path.join(reservations, name), "utf8")) as {
        usage: { provider_usage?: { status: string; usage?: { total_tokens: number } } };
      };
      if (artifact.usage.provider_usage?.status !== "captured") continue;
      spentCalls += 1;
      spentTokens += artifact.usage.provider_usage.usage?.total_tokens ?? 0;
    }
    assert.ok(spentCalls >= 3, "the capture should hold drafting, planning and a worker call");

    const inspected = await inspectWorkspace(repo);
    assert.equal(inspected.ok, true, inspected.ok ? undefined : inspected.reason);
    if (!inspected.ok) return;

    assert.equal(
      inspected.value.spend.calls,
      spentCalls,
      "the readout must count the drafting call, not only the run's own"
    );
    assert.equal(
      inspected.value.spend.effective_tokens,
      spentTokens,
      "the readout must total every session the first run billed to"
    );

    /* And the pairing this walk existed to prove: what a one-task run costs
       has to fit under what a fresh install allows. */
    assert.ok(
      inspected.value.spend.run_ceiling_tokens > spentTokens - spentTokens / 5,
      "a default run ceiling must not sit below what an ordinary one-task run costs"
    );
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
});

/**
 * A-04: connecting an agent books its capability probe under a probe session
 * (`probe-<tool>`), which no run or spec ever names -- so setup spend, the
 * ~120K tokens a new user pays before a line of code exists, was durable in
 * the ledger and invisible on every meter. It now gets its own spend figures.
 *
 * Two directions, both pinned: the probe entries must appear on the setup
 * figures, and they must NOT inflate the run figures -- those are what the
 * run and session ceilings bind, and setup is not that run. The probe entries
 * are injected into the REAL captured ledger in exactly the shape
 * `liveProbeRunner` books them, with the session id minted by the same
 * function the runner uses, so the writer and this reader cannot drift apart.
 */
test("setup probe spend is reported on its own figures and never inflates the run's", async () => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "hivemind-spend-setup-")));
  try {
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo, windowsHide: true });
    await git(["init"]);
    await git(["config", "user.email", "test@example.test"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(repo, "README.md"), "# captured\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    await cp(CAPTURED, path.join(repo, ".hivemind"), { recursive: true });
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { repo_root: string };
    config.repo_root = repo;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const before = await inspectWorkspace(repo);
    assert.equal(before.ok, true, before.ok ? undefined : before.reason);
    if (!before.ok) return;
    assert.equal(before.value.spend.setup_calls, 0, "the capture holds no probe sessions");

    const ledgerPath = path.join(repo, ".hivemind", "resource", "ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      providers: Record<string, { session_usage: Record<string, unknown> }>;
      reservations: Record<string, Record<string, unknown>>;
    };
    const probeSession = probeUsageSessionId("codex-cli");
    ledger.providers["planner"].session_usage[probeSession] = {
      requests: 2,
      self_measured_tokens: 500,
      provider_reported_tokens: 118_000,
      provider_reported_requests: 2,
      effective_tokens: 118_000
    };
    /* An in-flight probe: a real reservation shape from the capture, made
       active on the probe session. */
    const template = Object.values(ledger.reservations)[0];
    const active = structuredClone(template);
    active.reservation_id = "probe-active-reservation";
    active.status = "active";
    active.session_id = probeSession;
    active.reserved_tokens = 45_000;
    active.settlement = null;
    ledger.reservations["probe-active-reservation"] = active;
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

    const after = await inspectWorkspace(repo);
    assert.equal(after.ok, true, after.ok ? undefined : after.reason);
    if (!after.ok) return;

    /* Direction one: setup spend is visible. */
    assert.equal(after.value.spend.setup_calls, 3, "two settled probe requests plus one in flight");
    assert.equal(after.value.spend.setup_tokens, 118_000);
    assert.equal(after.value.spend.setup_reserved_tokens, 45_000);

    /* Direction two: the ceiling-bound run figures are untouched by it. */
    assert.equal(after.value.spend.calls, before.value.spend.calls);
    assert.equal(after.value.spend.effective_tokens, before.value.spend.effective_tokens);
    assert.equal(after.value.spend.reserved_tokens, before.value.spend.reserved_tokens);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
});
