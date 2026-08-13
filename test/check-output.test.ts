import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  CHECK_OUTPUT_LIMIT_BYTES,
  newChecksRunId,
  readCheckOutput,
  storeCheckOutput
} from "../src/check-output.js";
import { appendEvent } from "../src/events.js";
import { initProject } from "../src/init.js";
import { executeWorkspaceAction } from "../src/workspace-actions.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);

/* Keeping what the checks printed.
 *
 * This is the feature an embedded terminal was refused in favour of, so the
 * thing worth asserting is the gap it closes: before this, the trail recorded
 * that a check exited 1 and nothing about what it said.
 */

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  await withTemplateRepo(
    "check-output",
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
    "hivemind-check-output-test-"
  );
}

test("what a check printed is kept, and read back in the order it ran", async () => {
  await withRepo(async (repo) => {
    const runId = newChecksRunId();
    const stored = await storeCheckOutput(repo, runId, [
      { id: "lint", command: "npm run lint", exit_code: 0, stdout: "all good\n", stderr: "" },
      {
        id: "test",
        command: "npm test",
        exit_code: 1,
        stdout: "1 failing\n",
        stderr: "AssertionError: expected 2 to equal 3\n"
      }
    ]);
    assert.equal(stored.ok, true);

    const read = await readCheckOutput(repo, runId);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.checks.length, 2);
      assert.equal(read.value.checks[0]?.id, "lint");
      assert.equal(read.value.checks[1]?.id, "test");
      /* The sentence a person is actually looking for. */
      assert.match(read.value.checks[1]?.stderr ?? "", /expected 2 to equal 3/u);
      assert.equal(read.value.checks[1]?.exit_code, 1);
    }
  });
});

test("two checks sharing an id both survive", async () => {
  await withRepo(async (repo) => {
    const runId = newChecksRunId();
    await storeCheckOutput(repo, runId, [
      { id: "tests", command: "npm test", exit_code: 0, stdout: "contract validity\n", stderr: "" },
      { id: "tests", command: "npm test", exit_code: 1, stdout: "selected checks\n", stderr: "" }
    ]);
    const read = await readCheckOutput(repo, runId);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.checks.length, 2, "a repeated check id overwrote the earlier output");
      assert.match(read.value.checks[0]?.stdout ?? "", /contract validity/u);
      assert.match(read.value.checks[1]?.stdout ?? "", /selected checks/u);
    }
  });
});

test("a runaway log is cut and says so rather than becoming the trail's problem", async () => {
  await withRepo(async (repo) => {
    const runId = newChecksRunId();
    await storeCheckOutput(repo, runId, [
      {
        id: "noisy",
        command: "npm test",
        exit_code: 1,
        stdout: "x".repeat(CHECK_OUTPUT_LIMIT_BYTES + 5000),
        stderr: ""
      }
    ]);
    const read = await readCheckOutput(repo, runId);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.value.checks[0]?.truncated, true);
      assert.ok((read.value.checks[0]?.stdout.length ?? 0) <= CHECK_OUTPUT_LIMIT_BYTES);
    }
  });
});

test("the run identifier is validated before it reaches a path", async () => {
  await withRepo(async (repo) => {
    for (const attempt of [
      "../../etc",
      "C-../../escape",
      "not-an-id",
      "C-",
      ".hivemind"
    ]) {
      const read = await readCheckOutput(repo, attempt);
      assert.equal(read.ok, false, `readCheckOutput accepted ${attempt}`);
    }
  });
});

test("checks.inspect serves the most recent recorded run, found through the trail", async () => {
  await withRepo(async (repo) => {
    const older = newChecksRunId();
    const newer = newChecksRunId();
    await storeCheckOutput(repo, older, [
      { id: "test", command: "npm test", exit_code: 1, stdout: "the older failure\n", stderr: "" }
    ]);
    await storeCheckOutput(repo, newer, [
      { id: "test", command: "npm test", exit_code: 1, stdout: "the newer failure\n", stderr: "" }
    ]);
    for (const checksRunId of [older, newer]) {
      const appended = await appendEvent(repo, {
        type: "verification.completed",
        task_id: null,
        data: { task_ids: ["T-001"], checks_run_id: checksRunId, tests: "fail" }
      });
      assert.equal(appended.ok, true);
    }

    const served = await executeWorkspaceAction(repo, { type: "checks.inspect", payload: {} });
    assert.equal(served.ok, true);
    if (served.ok) {
      const value = served.value as { checks: { stdout: string }[]; tests: string | null };
      /* The LATEST, by the trail's order rather than by a directory listing --
         two run identifiers sort by UUID, which is not chronology. */
      assert.match(value.checks[0]?.stdout ?? "", /the newer failure/u);
      assert.equal(value.tests, "fail");
    }
  });
});

test("checks.inspect says nothing has been recorded rather than inventing a run", async () => {
  await withRepo(async (repo) => {
    const served = await executeWorkspaceAction(repo, { type: "checks.inspect", payload: {} });
    assert.equal(served.ok, false);
    if (!served.ok) assert.match(served.reason, /no checks have been run/u);

    const shaped = await executeWorkspaceAction(repo, {
      type: "checks.inspect",
      payload: { checks_run_id: "C-whatever" }
    });
    assert.equal(shaped.ok, false);
    if (!shaped.ok) assert.match(shaped.reason, /takes no fields/u);
  });
});

test("verification records the identifier of the output it kept", async () => {
  /* Asserted against the SOURCE of the event write, because running a real
     verification needs a worktree, a contract and a ratified plan -- and the
     property that matters here is narrow: the event must carry the identifier,
     or the pane has no way to find the output at all. The behavioural half is
     covered by the action test above, which reads a real stored run. */
  const source = await readFile(path.resolve("src/verification.ts"), "utf8");
  assert.match(source, /storeCheckOutput\(repoRoot, checksRunId, checks\)/u);
  assert.match(source, /checks_run_id: stored\.ok \? checksRunId : null/u);
  /* A failure to keep a log must not fail the verification. */
  assert.doesNotMatch(source, /if \(!stored\.ok\) return/u);
});

test("the output store is written beside the trail, never into it", async () => {
  await withRepo(async (repo) => {
    const runId = newChecksRunId();
    await storeCheckOutput(repo, runId, [
      { id: "test", command: "npm test", exit_code: 1, stdout: "boom\n", stderr: "" }
    ]);
    /* An event carrying a megabyte of test output is a record nobody can
       append quickly and every reader pages past. The event keeps the
       identifier; the file keeps the bytes. */
    const trail = await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8").catch(
      () => ""
    );
    assert.ok(!trail.includes("boom"), "check output was written into the trail");
    await mkdir(path.join(repo, ".hivemind", "checks"), { recursive: true });
    const stored = await readFile(
      path.join(repo, ".hivemind", "checks", runId, "000.json"),
      "utf8"
    );
    assert.match(stored, /boom/u);
  });
});
