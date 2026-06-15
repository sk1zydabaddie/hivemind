import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { initProject } from "../src/init.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("init creates the M0.1 .hivemind scaffold inside a git repo", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));

    const code = await initProject(repo);

    assert.equal(code, 0);
    await assertExists(path.join(repo, ".hivemind", "tasks"));
    await assertExists(path.join(repo, ".hivemind", "log"));
    await assertExists(path.join(repo, ".hivemind", "patches"));
    await assertExists(path.join(repo, ".hivemind", "worktrees"));
    await assertExists(path.join(repo, ".hivemind", "adapters"));
    await assertExists(path.join(repo, ".hivemind", "canon"));
    assert.equal(await readFile(path.join(repo, ".hivemind", "log", "events.jsonl"), "utf8"), "");

    const config = JSON.parse(await readFile(path.join(repo, ".hivemind", "config.json"), "utf8")) as {
      version: number;
      stack: string;
      repo_root: string;
      test_command: string;
      allowed_globs: string[];
      forbidden_globs: string[];
    };

    assert.deepEqual(config, {
      version: 1,
      stack: "typescript-node",
      repo_root: repo.replaceAll("\\", "/"),
      test_command: "npm test",
      allowed_globs: [],
      forbidden_globs: ["**/*.lock", "**/package.json", "**/.git/**"]
    });
  });
});

test("init fails outside a git repo", async () => {
  await withTempDir(async (dir) => {
    const code = await initProject(dir);
    assert.equal(code, 1);
  });
});

test("init is idempotent and does not overwrite config", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);

    assert.equal(await initProject(repo), 0);
    const configPath = path.join(repo, ".hivemind", "config.json");
    const original = await readFile(configPath, "utf8");
    const edited = original.replace('"test_command": ""', '"test_command": "custom"');
    await writeFile(configPath, edited);

    assert.equal(await initProject(repo), 0);
    assert.equal(await readFile(configPath, "utf8"), edited);
  });
});

test("CLI init reports exact success and outside-git failure behavior", async () => {
  await withTempDir(async (repo) => {
    await git(repo, ["init"]);

    const success = await execFileAsync("node", [cliPath, "init"], { cwd: repo, windowsHide: true });
    assert.equal(success.stdout.trim(), "initialized hivemind project");
    assert.equal(success.stderr, "");
  });

  await withTempDir(async (dir) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "init"], { cwd: dir, windowsHide: true }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.notEqual(error, null);
        assert.equal((error as { code?: number }).code, 1);
        assert.equal((error as { stderr?: string }).stderr?.trim(), "error: not a git repository");
        return true;
      }
    );
  });
});

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemind-init-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function assertExists(filePath: string): Promise<void> {
  await stat(filePath);
}
