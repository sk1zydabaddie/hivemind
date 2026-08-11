import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

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
