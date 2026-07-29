import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  queryDependencyClosure,
  rebuildRepoGraph,
  repoGraphArtifactPath,
  type RepoGraphArtifact
} from "../src/repo-graph.js";
import { initProject } from "../src/init.js";
import { releaseLease, requestLease } from "../src/lease.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..", "..");
const cliPath = path.resolve(testDir, "../src/cli.js");

test("repo graph returns defined symbols and the correct local dependency closure", async () => {
  await withGraphRepo(async (repo) => {
    const rebuilt = await rebuildRepoGraph(repo);
    assert.equal(rebuilt.ok, true);
    if (!rebuilt.ok) {
      return;
    }

    const artifact = JSON.parse(await readFile(repoGraphArtifactPath(repo), "utf8")) as RepoGraphArtifact;
    const math = artifact.files.find((file) => file.path === "src/math.ts");
    const service = artifact.files.find((file) => file.path === "src/service.ts");
    assert.deepEqual(
      math?.symbols.map((symbol) => [symbol.kind, symbol.name]),
      [
        ["variable", "factor"],
        ["function", "double"],
        ["class", "Calculator"],
        ["method", "calculate"]
      ]
    );
    assert.deepEqual(service?.dependencies, [
      { specifier: "./math.js", kind: "import", target: "src/math.ts" },
      { specifier: "./types.js", kind: "reexport", target: "src/types.ts" }
    ]);

    const closure = await queryDependencyClosure(repo, "src/index.ts");
    assert.deepEqual(closure.available ? closure.closure : closure, ["src/math.ts", "src/service.ts", "src/types.ts"]);
  });
});

test("repo graph rebuild is byte-for-byte deterministic and CLI closure uses the same artifact", async () => {
  await withGraphRepo(async (repo) => {
    const first = await execFileAsync(process.execPath, [cliPath, "graph", "rebuild"], {
      cwd: repo,
      windowsHide: true
    });
    const firstResult = JSON.parse(first.stdout) as { path: string; files: number };
    assert.equal(firstResult.path, ".hivemind/cache/repo-graph.json");
    assert.equal(firstResult.files, 5);
    const firstBytes = await readFile(repoGraphArtifactPath(repo), "utf8");

    await execFileAsync(process.execPath, [cliPath, "graph", "rebuild"], {
      cwd: repo,
      windowsHide: true
    });
    const secondBytes = await readFile(repoGraphArtifactPath(repo), "utf8");
    assert.equal(secondBytes, firstBytes);

    const cli = await execFileAsync(process.execPath, [cliPath, "graph", "closure", "src/index.ts"], {
      cwd: repo,
      windowsHide: true
    });
    const result = JSON.parse(cli.stdout) as { available: boolean; closure: string[] };
    assert.equal(result.available, true);
    assert.deepEqual(result.closure, ["src/math.ts", "src/service.ts", "src/types.ts"]);
  });
});

test("missing or stale repo graph degrades to unavailable without affecting lease correctness", async () => {
  await withGraphRepo(async (repo) => {
    const missing = await queryDependencyClosure(repo, "src/index.ts");
    assert.equal(missing.available, false);
    if (missing.available) {
      return;
    }
    assert.match(missing.reason, /repo graph is missing/);

    const leaseWithoutGraph = await requestLease(repo, "T-MISSING", ["README.md"]);
    assert.equal(leaseWithoutGraph.ok, true);
    assert.equal((await releaseLease(repo, "T-MISSING")).ok, true);

    assert.equal((await rebuildRepoGraph(repo)).ok, true);
    await writeFile(path.join(repo, "src", "math.ts"), "export const changed = true;\n");

    const stale = await queryDependencyClosure(repo, "src/index.ts");
    assert.equal(stale.available, false);
    if (stale.available) {
      return;
    }
    assert.match(stale.reason, /repo graph is stale/);

    const leaseWithStaleGraph = await requestLease(repo, "T-STALE", ["README.md"]);
    assert.equal(leaseWithStaleGraph.ok, true);
  });
});

test("graph access is structurally isolated to verification selection and its integration caller", async () => {
  const sourceDir = path.join(projectRoot, "src");
  const moduleNames = [
    "analyze.ts",
    "canonicalize.ts",
    "changeset.ts",
    "checkpoint.ts",
    "contract.ts",
    "decision.ts",
    "gate.ts",
    "integration-state.ts",
    "intent.ts",
    "lease-lock.ts",
    "lease.ts",
    "plan.ts",
    "resource-ledger.ts",
    "routing.ts",
    "run.ts",
    "submit.ts",
    "worktree.ts"
  ];
  const allModules = (await readdir(sourceDir))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `src/${name}`)
    .sort()
    .join("\n");
  const dependencyMap = new Map<string, string[]>();
  for (const repoPath of allModules.split(/\r?\n/u).filter(Boolean)) {
    const source = await readFile(path.join(projectRoot, ...repoPath.split("/")), "utf8");
    dependencyMap.set(repoPath, relativeSourceImports(repoPath, source));
  }

  for (const moduleName of moduleNames) {
    assert.equal(
      dependencyMap.get(`src/${moduleName}`)?.includes("src/repo-graph.ts"),
      false,
      `src/${moduleName} must not import advisory repo-graph.ts`
    );
    assert.equal(
      dependencyMap.get(`src/${moduleName}`)?.includes("src/verification.ts"),
      false,
      `src/${moduleName} must not invoke graph-aware verification selection`
    );
  }
  const graphImporters = [...dependencyMap]
    .filter(([, imports]) => imports.includes("src/repo-graph.ts"))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(graphImporters, ["src/cli.ts", "src/closure-coverage.ts", "src/verification.ts"]);
  const verificationImporters = [...dependencyMap]
    .filter(([, imports]) => imports.includes("src/verification.ts"))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(verificationImporters, ["src/integrate.ts"]);
});

async function withGraphRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-repo-graph-test-"));
  try {
    await git(repo, ["init"]);
    await git(repo, ["config", "user.name", "Hivemind Test"]);
    await git(repo, ["config", "user.email", "hivemind@example.test"]);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "# Graph fixture\n");
    await writeFile(
      path.join(repo, "src", "math.ts"),
      [
        "export const factor = 2;",
        "export function double(value: number): number { return value * factor; }",
        "export class Calculator {",
        "  calculate(value: number): number { return double(value); }",
        "}",
        ""
      ].join("\n")
    );
    await writeFile(path.join(repo, "src", "types.ts"), "export interface Result { value: number; }\n");
    await writeFile(path.join(repo, "src", "large.ts"), `${"// parser buffer fixture\n".repeat(2_000)}export const largeFileSymbol = true;\n`);
    await writeFile(
      path.join(repo, "src", "service.ts"),
      [
        "import { Calculator } from './math.js';",
        "export type { Result } from './types.js';",
        "export function run(value: number): number { return new Calculator().calculate(value); }",
        ""
      ].join("\n")
    );
    await writeFile(path.join(repo, "src", "index.ts"), "export { run } from './service.js';\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "graph fixture"]);
    await initProject(repo);
    await createRatifiedSpec(repo);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  }
}

function relativeSourceImports(repoPath: string, source: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/gu,
    /import\s*\(\s*["'](\.[^"']+)["']\s*\)/gu,
    /require\s*\(\s*["'](\.[^"']+)["']\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      const directory = path.posix.dirname(repoPath);
      const unresolved = path.posix.normalize(path.posix.join(directory, specifier));
      imports.add(unresolved.replace(/\.js$/u, ".ts"));
    }
  }
  return [...imports];
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
