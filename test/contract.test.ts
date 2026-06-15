import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadContract, normalizeContract, validateContract } from "../src/contract.js";
import { initProject } from "../src/init.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("valid sample contract validates and normalizes", () => {
  const raw = {
    task_id: "T-001",
    title: "Validate contracts",
    agent_role: "scout",
    base_commit: "abc123",
    allowed_files: ["src/contract.ts"],
    read_only_files: ["src/cli.ts"],
    forbidden_files: ["package.json"],
    allowed_symbols: ["TaskContract"],
    forbidden_symbols: ["saveGameSchema"],
    must_not_change: ["save schema"],
    required_tests: ["npm run typecheck"],
    patch_requirements: ["include tests run"]
  };

  assert.deepEqual(validateContract(raw), []);
  assert.deepEqual(normalizeContract(raw), raw);
});

test("missing allowed_files reports the exact problem", () => {
  const problems = validateContract({
    task_id: "T-001",
    base_commit: "abc123"
  });

  assert.deepEqual(problems, ["allowed_files must be a non-empty array"]);
});

test("path in both allowed and forbidden reports the exact problem", () => {
  const problems = validateContract({
    task_id: "T-001",
    base_commit: "abc123",
    allowed_files: ["src/contract.ts"],
    forbidden_files: ["src/contract.ts"]
  });

  assert.deepEqual(problems, ['path "src/contract.ts" may not appear in both allowed_files and forbidden_files']);
});

test("invalid path entries report all relevant problems", () => {
  const problems = validateContract({
    task_id: "",
    base_commit: "",
    allowed_files: ["", "../escape.ts", "src/.git/config", path.resolve("absolute.ts")],
    read_only_files: ["src\\..\\escape.ts"],
    forbidden_files: [1],
    agent_role: "planner"
  });

  assert.deepEqual(problems, [
    "task_id is required",
    "base_commit is required",
    "forbidden_files must be an array of strings",
    'allowed_files contains invalid path "": entry must not be empty',
    'allowed_files contains invalid path "../escape.ts": .. traversal is not allowed',
    'allowed_files contains invalid path "src/.git/config": .git paths are not allowed',
    `allowed_files contains invalid path "${path.resolve("absolute.ts")}": absolute paths are not allowed`,
    'read_only_files contains invalid path "src\\..\\escape.ts": .. traversal is not allowed',
    "agent_role must be one of coordinator, scout, builder, reviewer"
  ]);
});

test("contract validation rejects unsafe and mismatched task ids", () => {
  assert.deepEqual(
    validateContract(
      {
        task_id: "T-OTHER",
        base_commit: "abc123",
        allowed_files: ["README.md"]
      },
      "T-001"
    ),
    ['task_id "T-OTHER" must match requested task id "T-001"']
  );

  assert.deepEqual(validateContract({ task_id: "../evil", base_commit: "abc123", allowed_files: ["README.md"] }), [
    "task_id contains invalid task id: task id may contain only letters, numbers, dots, underscores, and hyphens, and must start with a letter or number"
  ]);
});

test("CLI contract validate prints normalized JSON", async () => {
  await withTempRepo(async (repo) => {
    await initProject(repo);
    await writeContract(repo, "T-001", {
      task_id: "T-001",
      base_commit: "abc123",
      allowed_files: ["src/contract.ts"]
    });

    const result = await execFileAsync("node", [cliPath, "contract", "T-001", "--validate"], {
      cwd: repo,
      windowsHide: true
    });

    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      task_id: "T-001",
      title: "",
      agent_role: "builder",
      base_commit: "abc123",
      allowed_files: ["src/contract.ts"],
      read_only_files: [],
      forbidden_files: [],
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: [],
      patch_requirements: []
    });
  });
});

test("loadContract accepts UTF-8 BOM prefixed JSON", async () => {
  await withTempRepo(async (repo) => {
    await initProject(repo);
    await writeContract(
      repo,
      "T-001",
      {
        task_id: "T-001",
        base_commit: "abc123",
        allowed_files: ["README.md"]
      },
      true
    );

    const result = await loadContract(repo, "T-001");

    assert.equal(result.ok, true);
  });
});

test("CLI contract validate rejects path-traversal task ids", async () => {
  await withTempRepo(async (repo) => {
    await initProject(repo);
    await writeContract(repo, "evil", {
      task_id: "evil",
      base_commit: "abc123",
      allowed_files: ["README.md"]
    });

    await assert.rejects(
      execFileAsync("node", [cliPath, "contract", "../evil", "--validate"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.match(String((error as { stderr?: string }).stderr), /invalid task id "\.\.\/evil"/);
        return true;
      }
    );
  });
});

test("CLI contract validate exits non-zero and lists all validation problems", async () => {
  await withTempRepo(async (repo) => {
    await initProject(repo);
    await writeContract(repo, "T-001", {
      task_id: "T-001",
      base_commit: "abc123",
      allowed_files: ["src/contract.ts"],
      forbidden_files: ["src/contract.ts"],
      read_only_files: ["../escape.ts"]
    });

    await assert.rejects(
      execFileAsync("node", [cliPath, "contract", "T-001", "--validate"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        const stderr = String((error as { stderr?: string }).stderr);
        assert.match(stderr, /read_only_files contains invalid path "\.\.\/escape\.ts": \.\. traversal is not allowed/);
        assert.match(stderr, /path "src\/contract\.ts" may not appear in both allowed_files and forbidden_files/);
        return true;
      }
    );
  });
});

test("CLI contract validate reports missing contract files", async () => {
  await withTempRepo(async (repo) => {
    await initProject(repo);

    await assert.rejects(
      execFileAsync("node", [cliPath, "contract", "T-404", "--validate"], { cwd: repo, windowsHide: true }),
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, 1);
        assert.equal(
          (error as { stderr?: string }).stderr?.trim(),
          "error: contract not found: .hivemind/tasks/T-404.contract.json"
        );
        return true;
      }
    );
  });
});

async function withTempRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-contract-test-"));
  try {
    await git(repo, ["init"]);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function writeContract(repo: string, taskId: string, contract: unknown, bom = false): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(path.join(tasksDir, `${taskId}.contract.json`), `${bom ? "\uFEFF" : ""}${JSON.stringify(contract, null, 2)}\n`);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}
