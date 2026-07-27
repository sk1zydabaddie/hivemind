import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { evaluateClosureCoverage, type ClosureCoverageAdvisory } from "../src/closure-coverage.js";
import { createTaskContract } from "../src/contract.js";
import { initProject } from "../src/init.js";
import { checkWriteIntent } from "../src/intent.js";
import { requestLeaseForContract } from "../src/lease.js";
import { createTentativePlan, lintTentativePlan } from "../src/plan.js";
import { rebuildRepoGraph, repoGraphArtifactPath, type RepoGraphArtifact } from "../src/repo-graph.js";
import { runTask } from "../src/run.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../src/cli.js");
const taskId = "T-CLOSURE";
const specId = "S-001";
const entrySource = [
  'import { visible } from "./visible.js";',
  'import { missing } from "./missing.js";',
  'import { forbidden } from "./forbidden.js";',
  "export const total = visible + missing + forbidden;",
  ""
].join("\n");

test("closure coverage flags dependencies outside combined visible scope and distinguishes forbidden dependencies", async () => {
  await withTempRepo(
    {
      "src/entry.ts": entrySource,
      "src/visible.ts": "export const visible = 1;\n",
      "src/missing.ts": "export const missing = 2;\n",
      "src/forbidden.ts": "export const forbidden = 3;\n"
    },
    async ({ repo, baseCommit }) => {
      await preparePlan(repo, ["src/visible.ts"], ["src/forbidden.ts"]);
      assert.equal((await rebuildRepoGraph(repo)).ok, true);

      const groundOutput = await groundWithCli(repo);
      assert.deepEqual(groundOutput.advisories?.closure_coverage, {
        advisory_only: true,
        entry_point_definition: "concrete grounded allowed_files",
        flags: [
          {
            task_id: taskId,
            dependency_file: "src/forbidden.ts",
            entry_points: ["src/entry.ts"],
            kind: "forbidden_dependency",
            message: "src/forbidden.ts is in the dependency closure of src/entry.ts and is explicitly forbidden"
          },
          {
            task_id: taskId,
            dependency_file: "src/missing.ts",
            entry_points: ["src/entry.ts"],
            kind: "dependency_outside_scope",
            message:
              "src/missing.ts is in the dependency closure of src/entry.ts but outside combined allowed_files + read_only_files scope"
          }
        ]
      });
      assert.equal(
        groundOutput.advisories?.closure_coverage.flags.some((flag) => flag.dependency_file === "src/visible.ts"),
        false
      );

      await lintAndRun(repo, baseCommit, ["src/visible.ts"], ["src/forbidden.ts"]);
    }
  );
});

test("missing stale and invalid graphs degrade to silence and never block execution", async () => {
  await withTempRepo(
    {
      "src/entry.ts": entrySource,
      "src/visible.ts": "export const visible = 1;\n",
      "src/missing.ts": "export const missing = 2;\n",
      "src/forbidden.ts": "export const forbidden = 3;\n"
    },
    async ({ repo, baseCommit }) => {
      await preparePlan(repo);
      const missingGraphOutput = await groundWithCli(repo);
      assert.equal(missingGraphOutput.advisories, undefined);
      assert.equal(await evaluateClosureCoverage(repo, specId), undefined);

      assert.equal((await rebuildRepoGraph(repo)).ok, true);
      await writeFile(path.join(repo, "src", "entry.ts"), `${entrySource}// live source changed after graph build\n`);
      assert.equal(await evaluateClosureCoverage(repo, specId), undefined);

      await writeFile(path.join(repo, "src", "entry.ts"), entrySource);
      assert.equal((await rebuildRepoGraph(repo)).ok, true);
      await writeFile(repoGraphArtifactPath(repo), "{not valid json");
      assert.equal(await evaluateClosureCoverage(repo, specId), undefined);

      await rm(repoGraphArtifactPath(repo), { force: true });
      await lintAndRun(repo, baseCommit);
    }
  );
});

test("a spurious closure flag is harmless and cannot alter lint contract lease or run", async () => {
  await withTempRepo(
    {
      "src/entry.ts": "export const entry = true;\n",
      "src/unrelated.ts": "export const unrelated = true;\n"
    },
    async ({ repo, baseCommit }) => {
      await preparePlan(repo);
      assert.equal((await rebuildRepoGraph(repo)).ok, true);
      const graphPath = repoGraphArtifactPath(repo);
      const graph = JSON.parse(await readFile(graphPath, "utf8")) as RepoGraphArtifact;
      const entry = graph.files.find((file) => file.path === "src/entry.ts");
      assert.notEqual(entry, undefined);
      entry!.dependencies.push({
        specifier: "./unrelated.js",
        kind: "import",
        target: "src/unrelated.ts"
      });
      await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);

      const groundOutput = await groundWithCli(repo);
      assert.deepEqual(groundOutput.advisories?.closure_coverage.flags, [
        {
          task_id: taskId,
          dependency_file: "src/unrelated.ts",
          entry_points: ["src/entry.ts"],
          kind: "dependency_outside_scope",
          message:
            "src/unrelated.ts is in the dependency closure of src/entry.ts but outside combined allowed_files + read_only_files scope"
        }
      ]);

      await lintAndRun(repo, baseCommit);
    }
  );
});

async function withTempRepo(
  files: Record<string, string>,
  run: (input: { repo: string; baseCommit: string }) => Promise<void>
): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-closure-coverage-test-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(repo, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "hivemind@example.invalid"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    assert.equal(await initProject(repo), 0);
    await createRatifiedSpec(repo, specId);
    await run({ repo, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function preparePlan(repo: string, readOnlyFiles: string[] = [], forbiddenFiles: string[] = []): Promise<void> {
  const plan = await createTentativePlan(repo, specId, {
    tasks: [
      {
        task_id: taskId,
        title: "Update the entry module",
        task_type: "deterministic",
        mode: "write",
        agent_role: "builder",
        draft_scope: {
          allowed_files: ["src/entry.ts"],
          allowed_file_intents: { "src/entry.ts": "modify" },
          read_only_files: readOnlyFiles,
          forbidden_files: forbiddenFiles,
          must_not_change: []
        },
        depends_on: [],
        parallel_safe: true,
        acceptance_criterion: "The entry module contains the scoped fixture change.",
        required_tests: ['node -e "process.exit(0)"'],
        patch_requirements: ["Only modify src/entry.ts."],
        critical_path_approved: false
      }
    ],
    execution_groups: [{ group_id: "G-1", mode: "sequence", task_ids: [taskId] }]
  });
  assert.equal(plan.ok, true);
}

async function groundWithCli(repo: string): Promise<{
  grounding_status: string;
  advisories?: { closure_coverage: ClosureCoverageAdvisory };
}> {
  const result = await execFileAsync(process.execPath, [cliPath, "plan", specId, "--ground"], {
    cwd: repo,
    windowsHide: true
  });
  const parsed = JSON.parse(result.stdout) as {
    grounding_status: string;
    advisories?: { closure_coverage: ClosureCoverageAdvisory };
  };
  assert.equal(parsed.grounding_status, "grounded");
  return parsed;
}

async function lintAndRun(
  repo: string,
  baseCommit: string,
  readOnlyFiles: string[] = [],
  forbiddenFiles: string[] = []
): Promise<void> {
  const linted = await lintTentativePlan(repo, specId);
  assert.equal(linted.ok, true);

  const contract = await createTaskContract(repo, {
    task_id: taskId,
    title: "Update the entry module",
    agent_role: "builder",
    base_commit: baseCommit,
    acceptance_criterion: "The entry module contains the scoped fixture change.",
    allowed_files: ["src/entry.ts"],
    allowed_file_intents: { "src/entry.ts": "modify" },
    read_only_files: readOnlyFiles,
    forbidden_files: forbiddenFiles,
    allowed_symbols: [],
    forbidden_symbols: [],
    must_not_change: [],
    required_tests: ['node -e "process.exit(0)"'],
    patch_requirements: ["Only modify src/entry.ts."]
  });
  assert.equal(contract.ok, true);

  const lease = await requestLeaseForContract(repo, taskId);
  assert.equal(lease.ok, true);
  const intent = await checkWriteIntent(repo, taskId, {
    task_id: taskId,
    intended_files: ["src/entry.ts"],
    intended_symbols: [],
    possible_risks: [],
    will_not_change: []
  });
  assert.equal(intent.ok, true);

  const agentPath = path.join(repo, "closure-worker.mjs");
  await writeFile(
    agentPath,
    [
      'import { appendFile } from "node:fs/promises";',
      'await appendFile("src/entry.ts", "\\nexport const closureFixtureChanged = true;\\n");',
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(repo, ".hivemind", "adapters", "closure-worker.profile.json"),
    `${JSON.stringify(
      {
        tool: "closure-worker",
        invoke: ["node", agentPath],
        prompt_arg: "stdin",
        verified_on: "2026-07-27",
        context_window: 4096,
        routing_tier: "strong",
        cost_rank: 1
      },
      null,
      2
    )}\n`
  );
  const runResult = await runTask(repo, taskId, "closure-worker");
  assert.equal(runResult.ok, true, runResult.ok ? undefined : runResult.reason);
  if (runResult.ok) {
    assert.equal(runResult.value.tool_exit, 0);
    assert.equal(runResult.value.changed_files, 1);
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
