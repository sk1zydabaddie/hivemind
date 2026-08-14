import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { appendEvent } from "../src/events.js";
import { initProject } from "../src/init.js";
import {
  buildVerificationProvenance,
  checkAuthor,
  describeProvenance,
  readCodeProvenance
} from "../src/verification-provenance.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);

/* Verification provenance.
 *
 * The name is the load-bearing part and these tests defend it. It records
 * WHERE each input came from -- the adapter, the check author, the scope, the
 * build -- and it must never imply anything about how deeply a check tests,
 * because Core runs a command and reads an exit code and cannot know.
 */

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "verification-provenance",
    async (repo) => {
      await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.name", "Hivemind Test"], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["config", "user.email", "hivemind@example.test"], { cwd: repo, windowsHide: true });
      await writeFile(path.join(repo, "README.md"), "# Fixture\n");
      await execFileAsync("git", ["add", "."], { cwd: repo, windowsHide: true });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });
      await initProject(repo);
    },
    async (repo) => {
      await run(repo);
    },
    "hivemind-verification-provenance-test-"
  );
}

test("a check's author comes from its identity, never from a declaration", () => {
  /* Already half-recorded before it had a name: contract checks are minted as
     `contract-validity:<task>` and the selected inventory carries `sources`. */
  assert.equal(checkAuthor("contract-validity:T-001", undefined), "contract");
  assert.equal(checkAuthor("unit", ["repo-graph"]), "project_config");
  assert.equal(checkAuthor("full-suite", ["fail-safe"]), "fail_safe");
  /* A worker cannot promote its own check by naming it well: the prefix is
     minted by Core when it reads the contract, not supplied by anyone. */
  assert.equal(checkAuthor("contract-validity-lookalike", undefined), "project_config");
});

test("the adapter behind each task is read from the trail, and absence is not a guess", async () => {
  await withRepo(async (repo) => {
    await appendEvent(repo, {
      type: "task.started",
      task_id: "T-001",
      data: { run_id: "R-1", tool: "worker", routing_task_type: "other" }
    });
    /* A rerouted task starts twice; the tool that produced the change is the
       one that ran last. */
    await appendEvent(repo, {
      type: "task.started",
      task_id: "T-001",
      data: { run_id: "R-2", tool: "worker-fallback", routing_task_type: "other" }
    });

    const entries = await readCodeProvenance(repo, ["T-001", "T-404"]);
    assert.equal(entries[0]?.tool, "worker-fallback");
    /* No `task.started` at all -- hand-authored or an older trail. Null, not a
       guess and not the first tool that happens to be lying around. */
    assert.equal(entries[1]?.tool, null);
    assert.equal(entries[1]?.probe_verified, false);
  });
});

test("a probe that no longer describes the adapter does not count as verified", async () => {
  await withRepo(async (repo) => {
    const adapters = path.join(repo, ".hivemind", "adapters");
    await mkdir(adapters, { recursive: true });
    await appendEvent(repo, {
      type: "task.started",
      task_id: "T-001",
      data: { run_id: "R-1", tool: "worker" }
    });

    /* No connection record at all. */
    assert.equal((await readCodeProvenance(repo, ["T-001"]))[0]?.probe_verified, false);

    /* Probed. */
    await writeFile(
      path.join(adapters, "worker.connection.json"),
      JSON.stringify({
        agent_id: "codex-terra",
        capabilities: [{ id: "reports_usage", status: "verified" }],
        capabilities_stale: null
      })
    );
    assert.equal((await readCodeProvenance(repo, ["T-001"]))[0]?.probe_verified, true);

    /* Probed, then the account changed -- the verification no longer describes
       what ran, which is exactly the case account switching marks. */
    await writeFile(
      path.join(adapters, "worker.connection.json"),
      JSON.stringify({
        agent_id: "codex-terra",
        capabilities: [{ id: "reports_usage", status: "verified" }],
        capabilities_stale: "account_changed"
      })
    );
    assert.equal((await readCodeProvenance(repo, ["T-001"]))[0]?.probe_verified, false);
  });
});

test("adversarial coverage is present and unknown, never omitted", async () => {
  await withRepo(async (repo) => {
    const provenance = await buildVerificationProvenance(repo, [], [], "single_worktree");
    /* An absent field reads as "nothing to say about this". This field has
       something to say and it is that nobody knows: it is mutation testing,
       and Hivemind does not do it. */
    assert.equal(provenance.adversarial_coverage, "unknown");
    assert.ok("adversarial_coverage" in provenance);
  });
});

test("the scope is what the caller declared, and defaults to the narrower claim", async () => {
  await withRepo(async (repo) => {
    const integrated = await buildVerificationProvenance(repo, [], [], "integrated_set");
    assert.equal(integrated.scope, "integrated_set");
    const single = await buildVerificationProvenance(repo, [], [], "single_worktree");
    assert.equal(single.scope, "single_worktree");

    /* Only integration earns the wider claim; the corpus and speculative-draft
       call sites verify one checkout and must not read as the whole set. */
    const integrate = await readFile(path.resolve("src/integrate.ts"), "utf8");
    assert.match(integrate, /"integrated_set"/u);
    const verification = await readFile(path.resolve("src/verification.ts"), "utf8");
    assert.match(verification, /scope: CheckScope = "single_worktree"/u);
  });
});

test("the artifact identity ties a result to the build that produced it", async () => {
  await withRepo(async (repo) => {
    const provenance = await buildVerificationProvenance(repo, [], [], "single_worktree");
    assert.equal(typeof provenance.artifact_identity, "string");
    assert.ok(provenance.artifact_identity.length > 0);
  });
});

test("provenance is bound at verification time, not reconstructed later", async () => {
  /* The same reason M8.7 binds the base commit and the patch hashes at review
     time: reconstructing later means re-deriving the adapter and the build
     from a trail that has moved on, and a manifest whose provenance is a later
     guess is worth less than none. */
  const verification = await readFile(path.resolve("src/verification.ts"), "utf8");
  assert.match(verification, /const provenance = await buildVerificationProvenance\(/u);
  /* `\s` rather than `\n`: the repository checks out CRLF on Windows, and a
     source assertion that assumes one line ending fails on the other platform
     for a reason that has nothing to do with what it is testing. */
  assert.match(verification, /provenance,\s+tests: result\.tests/u);

  const manifest = await readFile(path.resolve("src/verification-set.ts"), "utf8");
  assert.match(manifest, /provenance\?: VerificationProvenance;/u);
});

test("nothing gates on provenance", async () => {
  /* Advisory, M7.2's posture. A signal that classifies its own evidence must
     not be able to refuse work: when it is wrong it would refuse correct work
     for a reason nobody can argue with. */
  for (const file of ["src/integrate.ts", "src/adoption.ts", "src/verification.ts"]) {
    const source = await readFile(path.resolve(file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    /* No refusal may read the field. Matching the shapes rather than the word,
       because the word appears legitimately where it is assembled and stored. */
    assert.doesNotMatch(code, /if\s*\([^)]*provenance[^)]*\)\s*(?:return|\{[\s\S]{0,80}ok:\s*false)/u);
    assert.doesNotMatch(code, /provenance[^\n]{0,60}\bok:\s*false/u);
  }
});

test("the summary says where things came from and never how deeply they test", async () => {
  await withRepo(async (repo) => {
    await appendEvent(repo, {
      type: "task.started",
      task_id: "T-001",
      data: { run_id: "R-1", tool: "worker" }
    });
    const provenance = await buildVerificationProvenance(
      repo,
      ["T-001"],
      [{ id: "contract-validity:T-001" }, { id: "unit", sources: ["repo-graph"] }],
      "integrated_set"
    );
    const summary = describeProvenance(provenance);
    assert.match(summary, /unverified provider/u);
    assert.match(summary, /contract-authored checks/u);
    assert.match(summary, /integrated set/u);

    /* The naming rule, asserted. "Depth" would be read as "no mocks", which
       this cannot mean -- a worker-written suite full of doubles scores well on
       every axis Core can see. */
    for (const forbidden of ["depth", "deep", "thorough", "no mocks", "fully tested"]) {
      assert.ok(
        !summary.toLowerCase().includes(forbidden),
        `the summary claimed "${forbidden}", which provenance cannot support`
      );
    }
  });
});
