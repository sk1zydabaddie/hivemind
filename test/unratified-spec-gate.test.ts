import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { checkpointTask } from "../src/checkpoint.js";
import { createTaskContract } from "../src/contract.js";
import { initProject } from "../src/init.js";
import { requestLease } from "../src/lease.js";
import { runTask } from "../src/run.js";
import { createSpec } from "../src/spec.js";
import { checkPlanningAllowed, requireActiveSpecRatified } from "../src/spec.js";
import { recordIdeationRound, startIdeationSession } from "../src/ideation.js";
import { createTaskWorktree } from "../src/worktree.js";
import { runScout } from "../src/scout.js";

const execFileAsync = promisify(execFile);

/**
 * The invariant that replaced "a spec must be ratified before planning".
 *
 * Planning is a proposal: it reads the repository, writes a tentative plan, and
 * touches nothing else. Ratification before planning meant nobody could be
 * shown a plan before committing to the spec it came from, which is exactly
 * what a first run needs. So the line moved from "before you may look" to
 * "before anything happens".
 *
 * What has to be true for that to be safe is asserted here, and it is the whole
 * justification for the change: an unratified spec permits planning and refuses
 * every path that can touch the repository.
 */

test("an unratified spec permits planning", async () => {
  await withDraftSpec(async (repo) => {
    const planning = await checkPlanningAllowed(repo, "S-001");
    assert.equal(planning.ok, true, "planning must be allowed from a valid draft spec");
    if (planning.ok) assert.equal(planning.value.status, "draft");

    // And the spec really is unratified, so the refusals below are about that.
    const ratified = await requireActiveSpecRatified(repo);
    assert.equal(ratified.ok, false);
    if (!ratified.ok) assert.match(ratified.reason, /is draft; ratify it/u);
  });
});

test("an unratified spec refuses every path that can touch the repository", async () => {
  await withDraftSpec(async (repo) => {
    /* Each of these is tried for real rather than asserted about. A gate that
       is only believed to be there is the shape that has bitten this project
       repeatedly. */
    const attempts: Array<{ name: string; run: () => Promise<{ ok: boolean; reason?: string }> }> = [
      {
        name: "contract creation",
        run: () =>
          createTaskContract(repo, {
            task_id: "T-001",
            title: "Should never be created",
            agent_role: "builder",
            base_commit: "0".repeat(40),
            allowed_files: ["README.md"],
            acceptance_criterion: "npm test passes",
            required_tests: ["npm test"]
          } as never)
      },
      { name: "lease grant", run: () => requestLease(repo, "T-001", ["README.md"]) },
      { name: "worktree creation", run: () => createTaskWorktree(repo, "T-001") },
      { name: "worker run", run: () => runTask(repo, "T-001") },
      { name: "scout run", run: () => runScout(repo, "T-001", "worker") },
      { name: "checkpoint", run: () => checkpointTask(repo, "T-001") }
    ];

    for (const attempt of attempts) {
      const result = await attempt.run();
      assert.equal(result.ok, false, `${attempt.name} must refuse against an unratified spec`);
      if (!result.ok) {
        assert.match(
          String(result.reason),
          /ratify it before|is draft|not ratified|no active spec/iu,
          `${attempt.name} must refuse BECAUSE the spec is unratified, not incidentally: ${result.reason}`
        );
      }
    }
  });
});

test("integration's gate is present, and is the same one", async () => {
  /* Integration is the one of the six that cannot be reached from an empty
     repository: it refuses for want of a queue before it ever consults the
     spec. Rather than fabricate a queue to reach a gate and call that a
     behavioural test, this asserts what is actually checkable here -- that
     integration is guarded by the same function the five paths above were
     observed to refuse through. The behavioural proof is that test. */
  const integrate = await readFile(path.resolve("src/integrate.ts"), "utf8");
  assert.match(integrate, /requireActiveSpecRatified\(repoRoot\)/u);
  assert.match(integrate, /import \{ requireActiveSpecRatified \} from "\.\/spec\.js";/u);
});

async function withDraftSpec(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "hivemind-draft-gate-")));
  try {
    const git = (args: string[]) => execFileAsync("git", args, { cwd: repo, windowsHide: true });
    await git(["init"]);
    await git(["config", "user.email", "test@example.test"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
    await git(["add", "."]);
    await git(["commit", "-m", "base"]);
    await initProject(repo);

    // A complete, valid spec that nobody has signed.
    assert.equal((await createSpec(repo, "S-001", "Draft gate fixture")).ok, true);
    assert.equal(
      (await startIdeationSession(repo, "S-001", "Draft gate fixture", "Prove the gate bites.")).ok,
      true
    );
    assert.equal(
      (
        await recordIdeationRound(repo, "S-001", {
          alternatives: [
            { title: "One way", tradeoffs: ["cheap", "narrow"] },
            { title: "Another way", tradeoffs: ["broad", "slow"] }
          ],
          self_critique: { weakest_point: "Thin.", cut_or_change: "Keep it deterministic." },
          spec_updates: { "Non-goals": "No production behaviour.", "Open questions": "" },
          substantive_change: true,
          orchestrator_calls_convergence: true
        })
      ).ok,
      true
    );

    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}
