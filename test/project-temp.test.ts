import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  assertDisposablePathBudget,
  createProjectTempDirectory,
  reconcileProjectTempDirectories,
  WINDOWS_DISPOSABLE_ROOT_BUDGET,
  withProjectTempDirectory
} from "../src/project-temp.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");

test("two projects receive disjoint disposable namespaces and cannot reconcile each other", async () => {
  await withTwoRepos(async ({ repoA, repoB, tempRoot }) => {
    const a = await createProjectTempDirectory(repoA, "consolidation", {
      tempRoot,
      reconcile: false,
      pid: 900_001
    });
    const b = await createProjectTempDirectory(repoB, "consolidation", {
      tempRoot,
      reconcile: false,
      pid: 900_002
    });
    await writeFile(path.join(a.path, "a-only.txt"), "A");
    await writeFile(path.join(b.path, "b-only.txt"), "B");

    assert.notEqual(path.basename(a.path).split("-")[1], path.basename(b.path).split("-")[1]);
    const reconciledA = await reconcileProjectTempDirectories(repoA, {
      tempRoot,
      probeLiveness: () => "dead"
    });

    assert.deepEqual(reconciledA.removed, [a.path]);
    assert.equal(await exists(b.path), true);
    assert.equal(await readFile(path.join(b.path, "b-only.txt"), "utf8"), "B");
  });
});

test("project namespace hash collision and partial-prefix matches cannot cross ownership", async () => {
  await withTwoRepos(async ({ repoA, repoB, tempRoot }) => {
    const collisionNamespace = "samehash";
    const b = await createProjectTempDirectory(repoB, "consolidation", {
      tempRoot,
      namespaceId: collisionNamespace,
      reconcile: false,
      pid: 900_003
    });

    const collisionAttempt = await reconcileProjectTempDirectories(repoA, {
      tempRoot,
      namespaceId: collisionNamespace,
      probeLiveness: () => "dead"
    });
    assert.deepEqual(collisionAttempt.removed, []);
    assert.equal(collisionAttempt.retained.some((entry) => entry.path === b.path), true);
    assert.equal(await exists(b.path), true);

    const partial = await createProjectTempDirectory(repoB, "consolidation", {
      tempRoot,
      namespaceId: "prefixlong",
      reconcile: false,
      pid: 900_004
    });
    const partialAttempt = await reconcileProjectTempDirectories(repoA, {
      tempRoot,
      namespaceId: "prefix",
      probeLiveness: () => "dead"
    });
    assert.deepEqual(partialAttempt, { removed: [], retained: [] });
    assert.equal(await exists(partial.path), true);
  });
});

test("live and ambiguous disposable owners are never reclaimed", async () => {
  await withRepo(async ({ repo, tempRoot }) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true
    });
    assert.equal(typeof child.pid, "number");
    const live = await createProjectTempDirectory(repo, "consolidation", {
      tempRoot,
      reconcile: false,
      pid: child.pid
    });
    try {
      const liveResult = await reconcileProjectTempDirectories(repo, { tempRoot });
      assert.equal(liveResult.removed.includes(live.path), false);
      assert.equal(await exists(live.path), true);

      const ambiguous = await createProjectTempDirectory(repo, "consolidation", {
        tempRoot,
        reconcile: false,
        pid: 900_005
      });
      const ambiguousResult = await reconcileProjectTempDirectories(repo, {
        tempRoot,
        probeLiveness: (pid) => (pid === 900_005 ? "unknown" : "alive")
      });
      assert.equal(ambiguousResult.removed.includes(ambiguous.path), false);
      assert.equal(await exists(ambiguous.path), true);
    } finally {
      child.kill();
    }
  });
});

test("missing, malformed, and identity-mismatched ownership remains fail-closed", async () => {
  await withRepo(async ({ repo, tempRoot }) => {
    const missing = await createProjectTempDirectory(repo, "consolidation", {
      tempRoot,
      reconcile: false,
      pid: 900_006
    });
    await rm(path.join(missing.path, "owner.json"));

    const malformed = await createProjectTempDirectory(repo, "consolidation", {
      tempRoot,
      reconcile: false,
      pid: 900_007
    });
    await writeFile(path.join(malformed.path, "owner.json"), "{\"pid\":");

    const changed = await createProjectTempDirectory(repo, "consolidation", {
      tempRoot,
      reconcile: false,
      pid: 900_008
    });
    const changedManifest = JSON.parse(await readFile(path.join(changed.path, "owner.json"), "utf8")) as {
      instance_id: string;
    };
    changedManifest.instance_id = "replacement";
    await writeFile(path.join(changed.path, "owner.json"), `${JSON.stringify(changedManifest)}\n`);

    const result = await reconcileProjectTempDirectories(repo, {
      tempRoot,
      probeLiveness: () => "dead"
    });
    assert.deepEqual(result.removed, []);
    assert.equal(await exists(missing.path), true);
    assert.equal(await exists(malformed.path), true);
    assert.equal(await exists(changed.path), true);
  });
});

test("a provably dead checkout orphan is reclaimed with its git worktree registration", async () => {
  await withRepo(async ({ repo, tempRoot, baseCommit }) => {
    const orphan = await createProjectTempDirectory(repo, "checkout", {
      tempRoot,
      reconcile: false,
      pid: 900_009
    });
    const checkoutPath = path.join(orphan.path, "checkout");
    await git(repo, ["worktree", "add", "--detach", checkoutPath, baseCommit]);

    const result = await reconcileProjectTempDirectories(repo, {
      tempRoot,
      probeLiveness: (pid) => (pid === 900_009 ? "dead" : "unknown")
    });

    assert.deepEqual(result.removed, [orphan.path]);
    assert.equal(await exists(orphan.path), false);
    assert.doesNotMatch(await gitStdout(repo, ["worktree", "list", "--porcelain"]), new RegExp(escapeRegExp(checkoutPath)));
  });
});

test("disposable cleanup holds on success, exception, and timeout-shaped failure", async () => {
  await withRepo(async ({ repo, tempRoot }) => {
    const paths: string[] = [];
    const value = await withProjectTempDirectory(
      repo,
      "consolidation",
      async (directory) => {
        paths.push(directory.path);
        await writeFile(path.join(directory.path, "success.txt"), "ok");
        return 42;
      },
      { tempRoot }
    );
    assert.equal(value, 42);

    await assert.rejects(
      withProjectTempDirectory(
        repo,
        "consolidation",
        async (directory) => {
          paths.push(directory.path);
          throw new Error("fixture exception");
        },
        { tempRoot }
      ),
      /fixture exception/u
    );

    await assert.rejects(
      withProjectTempDirectory(
        repo,
        "consolidation",
        async (directory) => {
          paths.push(directory.path);
          throw Object.assign(new Error("fixture timed out"), { code: "ETIMEDOUT" });
        },
        { tempRoot }
      ),
      /fixture timed out/u
    );

    for (const directoryPath of paths) {
      assert.equal(await exists(directoryPath), false);
    }
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

test("the Windows disposable-root budget fails loudly before a path can deepen silently", () => {
  const withinBudget = `C:\\${"a".repeat(WINDOWS_DISPOSABLE_ROOT_BUDGET - 3)}`;
  assert.doesNotThrow(() => assertDisposablePathBudget(withinBudget, "win32"));
  assert.throws(
    () => assertDisposablePathBudget(`${withinBudget}x`, "win32"),
    new RegExp(`${WINDOWS_DISPOSABLE_ROOT_BUDGET}-character Windows root budget`)
  );
  assert.doesNotThrow(() => assertDisposablePathBudget("/tmp/" + "a".repeat(300), "linux"));
});

test("production disposable paths no longer use the old shared prefixes", async () => {
  const [changesetSource, consolidationSource, tempSource, daemonSource] = await Promise.all([
    readFile(path.join(projectRoot, "src", "changeset.ts"), "utf8"),
    readFile(path.join(projectRoot, "src", "memory-consolidation.ts"), "utf8"),
    readFile(path.join(projectRoot, "src", "project-temp.ts"), "utf8"),
    readFile(path.join(projectRoot, "src", "daemon.ts"), "utf8")
  ]);
  assert.doesNotMatch(changesetSource, /hivemind-(?:checkout|changeset)-/u);
  assert.doesNotMatch(consolidationSource, /hivemind-consolidation-/u);
  assert.match(changesetSource, /withProjectTempDirectory/u);
  assert.match(consolidationSource, /withProjectTempDirectory/u);
  assert.match(tempSource, /from "\.\/process-liveness\.js"/u);
  assert.doesNotMatch(tempSource, /process\.kill/u);
  assert.match(daemonSource, /await reconcileProjectTempDirectories\(repoRoot\)/u);
});

async function withTwoRepos(
  run: (context: { repoA: string; repoB: string; tempRoot: string }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "hmpt-pair-"));
  const tempRoot = await mkdtemp(path.join(tmpdir(), "hmpt-data-"));
  try {
    const repoA = path.join(root, "project-a");
    const repoB = path.join(root, "project-b");
    await Promise.all([createRepo(repoA), createRepo(repoB)]);
    await run({ repoA, repoB, tempRoot });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(tempRoot, { recursive: true, force: true })
    ]);
  }
}

async function withRepo(
  run: (context: { repo: string; tempRoot: string; baseCommit: string }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "hmpt-one-"));
  const repo = path.join(root, "repo");
  const tempRoot = await mkdtemp(path.join(tmpdir(), "hmpt-data-"));
  try {
    await createRepo(repo);
    await run({ repo, tempRoot, baseCommit: await gitStdout(repo, ["rev-parse", "HEAD"]) });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(tempRoot, { recursive: true, force: true })
    ]);
  }
}

async function createRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "Hivemind Test"]);
  await git(repo, ["config", "user.email", "hivemind@example.test"]);
  await writeFile(path.join(repo, "README.md"), "# Fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout.trim();
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
