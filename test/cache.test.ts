import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { cacheDbPath, readCacheSnapshot, rebuildCache } from "../src/cache.js";
import { initProject } from "../src/init.js";
import { requestLease } from "../src/lease.js";
import { getStatus } from "../src/status.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("cache rebuild is fully derived and reproducible after deleting SQLite", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", "Cache task", baseCommit, ["README.md"]);
    await requestLease(repo, "T-001", ["README.md"]);
    await writePatch(repo, "T-001");
    await writeQueue(repo, ["T-001"]);
    await writeIntegrationStatus(repo, {
      branch: "integration/20260616-000000000Z",
      applied: ["T-001"],
      tests: "pass",
      report: "cache fixture\n"
    });

    const first = await rebuildCache(repo);
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.deepEqual(
      {
        tasks: first.value.tasks,
        leases: first.value.leases,
        events: first.value.events,
        patches: first.value.patches,
        integration_queue: first.value.integration_queue,
        integration_status: first.value.integration_status
      },
      {
        tasks: 1,
        leases: 1,
        events: 1,
        patches: 1,
        integration_queue: 1,
        integration_status: true
      }
    );

    const before = await readCacheSnapshot(repo);
    await rm(cacheDbPath(repo), { force: true });
    const second = await rebuildCache(repo);
    assert.equal(second.ok, true);
    const after = await readCacheSnapshot(repo);

    assert.deepEqual(after, before);
  });
});

test("cache rebuild command prints JSON and uses the same derived state", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", "CLI cache task", baseCommit, ["README.md"]);

    const result = await execFileAsync(process.execPath, [cliPath, "cache", "rebuild"], {
      cwd: repo,
      windowsHide: true
    });
    const parsed = JSON.parse(result.stdout) as { path: string; tasks: number; leases: number; events: number };

    assert.equal(parsed.path, ".hivemind/cache/state.sqlite");
    assert.equal(parsed.tasks, 1);
    assert.equal(parsed.leases, 0);
    assert.equal(parsed.events, 0);
    assert.match(result.stderr, /ExperimentalWarning|^$/);
  });
});

test("guarantee and status paths continue to read disk state when cache is corrupt", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", "Disk authority task", baseCommit, ["README.md"]);
    await requestLease(repo, "T-001", ["README.md"]);
    const rebuilt = await rebuildCache(repo);
    assert.equal(rebuilt.ok, true);
    await writeFile(cacheDbPath(repo), "not a sqlite database\n");

    const status = await getStatus(repo);

    assert.equal(status.ok, true);
    if (!status.ok) {
      return;
    }
    assert.deepEqual(status.value.leases, { "README.md": "T-001" });
    assert.equal(status.value.tasks.length, 1);
    assert.equal(status.value.tasks[0].task_id, "T-001");
  });
});

test("failed rebuild leaves existing cache untouched", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", "Stable cache task", baseCommit, ["README.md"]);
    const initial = await rebuildCache(repo);
    assert.equal(initial.ok, true);
    const before = await readCacheSnapshot(repo);
    await mkdir(path.join(repo, ".hivemind", "leases"), { recursive: true });
    await writeFile(path.join(repo, ".hivemind", "leases", "active.json"), "{ invalid json\n");

    const failed = await rebuildCache(repo);

    assert.deepEqual(failed, { ok: false, reason: "invalid JSON in .hivemind/leases/active.json" });
    assert.deepEqual(await readCacheSnapshot(repo), before);
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-cache-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await git(repo, ["checkout", "-b", "main"]);
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function writeContract(repo: string, taskId: string, title: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "tasks"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "tasks", `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title,
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

async function writePatch(repo: string, taskId: string): Promise<void> {
  const patchDir = path.join(repo, ".hivemind", "patches", taskId);
  await mkdir(patchDir, { recursive: true });
  await writeFile(
    path.join(patchDir, "diff.patch"),
    [
      "diff --git a/README.md b/README.md",
      "index 4444444..5555555 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " # Fixture",
      "+cached"
    ].join("\n")
  );
}

async function writeQueue(repo: string, taskIds: string[]): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
  await writeFile(
    path.join(repo, ".hivemind", "integration", "queue.json"),
    `${JSON.stringify(taskIds.map((taskId) => ({ task_id: taskId })), null, 2)}\n`
  );
}

async function writeIntegrationStatus(repo: string, status: { branch: string; applied: string[]; tests: "pass" | "fail"; report: string }): Promise<void> {
  await mkdir(path.join(repo, ".hivemind", "integration"), { recursive: true });
  await writeFile(path.join(repo, ".hivemind", "integration", "status.json"), `${JSON.stringify(status, null, 2)}\n`);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
