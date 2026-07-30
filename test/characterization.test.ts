import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  validateCharacterizationCandidate,
  type CharacterizationCandidateInput
} from "../src/characterization.js";
import { initProject } from "../src/init.js";

const execFileAsync = promisify(execFile);

test("characterization classifies base failure, regression signals, and valid characterizations", async () => {
  await withCharacterizationRepo(async ({ repo }) => {
    const baseFailure = await validateCharacterizationCandidate(
      repo,
      await candidate(repo, "C-BASE-FAIL", "assert.equal(value, 'never');")
    );
    assert.equal(baseFailure.ok, true, baseFailure.ok ? undefined : baseFailure.reason);
    if (!baseFailure.ok) {
      return;
    }
    assert.equal(
      baseFailure.value.classification,
      "rejected",
      JSON.stringify(baseFailure.value.validation, null, 2)
    );
    assert.match(baseFailure.value.reason, /fails on the pre-change base/);
    assert.equal(baseFailure.value.validation.attempts.length, 1);

    const regression = await validateCharacterizationCandidate(
      repo,
      await candidate(repo, "C-REGRESSION", "assert.equal(value, 'before');")
    );
    assert.equal(regression.ok, true, regression.ok ? undefined : regression.reason);
    if (!regression.ok) {
      return;
    }
    assert.equal(regression.value.classification, "regression_signal");
    assert.match(regression.value.validation.semantic_interpretation, /human decides/);
    assert.equal(regression.value.validation.attempts.length, 2);
    assert.equal(regression.value.validation.attempts[0]?.runs.every((run) => run.exit_code === 0), true);
    assert.equal(regression.value.validation.attempts[1]?.runs.every((run) => run.exit_code !== 0), true);

    const valid = await validateCharacterizationCandidate(
      repo,
      await candidate(repo, "C-VALID", "assert.equal(typeof value, 'string');")
    );
    assert.equal(valid.ok, true, valid.ok ? undefined : valid.reason);
    if (!valid.ok) {
      return;
    }
    assert.equal(valid.value.classification, "valid_characterization");
    assert.equal(valid.value.validation.same_check_both_trees, true);
    assert.deepEqual(
      valid.value.validation.attempts.map((attempt) => attempt.command),
      ["node test/candidate.test.js", "node test/candidate.test.js"]
    );
    assert.equal(valid.value.validation.attempts.every((attempt) => attempt.runs.length === 2), true);
    assert.equal(valid.value.validation.attempts.flatMap((attempt) => attempt.runs).every((run) => run.exit_code === 0), true);
  });
});

test("candidate scope comes only from configured test_paths and is disposed by runGate", async () => {
  await withCharacterizationRepo(async ({ repo }) => {
    const configPath = path.join(repo, ".hivemind", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.allowed_globs = ["src/**"];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const outsidePatch = await capturePatch(repo, async () => {
      await writeFile(path.join(repo, "src", "unauthorized.js"), "export const unauthorized = true;\n");
    });
    const outside = await validateCharacterizationCandidate(repo, {
      candidate_id: "C-OUTSIDE",
      task_id: "T-001",
      check_id: "candidate",
      patch: outsidePatch
    });
    assert.equal(outside.ok, true, outside.ok ? undefined : outside.reason);
    if (!outside.ok) {
      return;
    }
    assert.equal(outside.value.classification, "rejected");
    assert.deepEqual(outside.value.validation.configured_test_paths, ["test/**/*.test.js"]);
    assert.equal(outside.value.validation.test_scope_source, "verification.test_paths");
    assert.equal(outside.value.validation.gate.verdict, "reject");
    assert.match(outside.value.validation.gate.reason, /rejected add src\/unauthorized\.js/);

    const selfAuthorized = await validateCharacterizationCandidate(repo, {
      ...(await candidate(repo, "C-SELF-AUTH", "assert.equal(value, 'before');")),
      test_paths: ["src/**"]
    });
    assert.equal(selfAuthorized.ok, false);
    if (!selfAuthorized.ok) {
      assert.match(selfAuthorized.reason, /unsupported characterization candidate fields: test_paths/);
    }
    await assertMissing(path.join(repo, ".hivemind", "resource", "oracle-candidates", "C-SELF-AUTH"));
  });
});

test("unset or empty test_paths refuses only candidate validation", async () => {
  await withCharacterizationRepo(async ({ repo }) => {
    const input = await candidate(repo, "C-NO-SCOPE", "assert.equal(value, 'before');");
    await setVerificationConfig(repo, undefined);
    const unset = await validateCharacterizationCandidate(repo, input);
    assert.equal(unset.ok, false);
    if (!unset.ok) {
      assert.equal(unset.reason, "no configured test paths: verification.test_paths is unset or empty");
    }

    await setVerificationConfig(repo, []);
    const empty = await validateCharacterizationCandidate(repo, { ...input, candidate_id: "C-EMPTY-SCOPE" });
    assert.equal(empty.ok, false);
    if (!empty.ok) {
      assert.equal(empty.reason, "no configured test paths: verification.test_paths is unset or empty");
    }
    await assertMissing(path.join(repo, ".hivemind", "resource", "oracle-candidates", "C-NO-SCOPE"));
    await assertMissing(path.join(repo, ".hivemind", "resource", "oracle-candidates", "C-EMPTY-SCOPE"));
  });
});

test("tree identity uncertainty is indeterminate and validation leaves repo, worktrees, and canon unchanged", async () => {
  await withCharacterizationRepo(async ({ repo }) => {
    const input = await candidate(repo, "C-INDETERMINATE", "assert.equal(value, 'before');");
    const taskPatchPath = path.join(repo, ".hivemind", "patches", "T-001", "diff.patch");
    await writeFile(taskPatchPath, input.patch);
    const before = await repoIdentity(repo);
    const canonBefore = await readdir(path.join(repo, ".hivemind", "canon"));

    const result = await validateCharacterizationCandidate(repo, input);

    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.classification, "indeterminate");
    assert.match(result.value.reason, /post-change tree identity could not be established/);
    assert.deepEqual(await repoIdentity(repo), before);
    assert.deepEqual(await readdir(path.join(repo, ".hivemind", "canon")), canonBefore);
    assert.equal((await gitStdout(repo, ["worktree", "list", "--porcelain"])).split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length, 1);
    assert.equal((await gitStdout(repo, ["branch", "--list"])).split(/\r?\n/).filter(Boolean).length, 1);

    const validationPath = path.join(repo, result.value.artifact_path, "validation.json");
    const originalValidation = await readFile(validationPath, "utf8");
    const repeated = await validateCharacterizationCandidate(repo, input);
    assert.equal(repeated.ok, false);
    if (!repeated.ok) {
      assert.match(repeated.reason, /candidate already exists/);
    }
    assert.equal(await readFile(validationPath, "utf8"), originalValidation);
  });
});

test("a check that mutates its disposable tree is indeterminate and leaves no checkout behind", async () => {
  await withCharacterizationRepo(async ({ repo }) => {
    await setVerificationConfig(repo, ["test/**/*.test.js"], "node -e \"require('node:fs').appendFileSync('src/value.js', '\\n// mutation\\n')\"");
    const result = await validateCharacterizationCandidate(
      repo,
      await candidate(repo, "C-MUTATING-CHECK", "assert.equal(typeof value, 'string');")
    );

    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.classification, "indeterminate");
    assert.match(result.value.reason, /changed while its check was running/);
    assert.equal((await gitStdout(repo, ["worktree", "list", "--porcelain"])).split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length, 1);
  });
});

async function withCharacterizationRepo(
  run: (fixture: { repo: string; baseCommit: string }) => Promise<void>
): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-characterization-"));
  try {
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "test"), { recursive: true });
    await writeFile(path.join(repo, ".gitignore"), ".hivemind/\n");
    await writeFile(path.join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(path.join(repo, "src", "value.js"), "export const value = 'before';\n");
    await writeFile(
      path.join(repo, "test", "smoke.test.js"),
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('smoke', () => assert.ok(true));\n"
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "characterization fixture"]);
    const baseCommit = await gitStdout(repo, ["rev-parse", "HEAD"]);
    assert.equal(await initProject(repo), 0);
    await setVerificationConfig(repo, ["test/**/*.test.js"]);
    await writeContract(repo, baseCommit);
    const taskPatch = await capturePatch(repo, async () => {
      await writeFile(path.join(repo, "src", "value.js"), "export const value = 'after';\n");
    });
    const patchDir = path.join(repo, ".hivemind", "patches", "T-001");
    await mkdir(patchDir, { recursive: true });
    await writeFile(path.join(patchDir, "diff.patch"), taskPatch);
    await run({ repo, baseCommit });
  } finally {
    await cleanupRepo(repo);
  }
}

async function candidate(
  repo: string,
  candidateId: string,
  assertion: string
): Promise<CharacterizationCandidateInput> {
  const patch = await capturePatch(repo, async () => {
    await writeFile(
      path.join(repo, "test", "candidate.test.js"),
      [
        "import assert from 'node:assert/strict';",
        "import { value } from '../src/value.js';",
        assertion,
        ""
      ].join("\n")
    );
  });
  return { candidate_id: candidateId, task_id: "T-001", check_id: "candidate", patch };
}

async function setVerificationConfig(
  repo: string,
  testPaths: string[] | undefined,
  command = "node test/candidate.test.js"
): Promise<void> {
  const configPath = path.join(repo, ".hivemind", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.verification = {
    checks: [{ id: "candidate", command, entry_files: ["test/smoke.test.js"] }],
    ...(testPaths === undefined ? {} : { test_paths: testPaths })
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeContract(repo: string, baseCommit: string): Promise<void> {
  await writeFile(
    path.join(repo, ".hivemind", "tasks", "T-001.contract.json"),
    `${JSON.stringify({
      task_id: "T-001",
      title: "Change value",
      agent_role: "builder",
      routing_task_type: "refactor",
      base_commit: baseCommit,
      acceptance_criterion: "The value changes.",
      allowed_files: ["src/value.js"],
      allowed_file_intents: { "src/value.js": "modify" },
      read_only_files: [],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["node --test test/smoke.test.js"],
      patch_requirements: []
    }, null, 2)}\n`
  );
}

async function capturePatch(repo: string, edit: () => Promise<void>): Promise<string> {
  await edit();
  await git(repo, ["add", "-A"]);
  const patch = await gitRawStdout(repo, ["diff", "--cached", "--binary", "--no-renames", "HEAD"]);
  await git(repo, ["reset", "--hard", "HEAD"]);
  await git(repo, ["clean", "-fd"]);
  return patch;
}

async function repoIdentity(repo: string): Promise<Record<string, string>> {
  return {
    head: await gitStdout(repo, ["rev-parse", "HEAD"]),
    status: await gitRawStdout(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    readme: await readFile(path.join(repo, "src", "value.js"), "utf8")
  };
}

async function cleanupRepo(repo: string): Promise<void> {
  try {
    const worktrees = await gitRawStdout(repo, ["worktree", "list", "--porcelain"]);
    for (const line of worktrees.split(/\r?\n/u)) {
      if (line.startsWith("worktree ")) {
        const worktreePath = line.slice("worktree ".length);
        if (path.resolve(worktreePath) !== path.resolve(repo)) {
          await git(repo, ["worktree", "remove", "--force", worktreePath]);
        }
      }
    }
  } catch {
    // Best-effort fixture cleanup before deleting its temporary repository.
  }
  await rm(repo, { recursive: true, force: true, maxRetries: 3 });
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await gitRawStdout(cwd, args)).trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 32
  });
  return result.stdout;
}
