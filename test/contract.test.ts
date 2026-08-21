import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { loadContract, normalizeContract, validateContract } from "../src/contract.js";
import { CONTRACT_FORMAT_VERSION } from "../src/contract-version.js";
import { initProject } from "../src/init.js";
import { withTemplateRepo } from "./support/fixture-repo.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");

test("valid sample contract validates and normalizes", () => {
  const raw = {
    task_id: "T-001",
    title: "Validate contracts",
    agent_role: "scout",
    routing_task_type: "orchestration",
    base_commit: "abc123",
    acceptance_criterion: "Contract validation fixture passes typecheck.",
    allowed_files: ["src/contract.ts"],
    allowed_file_intents: { "src/contract.ts": "modify" },
    read_only_files: ["src/cli.ts"],
    forbidden_files: ["package.json"],
    allowed_symbols: ["TaskContract"],
    forbidden_symbols: ["saveGameSchema"],
    must_not_change: ["save schema"],
    required_tests: ["npm run typecheck"],
    patch_requirements: ["include tests run"]
  };

  assert.deepEqual(validateContract(raw), []);
  // Normalization now stamps the format the record is in. Everything else is
  // unchanged, which is the point: the version describes the record, not the
  // task.
  assert.deepEqual(normalizeContract(raw), { contract_version: CONTRACT_FORMAT_VERSION, ...raw });
});

test("read-only reviewer contracts require readable scope and no write intent", () => {
  const readOnly = {
    task_id: "T-REVIEW",
    title: "Review the result",
    agent_role: "reviewer",
    routing_task_type: "testing",
    base_commit: "abc123",
    acceptance_criterion: "The reviewer reports each acceptance criterion.",
    allowed_files: [],
    allowed_file_intents: {},
    read_only_files: ["README.md"],
    forbidden_files: ["README.md"],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: ["README.md"],
    required_tests: ["Named review check: inspect README.md"],
    patch_requirements: ["Produce no file changes"]
  };
  assert.deepEqual(validateContract(readOnly), []);
  assert.match(validateContract({ ...readOnly, agent_role: "builder" }).join("; "), /allowed_files must be a non-empty array/u);
  assert.match(validateContract({ ...readOnly, read_only_files: [] }).join("; "), /allowed_files must be a non-empty array/u);
  assert.match(validateContract({ ...readOnly, allowed_file_intents: { "README.md": "modify" } }).join("; "), /allowed_files must be a non-empty array/u);
});

test("contract validation requires exactly one acceptance criterion backed by a test", () => {
  const base = {
    task_id: "T-001",
    routing_task_type: "other",
    base_commit: "abc123",
    allowed_files: ["README.md"],
    required_tests: ["npm run typecheck"]
  };

  assert.deepEqual(validateContract(base), ["acceptance_criterion is required"]);
  assert.deepEqual(validateContract({ ...base, acceptance_criteria: ["one", "two"] }), [
    "acceptance_criterion is required",
    "unsupported contract field: acceptance_criteria"
  ]);
  assert.deepEqual(validateContract({ ...base, acceptance_criterion: "One binary check passes.", required_tests: [] }), [
    "required_tests must include at least one non-empty command backing acceptance_criterion"
  ]);
});

test("observable-interface contracts require an independent deterministic validity check", () => {
  const base = {
    task_id: "T-CLI",
    routing_task_type: "cli",
    base_commit: "abc123",
    acceptance_criterion: "The CLI accepts --input <path> and optional --json output.",
    allowed_files: ["src/cli.ts"],
    required_tests: ["npm test"]
  };

  assert.match(validateContract(base).join("; "), /observable interface requires deterministic_validity_check/);
  assert.match(
    validateContract({ ...base, deterministic_validity_check: "npm test" }).join("; "),
    /must be independent of required_tests/
  );
  assert.deepEqual(validateContract({ ...base, deterministic_validity_check: "node verify-cli-interface.mjs" }), []);
});

test("missing allowed_files reports the exact problem", () => {
  const problems = validateContract({
    task_id: "T-001",
    routing_task_type: "other",
    base_commit: "abc123",
    acceptance_criterion: "One file is validated.",
    required_tests: ["npm run typecheck"]
  });

  assert.deepEqual(problems, ["allowed_files must be a non-empty array"]);
});

test("contract requires a supported routing task type distinct from agent role", () => {
  const base = {
    task_id: "T-001",
    base_commit: "abc123",
    acceptance_criterion: "Routing task type is validated.",
    allowed_files: ["README.md"],
    required_tests: ["npm run typecheck"]
  };
  assert.match(validateContract(base).join("; "), /routing_task_type must be one of/);
  assert.match(
    validateContract({ ...base, routing_task_type: "small_cli_command" }).join("; "),
    /routing_task_type must be one of/
  );
  assert.deepEqual(validateContract({ ...base, routing_task_type: "cli" }), []);
});

test("path in both allowed and forbidden reports the exact problem", () => {
  const problems = validateContract({
    task_id: "T-001",
    routing_task_type: "other",
    base_commit: "abc123",
    acceptance_criterion: "Path conflict is detected.",
    allowed_files: ["src/contract.ts"],
    forbidden_files: ["src/contract.ts"],
    required_tests: ["npm run typecheck"]
  });

  assert.deepEqual(problems, ['path "src/contract.ts" may not appear in both allowed_files and forbidden_files']);
});

test("invalid path entries report all relevant problems", () => {
  const problems = validateContract({
    task_id: "",
    routing_task_type: "other",
    base_commit: "",
    acceptance_criterion: "Invalid path entries are reported.",
    allowed_files: ["", "../escape.ts", "src/.git/config", path.resolve("absolute.ts")],
    read_only_files: ["src\\..\\escape.ts"],
    forbidden_files: [1],
    agent_role: "planner",
    required_tests: ["npm run typecheck"]
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
        routing_task_type: "other",
        base_commit: "abc123",
        acceptance_criterion: "Task id mismatch is detected.",
        allowed_files: ["README.md"],
        required_tests: ["npm run typecheck"]
      },
      "T-001"
    ),
    ['task_id "T-OTHER" must match requested task id "T-001"']
  );

  assert.deepEqual(validateContract({ task_id: "../evil", routing_task_type: "other", base_commit: "abc123", acceptance_criterion: "Unsafe id is detected.", allowed_files: ["README.md"], required_tests: ["npm run typecheck"] }), [
    "task_id contains invalid task id: task id may contain only letters, numbers, dots, underscores, and hyphens, and must start with a letter or number"
  ]);
});

test("CLI contract validate prints normalized JSON", async () => {
  await withTempRepo(async (repo) => {
    await initProject(repo);
    await writeContract(repo, "T-001", {
      task_id: "T-001",
      routing_task_type: "orchestration",
      base_commit: "abc123",
      acceptance_criterion: "CLI normalize prints one contract.",
      allowed_files: ["src/contract.ts"],
      required_tests: ["npm run typecheck"]
    });

    const result = await execFileAsync("node", [cliPath, "contract", "T-001", "--validate"], {
      cwd: repo,
      windowsHide: true
    });

    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      // Normalized output now states the format the record is in.
      contract_version: CONTRACT_FORMAT_VERSION,
      task_id: "T-001",
      title: "",
      agent_role: "builder",
      routing_task_type: "orchestration",
      base_commit: "abc123",
      acceptance_criterion: "CLI normalize prints one contract.",
      allowed_files: ["src/contract.ts"],
      read_only_files: [],
      forbidden_files: [],
      allowed_file_intents: { "src/contract.ts": "modify" },
      allowed_symbols: [],
      forbidden_symbols: [],
      must_not_change: [],
      required_tests: ["npm run typecheck"],
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
        routing_task_type: "other",
        base_commit: "abc123",
        acceptance_criterion: "BOM contract loads.",
        allowed_files: ["README.md"],
        required_tests: ["npm run typecheck"]
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
      routing_task_type: "other",
      base_commit: "abc123",
      acceptance_criterion: "Unsafe requested id is rejected.",
      allowed_files: ["README.md"],
      required_tests: ["npm run typecheck"]
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
      routing_task_type: "other",
      base_commit: "abc123",
      acceptance_criterion: "Invalid contract reports all problems.",
      allowed_files: ["src/contract.ts"],
      forbidden_files: ["src/contract.ts"],
      read_only_files: ["../escape.ts"],
      required_tests: ["npm run typecheck"]
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
  await withTemplateRepo(
    "contract",
    async (repo) => {
      await git(repo, ["init"]);
    },
    async (repo) => {
      await run(repo);
    },
    "hivemind-contract-test-"
  );
}

async function writeContract(repo: string, taskId: string, contract: unknown, bom = false): Promise<void> {
  const tasksDir = path.join(repo, ".hivemind", "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(path.join(tasksDir, `${taskId}.contract.json`), `${bom ? "\uFEFF" : ""}${JSON.stringify(contract, null, 2)}\n`);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}
