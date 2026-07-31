import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { TaskContract } from "../src/contract.js";
import type { DecisionConfig } from "../src/decision.js";
import { runGate } from "../src/gate.js";

const execFileAsync = promisify(execFile);

test("runGate accepts an all-in-scope modify patch", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "README.md"), "# Fixture\nchanged\n");
    const patchPath = await writePatch(repo, "modify.patch");
    await resetRepo(repo, baseCommit);

    const result = await runGate(baseCommit, patchPath, contractFor({ allowed_files: ["README.md"] }), configFor(repo));

    assert.deepEqual(result, { verdict: "accept", reason: "all changes are within scope" });
  });
});

test("runGate rejects an out-of-scope patch and names the file", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "outside.txt"), "outside changed\n");
    const patchPath = await writePatch(repo, "outside.patch");
    await resetRepo(repo, baseCommit);

    const result = await runGate(baseCommit, patchPath, contractFor({ allowed_files: ["README.md"] }), configFor(repo));

    assert.equal(result.verdict, "reject");
    assert.match(result.reason, /outside\.txt/);
  });
});

test("runGate rejects Hivemind canon changes even when the contract and config allow them", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const canonFile = ".hivemind/canon/M-fixture.memory.json";
    await mkdir(path.join(repo, ".hivemind", "canon"), { recursive: true });
    await writeFile(path.join(repo, canonFile), "{}\n");
    const patchPath = await writePatch(repo, "canon.patch");
    await resetRepo(repo, baseCommit);

    const result = await runGate(
      baseCommit,
      patchPath,
      contractFor({ allowed_files: [canonFile], allowed_file_intents: { [canonFile]: "create" } }),
      { ...configFor(repo), allowed_globs: [".hivemind/canon/**"] }
    );

    assert.equal(result.verdict, "reject");
    assert.match(result.reason, /rejected add \.hivemind\/canon\/M-fixture\.memory\.json/);
  });
});

test("runGate rejects a patch that does not apply to the declared base", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "README.md"), "# Fixture\nsecond base\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "second base"]);
    const secondBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\npatch against second base\n");
    const patchPath = await writePatch(repo, "wrong-base.patch");
    await resetRepo(repo, secondBase);

    const result = await runGate(baseCommit, patchPath, contractFor({ allowed_files: ["README.md"] }), configFor(repo));

    assert.deepEqual(result, { verdict: "reject", reason: "patch does not apply to declared base" });
  });
});

test("runGate accepts an allowed add by canonicalizing against the applied checkout", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "new-file.txt"), "new\n");
    const patchPath = await writePatch(repo, "add.patch");
    await resetRepo(repo, baseCommit);
    await rm(path.join(repo, "new-file.txt"), { force: true });

    const result = await runGate(baseCommit, patchPath, contractFor({ allowed_files: ["new-file.txt"] }), configFor(repo));

    assert.deepEqual(result, { verdict: "accept", reason: "all changes are within scope" });
  });
});

test("runGate accepts an allowed delete by canonicalizing against the base checkout", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await rm(path.join(repo, "delete-me.txt"));
    const patchPath = await writePatch(repo, "delete.patch");
    await resetRepo(repo, baseCommit);

    const result = await runGate(baseCommit, patchPath, contractFor({ allowed_files: ["delete-me.txt"] }), configFor(repo));

    assert.deepEqual(result, { verdict: "accept", reason: "all changes are within scope" });
  });
});

test("runGate rejects a forbidden delete using the base checkout", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await rm(path.join(repo, "delete-me.txt"));
    const patchPath = await writePatch(repo, "forbidden-delete.patch");
    await resetRepo(repo, baseCommit);

    const result = await runGate(
      baseCommit,
      patchPath,
      contractFor({ allowed_files: ["delete-me.txt"], forbidden_files: ["delete-me.txt"] }),
      configFor(repo)
    );

    assert.equal(result.verdict, "reject");
    assert.match(result.reason, /delete-me\.txt/);
  });
});

test("runGate escalates when every changed path is in scope but an op requires review", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await git(repo, ["update-index", "--chmod=+x", "script.sh"]);
    const patchPath = await writePatch(repo, "mode.patch");
    await resetRepo(repo, baseCommit);

    const result = await runGate(baseCommit, patchPath, contractFor({ allowed_files: ["script.sh"] }), configFor(repo));

    assert.equal(result.verdict, "escalate");
    assert.match(result.reason, /script\.sh/);
  });
});

test("runGate gives reject precedence over escalate", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "outside.txt"), "outside changed\n");
    await git(repo, ["update-index", "--chmod=+x", "script.sh"]);
    const patchPath = await writePatch(repo, "reject-over-escalate.patch");
    await resetRepo(repo, baseCommit);

    const result = await runGate(baseCommit, patchPath, contractFor({ allowed_files: ["script.sh"] }), configFor(repo));

    assert.equal(result.verdict, "reject");
    assert.match(result.reason, /outside\.txt/);
  });
});

test("runGate accepts an empty patch as no changes", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const patchPath = path.join(repo, "empty.patch");
    await writeFile(patchPath, "");

    const result = await runGate(baseCommit, patchPath, contractFor({ allowed_files: ["README.md"] }), configFor(repo));

    assert.deepEqual(result, { verdict: "accept", reason: "no changes" });
  });
});

test("runGate returns reject instead of throwing on an internal failure path", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const patchPath = path.join(repo, "empty.patch");
    await writeFile(patchPath, "");

    const result = await runGate(
      baseCommit,
      patchPath,
      contractFor({ allowed_files: ["README.md"] }),
      configFor(path.join(repo, "missing-root"))
    );

    assert.equal(result.verdict, "reject");
    assert.notEqual(result.reason, "");
  });
});

test("runGate cleans up throwaway worktrees on success and failure", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "README.md"), "# Fixture\ncleanup success\n");
    const successPatch = await writePatch(repo, "cleanup-success.patch");
    await resetRepo(repo, baseCommit);

    await writeFile(path.join(repo, "README.md"), "# Fixture\nsecond base\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "second base"]);
    const secondBase = await gitStdout(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\ncleanup wrong base\n");
    const failurePatch = await writePatch(repo, "cleanup-failure.patch");
    await resetRepo(repo, secondBase);

    const success = await runGate(baseCommit, successPatch, contractFor({ allowed_files: ["README.md"] }), configFor(repo));
    const failure = await runGate(baseCommit, failurePatch, contractFor({ allowed_files: ["README.md"] }), configFor(repo));

    assert.equal(success.verdict, "accept");
    assert.equal(failure.verdict, "reject");
    assert.equal(
      (await gitStdout(repo, ["worktree", "list", "--porcelain"]))
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("worktree ")).length,
      1
    );
  });
});

function contractFor(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    task_id: "T-001",
    title: "Gate fixture",
    agent_role: "builder",
    routing_task_type: "other",
    base_commit: "abc123",
    acceptance_criterion: "Gate fixture produces one verdict.",
    allowed_files: ["README.md"],
    allowed_file_intents: { "README.md": "modify" },
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ["node -e \"process.exit(0)\""],
    patch_requirements: [],
    ...overrides
  };
}

function configFor(repo: string): DecisionConfig {
  return {
    version: 1,
    stack: "typescript-node",
    repo_root: repo,
    test_command: "",
    allowed_globs: [],
    forbidden_globs: []
  };
}

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-gate-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "delete-me.txt"), "delete me\n");
    await writeFile(path.join(repo, "outside.txt"), "outside\n");
    await writeFile(path.join(repo, "script.sh"), "#!/bin/sh\necho fixture\n");
    await git(repo, ["add", "README.md", "delete-me.txt", "outside.txt", "script.sh"]);
    await git(repo, ["commit", "-m", "initial"]);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

async function cleanupTempRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const worktreePath = line.slice("worktree ".length);
      if (worktreePath !== repo) {
        await git(repo, ["worktree", "remove", "--force", worktreePath]);
      }
    }
  } catch {
    // Best-effort cleanup before deleting the temp repo.
  }
  await rm(repo, { recursive: true, force: true });
}

async function writePatch(repo: string, fileName: string): Promise<string> {
  const patchDir = path.join(repo, "patches");
  await mkdir(patchDir, { recursive: true });
  const patchPath = path.join(patchDir, fileName);
  await makeUntrackedFilesDiffable(repo);
  await writeFile(patchPath, await gitRawStdout(repo, ["diff", "--no-renames", "HEAD"]));
  return patchPath;
}

async function makeUntrackedFilesDiffable(repo: string): Promise<void> {
  const result = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repo,
    windowsHide: true
  });
  const files = result.stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .filter((entry) => !entry.startsWith("patches/"));
  if (files.length > 0) {
    await git(repo, ["add", "--intent-to-add", "--", ...files]);
  }
}

async function resetRepo(repo: string, commit: string): Promise<void> {
  await git(repo, ["reset", "--hard", commit]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
  return result.stdout;
}
