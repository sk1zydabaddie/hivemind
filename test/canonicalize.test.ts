import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalize } from "../src/canonicalize.js";

test("canonicalize resolves dot-dot to a normalized repo-relative path", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "b.ts"), "export const b = 1;\n");

    const result = await canonicalize(repo, "src/a/../b.ts");

    assert.deepEqual(result, { ok: true, resolved: "src/b.ts" });
  });
});

test("canonicalize returns normalized form for ordinary in-root paths", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "ordinary.ts"), "export const ordinary = true;\n");

    const result = await canonicalize(repo, "src/ordinary.ts");

    assert.deepEqual(result, { ok: true, resolved: "src/ordinary.ts" });
  });
});

test("canonicalize rejects paths resolving outside the repo root", async () => {
  await withRepo(async (repo) => {
    const outside = path.join(path.dirname(repo), "outside.txt");
    await writeFile(outside, "outside\n");

    const absoluteResult = await canonicalize(repo, outside);
    const relativeResult = await canonicalize(repo, "../outside.txt");

    assert.equal(absoluteResult.ok, false);
    assert.equal(relativeResult.ok, false);
  });
});

test("canonicalize rejects paths that cannot be resolved", async () => {
  await withRepo(async (repo) => {
    const result = await canonicalize(repo, "src/missing.ts");

    assert.equal(result.ok, false);
  });
});

test("canonicalize rejects a filesystem link pointing outside the repo root", async () => {
  await withRepo(async (repo) => {
    const outside = path.join(path.dirname(repo), "outside-link-target");
    const linkPath = path.join(repo, "link-out");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "target.txt"), "outside\n");
    await createDirectoryLink(outside, linkPath);

    const result = await canonicalize(repo, "link-out/target.txt");

    assert.equal(result.ok, false);
  });
});

test("canonicalize resolves an in-root filesystem link to its target path", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "real"), { recursive: true });
    await writeFile(path.join(repo, "real", "target.ts"), "export const target = true;\n");
    await createDirectoryLink(path.join(repo, "real"), path.join(repo, "link-in"));

    const result = await canonicalize(repo, "link-in/target.ts");

    assert.deepEqual(result, { ok: true, resolved: "real/target.ts" });
  });
});

test("canonicalize follows filesystem case rules", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "CaseFile.ts"), "export const caseFile = true;\n");

    const exactCaseResult = await canonicalize(repo, "src/CaseFile.ts");
    const wrongCaseResult = await canonicalize(repo, "src/casefile.ts");

    assert.deepEqual(exactCaseResult, { ok: true, resolved: "src/CaseFile.ts" });
    if (wrongCaseResult.ok) {
      assert.equal(wrongCaseResult.resolved, "src/CaseFile.ts");
    } else {
      assert.equal(wrongCaseResult.ok, false);
    }
  });
});

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "hivemind-canonicalize-test-"));
  const repo = path.join(tempRoot, "repo");
  await mkdir(repo);
  try {
    await run(await realpath(repo));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}
