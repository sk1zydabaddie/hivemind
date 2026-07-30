import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { VerificationCoverageConfig } from "../src/config.js";
import {
  measureRuntimeCoverage,
  type CoverageCommandResult
} from "../src/runtime-coverage.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

test("configured LCOV reports exact hit ratio in post-patch coordinates at file boundaries", async () => {
  await withCoverageRepo(async (repo) => {
    await stageEdgeChange(repo, [
      "export const first = 1;",
      "export const middle = 1;",
      "export const last = 3;"
    ].join("\n"));

    const measurement = await measure(repo, ["src/edge.js"], "edge");

    assert.equal(measurement.status, "weak");
    assert.equal(measurement.coordinate_space, "post_patch_applied_tree");
    assert.match(measurement.applied_tree ?? "", /^[0-9a-f]{40,64}$/u);
    assert.equal(measurement.executable_changed_lines, 2);
    assert.equal(measurement.hit_changed_lines, 1);
    assert.equal(measurement.ratio, 0.5);
    assert.deepEqual(measurement.covered_lines, [{ file: "src/edge.js", line: 1, hits: 1 }]);
    assert.deepEqual(measurement.uncovered_lines, [{ file: "src/edge.js", line: 3, hits: 0 }]);
    assert.deepEqual(measurement.ignored_non_executable_lines, []);
    assert.equal(measurement.report_hash?.length, 64);
  });
});

test("LCOV DA records define executability and ignore changed comment-only lines", async () => {
  await withCoverageRepo(async (repo) => {
    await stageEdgeChange(repo, [
      "// changed documentation",
      "export const first = 1;",
      "export const middle = 1;",
      "export const last = 2;"
    ].join("\n"));

    const measurement = await measure(repo, ["src/edge.js"], "comment");

    assert.equal(measurement.status, "strong");
    assert.equal(measurement.executable_changed_lines, 1);
    assert.equal(measurement.hit_changed_lines, 1);
    assert.equal(measurement.ratio, 1);
    assert.deepEqual(measurement.covered_lines, [{ file: "src/edge.js", line: 2, hits: 1 }]);
    assert.deepEqual(measurement.ignored_non_executable_lines, [
      { file: "src/edge.js", line: 1, reason: "not_listed_as_executable_by_lcov" },
      { file: "src/edge.js", line: 4, reason: "not_listed_as_executable_by_lcov" }
    ]);
  });
});

test("a report produced for an earlier tree is deleted and cannot be reused as current evidence", async () => {
  await withCoverageRepo(async (repo) => {
    await stageEdgeChange(repo, [
      "export const first = 1;",
      "export const middle = 1;",
      "export const last = 2;"
    ].join("\n"));
    const current = await measure(repo, ["src/edge.js"], "strong");
    assert.equal(current.status, "strong");
    assert.equal(await readFile(path.join(repo, "coverage", "lcov.info"), "utf8") !== "", true);

    await stageEdgeChange(repo, [
      "export const first = 2;",
      "export const middle = 1;",
      "export const last = 4;"
    ].join("\n"));
    const stale = await measure(repo, ["src/edge.js"], "missing");

    assert.equal(stale.status, "unknown");
    assert.match(stale.unknown_reasons[0], /did not produce fresh report/);
    await assert.rejects(readFile(path.join(repo, "coverage", "lcov.info"), "utf8"), { code: "ENOENT" });
  });
});

test("configured missing, malformed, unmappable, and tree-divergent coverage are unknown", async () => {
  await withCoverageRepo(async (repo) => {
    await stageEdgeChange(repo, [
      "export const first = 1;",
      "export const middle = 1;",
      "export const last = 3;"
    ].join("\n"));

    const missing = await measure(repo, ["src/edge.js"], "missing");
    assert.equal(missing.status, "unknown");
    assert.match(missing.unknown_reasons[0], /did not produce fresh report/);

    const malformed = await measure(repo, ["src/edge.js"], "malformed");
    assert.equal(malformed.status, "unknown");
    assert.match(malformed.unknown_reasons[0], /malformed LCOV/);

    const unmappable = await measure(repo, ["src/edge.js"], "unmappable");
    assert.equal(unmappable.status, "unknown");
    assert.match(unmappable.unknown_reasons[0], /outside the applied worktree/);

    const divergent = await measure(repo, ["src/edge.js"], "mutate");
    assert.equal(divergent.status, "unknown");
    assert.match(divergent.unknown_reasons[0], /worktree content diverges|changed the applied tree/);
  });
});

test("a changed file excluded from instrumentation is unknown rather than covered", async () => {
  await withCoverageRepo(async (repo) => {
    await writeFile(path.join(repo, "src", "excluded.js"), "export const excluded = 0;\n");
    await git(repo, ["add", "src/excluded.js"]);
    await git(repo, ["commit", "-m", "add excluded source"]);
    await writeFile(path.join(repo, "src", "excluded.js"), "export const excluded = 1;\n");
    await git(repo, ["add", "src/excluded.js"]);

    const measurement = await measure(repo, ["src/excluded.js"], "strong");

    assert.equal(measurement.status, "unknown");
    assert.deepEqual(measurement.unknown_files, ["src/excluded.js"]);
    assert.match(measurement.unknown_reasons[0], /does not instrument changed files/);
  });
});

test("a non-JS/TS changed file is unknown even when coverage is configured", async () => {
  await withCoverageRepo(async (repo) => {
    await writeFile(path.join(repo, "README.md"), "# Before\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "add documentation"]);
    await writeFile(path.join(repo, "README.md"), "# After\n");
    await git(repo, ["add", "README.md"]);

    const measurement = await measure(repo, ["README.md"], "strong");

    assert.equal(measurement.status, "unknown");
    assert.deepEqual(measurement.unknown_files, ["README.md"]);
    assert.match(measurement.unknown_reasons[0], /outside configured JS\/TS coverage instrumentation/);
  });
});

test("unconfigured coverage is distinct and never invokes a command", async () => {
  let invocations = 0;
  const measurement = await measureRuntimeCoverage(
    "not-a-repository",
    ["src/edge.js"],
    undefined,
    async () => {
      invocations += 1;
      return { id: "coverage", command: "", exit_code: 0, stdout: "", stderr: "" };
    }
  );

  assert.equal(measurement.status, "unconfigured");
  assert.equal(measurement.configured, false);
  assert.equal(measurement.unknown_reasons.length, 0);
  assert.equal(invocations, 0);
});

async function withCoverageRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-runtime-coverage-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(
      path.join(repo, "src", "edge.js"),
      [
        "export const first = 0;",
        "export const middle = 1;",
        "export const last = 2;",
        ""
      ].join("\n")
    );
    await writeFile(path.join(repo, "coverage-writer.mjs"), coverageWriterSource());
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "coverage fixture"]);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function stageEdgeChange(repo: string, content: string): Promise<void> {
  await writeFile(path.join(repo, "src", "edge.js"), content);
  await git(repo, ["add", "src/edge.js"]);
}

async function measure(repo: string, changedFiles: string[], mode: string) {
  const coverage: VerificationCoverageConfig = {
    command: `node coverage-writer.mjs ${mode}`,
    report_path: "coverage/lcov.info",
    format: "lcov"
  };
  return measureRuntimeCoverage(
    repo,
    changedFiles,
    coverage,
    (command) => runCoverageCommand(repo, command)
  );
}

async function runCoverageCommand(cwd: string, command: string): Promise<CoverageCommandResult> {
  try {
    const result = await execAsync(command, { cwd, windowsHide: true });
    return {
      id: "coverage",
      command,
      exit_code: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error: unknown) {
    return {
      id: "coverage",
      command,
      exit_code: typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : 1,
      stdout: typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "",
      stderr: typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : ""
    };
  }
}

function coverageWriterSource(): string {
  return [
    "import { appendFile, mkdir, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    "const mode = process.argv[2];",
    "const reportPath = path.resolve('coverage/lcov.info');",
    "const sourcePath = path.resolve('src/edge.js').replaceAll('\\\\', '/');",
    "if (mode === 'missing') process.exit(0);",
    "await mkdir(path.dirname(reportPath), { recursive: true });",
    "if (mode === 'malformed') { await writeFile(reportPath, `SF:${sourcePath}\\nDA:not-a-line\\nend_of_record\\n`); process.exit(0); }",
    "if (mode === 'unmappable') { await writeFile(reportPath, 'SF:../outside.js\\nDA:1,1\\nend_of_record\\n'); process.exit(0); }",
    "const records = mode === 'edge'",
    "  ? ['DA:1,1', 'DA:2,1', 'DA:3,0']",
    "  : mode === 'comment'",
    "    ? ['DA:2,1', 'DA:3,1']",
    "    : ['DA:1,1', 'DA:2,1', 'DA:3,1'];",
    "await writeFile(reportPath, [`SF:${sourcePath}`, ...records, 'end_of_record', ''].join('\\n'));",
    "if (mode === 'mutate') await appendFile('src/edge.js', '\\nexport const mutatedByCoverage = true;\\n');",
    ""
  ].join("\n");
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}
