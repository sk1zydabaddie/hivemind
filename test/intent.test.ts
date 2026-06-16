import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { checkWriteIntent, validateWriteIntent } from "../src/intent.js";
import { initProject } from "../src/init.js";
import { requestLease } from "../src/lease.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("checkWriteIntent passes when all intended files are leased to the task", async () => {
  await withTempRepo(async ({ repo }) => {
    await requestLease(repo, "T-001", ["README.md", "src/feature.ts"]);

    const result = await checkWriteIntent(repo, "T-001", {
      task_id: "T-001",
      intended_files: ["README.md", "src/feature.ts"],
      intended_symbols: ["feature"],
      possible_risks: ["small refactor"],
      will_not_change: ["schema"]
    });

    assert.deepEqual(result, {
      ok: true,
      value: {
        task_id: "T-001",
        verdict: "pass",
        intended_files: ["README.md", "src/feature.ts"]
      }
    });
  });
});

test("checkWriteIntent rejects unleased and differently held files with path details", async () => {
  await withTempRepo(async ({ repo }) => {
    await requestLease(repo, "T-001", ["README.md"]);
    await requestLease(repo, "T-002", ["src/other.ts"]);

    const result = await checkWriteIntent(repo, "T-001", {
      task_id: "T-001",
      intended_files: ["README.md", "src/feature.ts", "src/other.ts"]
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /src\/feature\.ts is not leased/);
    assert.match(result.reason, /src\/other\.ts held by T-002/);
  });
});

test("checkWriteIntent fails closed when no active lease file exists", async () => {
  await withTempRepo(async ({ repo }) => {
    const result = await checkWriteIntent(repo, "T-001", {
      task_id: "T-001",
      intended_files: ["README.md"]
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.match(result.reason, /README\.md is not leased/);
  });
});

test("checkWriteIntent rejects invalid intent paths", async () => {
  await withTempRepo(async ({ repo }) => {
    await requestLease(repo, "T-001", ["README.md"]);

    const glob = await checkWriteIntent(repo, "T-001", {
      task_id: "T-001",
      intended_files: ["src/*.ts"]
    });
    const directory = await checkWriteIntent(repo, "T-001", {
      task_id: "T-001",
      intended_files: ["src"]
    });
    const traversal = await checkWriteIntent(repo, "T-001", {
      task_id: "T-001",
      intended_files: ["../outside.ts"]
    });

    assert.equal(glob.ok, false);
    assert.equal(directory.ok, false);
    assert.equal(traversal.ok, false);
    if (!glob.ok) {
      assert.match(glob.reason, /globs are not allowed/);
    }
    if (!directory.ok) {
      assert.match(directory.reason, /path is a directory/);
    }
    if (!traversal.ok) {
      assert.match(traversal.reason, /\.\. traversal is not allowed/);
    }
  });
});

test("validateWriteIntent rejects malformed intent shapes", () => {
  assert.deepEqual(validateWriteIntent([], "T-001"), { ok: false, reason: "intent must be a JSON object" });

  assert.deepEqual(
    validateWriteIntent(
      {
        task_id: "T-OTHER",
        intended_files: [],
        intended_symbols: ["ok"],
        possible_risks: "risk",
        will_not_change: [1]
      },
      "T-001"
    ),
    {
      ok: false,
      reason:
        'task_id "T-OTHER" must match requested task id "T-001"; intended_files must be a non-empty array; possible_risks must be an array of strings; will_not_change must be an array of strings'
    }
  );

  assert.deepEqual(
    validateWriteIntent({ task_id: "../evil", intended_files: ["README.md"] }, "T-001"),
    {
      ok: false,
      reason:
        'task_id contains invalid task id: task id may contain only letters, numbers, dots, underscores, and hyphens, and must start with a letter or number; task_id "../evil" must match requested task id "T-001"'
    }
  );
});

test("CLI intent prints pass JSON for in-lease intent", async () => {
  await withTempRepo(async ({ repo }) => {
    await requestLease(repo, "T-001", ["README.md"]);
    const intentPath = await writeIntent(repo, "intent-pass.json", {
      task_id: "T-001",
      intended_files: ["README.md"]
    });

    const result = await execFileAsync("node", [cliPath, "intent", "T-001", intentPath], { cwd: repo, windowsHide: true });

    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      task_id: "T-001",
      verdict: "pass",
      intended_files: ["README.md"]
    });
  });
});

test("CLI intent exits non-zero for out-of-lease and invalid JSON inputs", async () => {
  await withTempRepo(async ({ repo }) => {
    await requestLease(repo, "T-001", ["README.md"]);
    const outOfLeasePath = await writeIntent(repo, "intent-reject.json", {
      task_id: "T-001",
      intended_files: ["src/feature.ts"]
    });
    const invalidJsonPath = path.join(repo, "invalid-intent.json");
    await writeFile(invalidJsonPath, "{not json}\n");

    await assert.rejects(
      execFileAsync("node", [cliPath, "intent", "T-001", outOfLeasePath], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /src\/feature\.ts is not leased/);
        return true;
      }
    );

    await assert.rejects(
      execFileAsync("node", [cliPath, "intent", "T-001", invalidJsonPath], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /invalid JSON in intent file/);
        return true;
      }
    );
  });
});

test("CLI intent rejects invalid usage", async () => {
  await withTempRepo(async ({ repo }) => {
    await assert.rejects(
      execFileAsync("node", [cliPath, "intent", "T-001"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /error: usage: hivemind intent <id> <intent\.json>/);
        return true;
      }
    );
  });
});

async function withTempRepo(run: (context: { repo: string; baseCommit: string }) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-intent-test-"));
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
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function writeIntent(repo: string, fileName: string, intent: unknown): Promise<string> {
  const intentPath = path.join(repo, fileName);
  await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
  return intentPath;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
