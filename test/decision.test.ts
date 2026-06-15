import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { TaskContract } from "../src/contract.js";
import { decideOp, type DecisionConfig, type DecisionVerdict } from "../src/decision.js";

test("decideOp implements the M1.3 operation table", async () => {
  await withRepo(async (repo) => {
    const cases: Array<{
      name: string;
      filePath: string;
      op: string;
      expected: DecisionVerdict;
      contract?: Partial<TaskContract>;
      config?: Partial<DecisionConfig>;
      createPath?: boolean;
    }> = [
      {
        name: "modify in allowed set passes",
        filePath: "src/allowed.ts",
        op: "modify",
        expected: "pass"
      },
      {
        name: "add outside allowed set rejects",
        filePath: "src/outside-add.ts",
        op: "add",
        expected: "reject",
        contract: { allowed_files: ["src/allowed.ts"] }
      },
      {
        name: "delete outside allowed set rejects",
        filePath: "src/outside-delete.ts",
        op: "delete",
        expected: "reject",
        contract: { allowed_files: ["src/allowed.ts"] }
      },
      {
        name: "delete forbidden path rejects",
        filePath: "src/forbidden.ts",
        op: "delete",
        expected: "reject",
        contract: {
          allowed_files: ["src/forbidden.ts"],
          forbidden_files: ["src/forbidden.ts"]
        }
      },
      {
        name: "delete critical path rejects",
        filePath: "src/schema.ts",
        op: "delete",
        expected: "reject",
        contract: { allowed_files: ["src/schema.ts"] },
        config: { critical_globs: ["src/schema.ts"] }
      },
      {
        name: "symlink op rejects",
        filePath: "src/link-target.ts",
        op: "symlink",
        expected: "reject",
        contract: { allowed_files: ["src/link-target.ts"] }
      },
      {
        name: "chmod op escalates",
        filePath: "src/script.sh",
        op: "chmod",
        expected: "escalate",
        contract: { allowed_files: ["src/script.sh"] }
      },
      {
        name: "submodule op escalates",
        filePath: "vendor/module",
        op: "submodule",
        expected: "escalate",
        contract: { allowed_files: ["vendor/module"] }
      },
      {
        name: "gitattributes op escalates",
        filePath: ".gitattributes",
        op: "gitattr",
        expected: "escalate",
        contract: { allowed_files: [".gitattributes"] }
      },
      {
        name: "gitignore change escalates",
        filePath: ".gitignore",
        op: "modify",
        expected: "escalate",
        contract: { allowed_files: [".gitignore"] }
      },
      {
        name: "gitmodules change escalates",
        filePath: ".gitmodules",
        op: "modify",
        expected: "escalate",
        contract: { allowed_files: [".gitmodules"] }
      },
      {
        name: "dependency manifest escalates",
        filePath: "package.json",
        op: "modify",
        expected: "escalate",
        contract: { allowed_files: ["package.json"] }
      },
      {
        name: "lockfile escalates",
        filePath: "pnpm-lock.yaml",
        op: "modify",
        expected: "escalate",
        contract: { allowed_files: ["pnpm-lock.yaml"] }
      },
      {
        name: "unknown op rejects",
        filePath: "src/allowed.ts",
        op: "mystery",
        expected: "reject"
      },
      {
        name: "unknown path rejects",
        filePath: "src/missing.ts",
        op: "modify",
        expected: "reject",
        contract: { allowed_files: ["src/missing.ts"] },
        createPath: false
      }
    ];

    for (const testCase of cases) {
      if (testCase.createPath !== false) {
        await createFixturePath(repo, testCase.filePath);
      }

      assert.equal(
        await decideOp(
          { path: testCase.filePath, op: testCase.op },
          contractFor(testCase.contract),
          configFor(repo, testCase.config)
        ),
        testCase.expected,
        testCase.name
      );
    }
  });
});

test("decideOp matches canonical paths against contract and config globs", async () => {
  await withRepo(async (repo) => {
    await createFixturePath(repo, "src/nested/feature.ts");
    await createFixturePath(repo, "config/service.json");

    assert.equal(
      await decideOp(
        { path: "src/nested/../nested/feature.ts", op: "modify" },
        contractFor({ allowed_files: [] }),
        configFor(repo, { allowed_globs: ["src/**/*.ts"] })
      ),
      "pass"
    );
    assert.equal(
      await decideOp(
        { path: "config/service.json", op: "delete" },
        contractFor({ allowed_files: ["config/service.json"] }),
        configFor(repo, { forbidden_globs: ["config/**"] })
      ),
      "reject"
    );
  });
});

function contractFor(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    task_id: "T-001",
    title: "Decision table fixture",
    agent_role: "builder",
    base_commit: "abc123",
    allowed_files: ["src/allowed.ts"],
    read_only_files: [],
    forbidden_files: [],
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: [],
    patch_requirements: [],
    ...overrides
  };
}

function configFor(repo: string, overrides: Partial<DecisionConfig> = {}): DecisionConfig {
  return {
    version: 1,
    stack: "typescript-node",
    repo_root: repo,
    test_command: "",
    allowed_globs: [],
    forbidden_globs: [],
    ...overrides
  };
}

async function createFixturePath(repo: string, repoPath: string): Promise<void> {
  const fullPath = path.join(repo, repoPath);
  if (repoPath.endsWith("/module")) {
    await mkdir(fullPath, { recursive: true });
    return;
  }

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${repoPath}\n`);
}

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "hivemind-decision-test-"));
  const repo = path.join(tempRoot, "repo");
  await mkdir(repo);
  try {
    await run(await realpath(repo));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
