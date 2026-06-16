import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const protectedMergePath = path.resolve(testDir, "../../scripts/hivemind-protected-merge.mjs");

test("protected merge blocks an out-of-scope Hivemind change before merge", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const featureCommit = await createFeatureBranch(repo, "feature-out", async () => {
      await writeFile(path.join(repo, "outside.txt"), "outside edit\n");
    });
    await git(repo, ["checkout", "main"]);
    await writeContract(repo, "T-OUT", baseCommit, ["README.md"]);
    await writePatchFromRef(repo, "T-OUT", baseCommit, "feature-out");

    await assert.rejects(
      execFileAsync(process.execPath, [protectedMergePath, "T-OUT", "feature-out"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        const parsed = JSON.parse(String((error as { stdout?: string }).stdout)) as { verdict: string; reason: string };
        assert.equal(parsed.verdict, "reject");
        assert.match(parsed.reason, /outside\.txt/);
        assert.match(String((error as { stderr?: string }).stderr), /protected merge blocked by hivemind analyze/);
        return true;
      }
    );

    assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), baseCommit);
    assert.notEqual(await gitStdout(repo, ["rev-parse", "HEAD"]), featureCommit);
    assert.equal(normalizeNewlines(await readFile(path.join(repo, "outside.txt"), "utf8")), "outside base\n");
  });
});

test("protected merge allows an in-scope Hivemind change to merge", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    const featureCommit = await createFeatureBranch(repo, "feature-in", async () => {
      await writeFile(path.join(repo, "README.md"), "# Fixture\naccepted edit\n");
    });
    await git(repo, ["checkout", "main"]);
    await writeContract(repo, "T-IN", baseCommit, ["README.md"]);
    await writePatchFromRef(repo, "T-IN", baseCommit, "feature-in");

    const result = await execFileAsync(process.execPath, [protectedMergePath, "T-IN", "feature-in"], {
      cwd: repo,
      windowsHide: true
    });

    const parsed = parseAnalyzeOutput(result.stdout);
    assert.equal(parsed.verdict, "accept");
    assert.equal(result.stderr, "");
    assert.equal(await gitStdout(repo, ["rev-parse", "HEAD"]), featureCommit);
    assert.equal(normalizeNewlines(await readFile(path.join(repo, "README.md"), "utf8")), "# Fixture\naccepted edit\n");
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-self-protect-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await git(repo, ["checkout", "-b", "main"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "outside.txt"), "outside base\n");
    await git(repo, ["add", "README.md", "outside.txt"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await cleanupTempRepo(repo);
  }
}

async function createFeatureBranch(repo: string, branch: string, edit: () => Promise<void>): Promise<string> {
  await git(repo, ["checkout", "-b", branch]);
  await edit();
  await git(repo, ["add", "README.md", "outside.txt"]);
  await git(repo, ["commit", "-m", `change ${branch}`]);
  return gitStdout(repo, ["rev-parse", "HEAD"]);
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Self-protected merge",
        agent_role: "builder",
        base_commit: baseCommit,
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: [],
        patch_requirements: []
      },
      null,
      2
    )}\n`
  );
}

async function writePatchFromRef(repo: string, taskId: string, baseCommit: string, ref: string): Promise<void> {
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  await writeFile(path.join(patchDir, "diff.patch"), await gitRawStdout(repo, ["diff", "--no-renames", baseCommit, ref]));
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function gitRawStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "buffer" });
  return result.stdout.toString("utf8");
}

function parseAnalyzeOutput(stdout: string): { verdict?: string; reason?: string } {
  const match = stdout.match(/\{\s*"verdict"[\s\S]*?\n\}/);
  assert.notEqual(match, null);
  return JSON.parse(match?.[0] ?? "{}") as { verdict?: string; reason?: string };
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

async function cleanupTempRepo(repo: string): Promise<void> {
  await rm(repo, { recursive: true, force: true, maxRetries: 3 });
}
