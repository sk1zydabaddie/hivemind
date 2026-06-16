import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { readEvents } from "../src/events.js";
import { initProject } from "../src/init.js";
import { releaseLease, requestLease } from "../src/lease.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("requestLease rejects an overlapping grant and names the holder", async () => {
  await withTempRepo(async ({ repo }) => {
    const first = await requestLease(repo, "T-001", ["README.md"]);
    const second = await requestLease(repo, "T-002", ["README.md"]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (second.ok) {
      return;
    }
    assert.match(second.reason, /README\.md held by T-001/);
    assert.deepEqual(await readActive(repo), { "README.md": "T-001" });
    const events = await readEvents(repo);
    assert.equal(events.ok, true);
    if (!events.ok) {
      return;
    }
    assert.deepEqual(
      events.value.map((event) => event.type),
      ["lease.approved", "lease.rejected"]
    );
    assert.equal(events.value[1].task_id, "T-002");
    assert.match(String(events.value[1].data.reason), /README\.md held by T-001/);
  });
});

test("requestLease grants disjoint paths and is idempotent for the same task", async () => {
  await withTempRepo(async ({ repo }) => {
    const first = await requestLease(repo, "T-001", ["README.md"]);
    const second = await requestLease(repo, "T-002", ["src/feature.ts"]);
    const repeat = await requestLease(repo, "T-001", ["README.md", "README.md"]);

    assert.deepEqual(first, { ok: true, value: { task_id: "T-001", granted: ["README.md"] } });
    assert.deepEqual(second, { ok: true, value: { task_id: "T-002", granted: ["src/feature.ts"] } });
    assert.deepEqual(repeat, { ok: true, value: { task_id: "T-001", granted: ["README.md"] } });
    assert.deepEqual(await readActive(repo), { "README.md": "T-001", "src/feature.ts": "T-002" });
  });
});

test("releaseLease removes only the task's leases and frees paths", async () => {
  await withTempRepo(async ({ repo }) => {
    await requestLease(repo, "T-001", ["README.md", "src/feature.ts"]);
    await requestLease(repo, "T-002", ["src/other.ts"]);

    const released = await releaseLease(repo, "T-001");
    const nextGrant = await requestLease(repo, "T-002", ["README.md"]);

    assert.deepEqual(released, { ok: true, value: { task_id: "T-001", released: ["README.md", "src/feature.ts"] } });
    assert.equal(nextGrant.ok, true);
    assert.deepEqual(await readActive(repo), { "README.md": "T-002", "src/other.ts": "T-002" });
  });
});

test("releaseLease is a no-op when the lease file is missing", async () => {
  await withTempRepo(async ({ repo }) => {
    const released = await releaseLease(repo, "T-001");

    assert.deepEqual(released, { ok: true, value: { task_id: "T-001", released: [] } });
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("requestLease fails closed for invalid lease store files", async () => {
  await withTempRepo(async ({ repo }) => {
    const activePath = path.join(repo, ".hivemind", "leases", "active.json");
    await mkdir(path.dirname(activePath), { recursive: true });
    await writeFile(activePath, "{not json}\n");

    const invalidJson = await requestLease(repo, "T-001", ["README.md"]);
    assert.equal(invalidJson.ok, false);
    if (invalidJson.ok) {
      return;
    }
    assert.match(invalidJson.reason, /invalid JSON/);

    await writeFile(activePath, "[]\n");
    const invalidShape = await requestLease(repo, "T-001", ["README.md"]);
    assert.equal(invalidShape.ok, false);
    if (invalidShape.ok) {
      return;
    }
    assert.match(invalidShape.reason, /lease store must be a JSON object/);
  });
});

test("requestLease rejects invalid task ids and invalid paths before writing", async () => {
  await withTempRepo(async ({ repo }) => {
    const invalidTask = await requestLease(repo, "../evil", ["README.md"]);
    const glob = await requestLease(repo, "T-001", ["src/*.ts"]);
    const directory = await requestLease(repo, "T-001", ["src"]);

    assert.equal(invalidTask.ok, false);
    assert.equal(glob.ok, false);
    assert.equal(directory.ok, false);
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("concurrent requestLease calls for the same file never both win", async () => {
  await withTempRepo(async ({ repo }) => {
    const results = await Promise.all([
      requestLease(repo, "T-001", ["README.md"]),
      requestLease(repo, "T-002", ["README.md"])
    ]);

    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 1);
    assert.equal(Object.keys(await readActive(repo)).length, 1);
  });
});

test("CLI lease grants contract allowed_files and releases them", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md", "src/feature.ts"]);

    const granted = await execFileAsync("node", [cliPath, "lease", "T-001"], { cwd: repo, windowsHide: true });
    const released = await execFileAsync("node", [cliPath, "lease", "T-001", "--release"], { cwd: repo, windowsHide: true });

    assert.equal(granted.stderr, "");
    assert.deepEqual(JSON.parse(granted.stdout), {
      task_id: "T-001",
      granted: ["README.md", "src/feature.ts"]
    });
    assert.equal(released.stderr, "");
    assert.deepEqual(JSON.parse(released.stdout), {
      task_id: "T-001",
      released: ["README.md", "src/feature.ts"]
    });
    assert.deepEqual(await readActive(repo), {});
  });
});

test("CLI lease refuses contract files that do not exist at the contract base commit", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeFile(path.join(repo, "LATER.md"), "later\n");
    await git(repo, ["add", "LATER.md"]);
    await git(repo, ["commit", "-m", "add later"]);
    await writeContract(repo, "T-STALE", baseCommit, ["LATER.md"]);

    await assert.rejects(
      execFileAsync("node", [cliPath, "lease", "T-STALE"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /LATER\.md.*not a tracked file at base/);
        return true;
      }
    );
    await assertMissing(path.join(repo, ".hivemind", "leases", "active.json"));
  });
});

test("CLI lease rejects contract globs and overlapping leases", async () => {
  await withTempRepo(async ({ repo, baseCommit }) => {
    await writeContract(repo, "T-001", baseCommit, ["README.md"]);
    await writeContract(repo, "T-002", baseCommit, ["README.md"]);
    await writeContract(repo, "T-003", baseCommit, ["src/*.ts"]);
    await execFileAsync("node", [cliPath, "lease", "T-001"], { cwd: repo, windowsHide: true });

    await assert.rejects(
      execFileAsync("node", [cliPath, "lease", "T-002"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /README\.md held by T-001/);
        return true;
      }
    );

    await assert.rejects(
      execFileAsync("node", [cliPath, "lease", "T-003"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /uses a glob; contract lease scopes must be concrete files/);
        return true;
      }
    );
  });
});

test("CLI lease rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "lease"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind lease <id> \[--release\]/);
        return true;
      }
    );
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-lease-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Fixture\n");
    await writeFile(path.join(repo, "src", "feature.ts"), "export const feature = true;\n");
    await writeFile(path.join(repo, "src", "other.ts"), "export const other = true;\n");
    await git(repo, ["add", "README.md", "src/feature.ts", "src/other.ts"]);
    await git(repo, ["commit", "-m", "initial"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function writeContract(repo: string, taskId: string, baseCommit: string, allowedFiles: string[]): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    path.join(tasksDir, `${taskId}.contract.json`),
    `${JSON.stringify(
      {
        task_id: taskId,
        title: "Lease files",
        agent_role: "builder",
        base_commit: baseCommit,
        acceptance_criterion: "Lease fixture grants one concrete scope.",
        allowed_files: allowedFiles,
        read_only_files: [],
        forbidden_files: [],
        allowed_symbols: [],
        forbidden_symbols: [],
        must_not_change: [],
        required_tests: ["node -e \"process.exit(0)\""],
        patch_requirements: []
      },
      null,
      2
    )}\n`
  );
}

async function readActive(repo: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(path.join(repo, ".hivemind", "leases", "active.json"), "utf8")) as Record<string, string>;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(stat(filePath), (error: unknown) => {
    assert.equal(typeof error, "object");
    assert.notEqual(error, null);
    assert.equal((error as { code?: string }).code, "ENOENT");
    return true;
  });
}
