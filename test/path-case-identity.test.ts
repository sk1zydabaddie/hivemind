import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { canonicalizeConcreteFileScope } from "../src/file-scope.js";
import { initProject } from "../src/init.js";
import { buildLeaseIndex, findCaseCollision } from "../src/lease-index.js";
import { readActiveLeases, requestLease } from "../src/lease.js";
import { foldPath, pathCaseBehaviour, pathIdentityKey } from "../src/path-identity.js";
import { createRatifiedSpec } from "./support/spec.js";

const execFileAsync = promisify(execFile);

/**
 * The disjoint invariant, defeated by the shift key.
 *
 * At most one task holds write scope over any given FILE. The lease store
 * substitutes "byte-equal repo-relative string" for "file", which is exact on a
 * case-sensitive filesystem and wrong on a case-insensitive one: `src/Foo.js`
 * and `src/foo.js` produce two keys, two grants, and two workers writing the
 * same bytes with every surface reporting normal.
 *
 * The tests come in two halves on purpose. The DECISION is arithmetic over a
 * filesystem verdict, so both answers are exercised on every machine. The
 * VERDICT is an observation, so it is checked against what the volume this test
 * is running on actually does -- including, where Windows allows it, a directory
 * genuinely switched to case-sensitive so the safe direction is not merely
 * asserted on Linux.
 */

/* ---------- the decision: both answers, on every platform ---------- */

test("a lease index resolves two spellings to one holder only when the filesystem does", () => {
  const store = { "src/foo.js": "T-001" };

  const insensitive = buildLeaseIndex(store, "case-insensitive");
  assert.equal(insensitive.holderOf("src/Foo.js"), "T-001");
  assert.equal(insensitive.keyOf("src/Foo.js"), "src/foo.js", "the stored spelling is what gets written back");

  const sensitive = buildLeaseIndex(store, "case-sensitive");
  assert.equal(sensitive.holderOf("src/Foo.js"), undefined, "two files on a case-sensitive volume");
  assert.equal(sensitive.holderOf("src/foo.js"), "T-001");
});

test("an undecidable filesystem folds, because more conflicts is the safe direction", () => {
  assert.equal(pathIdentityKey("src/Foo.js", "unknown"), foldPath("src/Foo.js"));
  assert.equal(pathIdentityKey("src/Foo.js", "case-insensitive"), foldPath("src/Foo.js"));
  assert.equal(pathIdentityKey("src/Foo.js", "case-sensitive"), "src/Foo.js");
  assert.equal(buildLeaseIndex({ "src/foo.js": "T-001" }, "unknown").holderOf("src/FOO.js"), "T-001");
});

test("a scope naming one file twice is reported, and an exact repeat is not", () => {
  assert.deepEqual(findCaseCollision(["src/Foo.js", "src/foo.js"], "case-insensitive"), {
    left: "src/Foo.js",
    right: "src/foo.js"
  });
  assert.equal(findCaseCollision(["src/Foo.js", "src/foo.js"], "case-sensitive"), null);
  assert.equal(findCaseCollision(["src/foo.js", "src/foo.js"], "case-insensitive"), null);
});

/* ---------- the verdict: what this volume actually does ---------- */

test("the probe agrees with the filesystem it is probing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hivemind-case-probe-"));
  try {
    await writeFile(path.join(directory, "Marker.txt"), "x\n", "utf8");
    const observed = await readBack(path.join(directory, "marker.txt"));
    const behaviour = await pathCaseBehaviour(directory);

    assert.notEqual(behaviour, "unknown", "a temp directory with a lettered entry is always decidable");
    assert.equal(
      behaviour,
      observed ? "case-insensitive" : "case-sensitive",
      "the probe must report what a write-then-read-under-another-spelling actually does"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/* ---------- the invariant, on the real lease store ---------- */

test("two tasks cannot both hold a file that differs only in capitalisation", async () => {
  await withLeaseRepo(async (repo) => {
    const behaviour = await pathCaseBehaviour(repo);

    /* Files that do NOT exist yet: the case canonicalizeIntentPath cannot fix by
       realpath, because there is nothing on disk to take the spelling from. */
    const first = await requestLease(repo, "T-001", ["src/Widget.ts"]);
    assert.equal(first.ok, true, first.ok ? undefined : first.reason);
    const second = await requestLease(repo, "T-002", ["src/widget.ts"]);

    if (behaviour === "case-insensitive") {
      assert.equal(second.ok, false, "one file, so the second task must be refused");
      if (!second.ok) assert.match(second.reason, /lease conflict/u);
      const store = await readActiveLeases(repo);
      assert.equal(store.ok, true);
      if (store.ok) {
        assert.deepEqual(Object.keys(store.store), ["src/Widget.ts"], "one file, one key, original spelling");
      }
    } else {
      assert.equal(second.ok, true, "two genuinely different files must not be made to conflict");
      if (!second.ok) return;
      const store = await readActiveLeases(repo);
      assert.equal(store.ok, true);
      if (store.ok) {
        assert.deepEqual(Object.keys(store.store).sort(), ["src/Widget.ts", "src/widget.ts"]);
      }
    }
  });
});

test("re-requesting under another spelling does not add a second key", async () => {
  await withLeaseRepo(async (repo) => {
    if ((await pathCaseBehaviour(repo)) !== "case-insensitive") return;
    await requestLease(repo, "T-001", ["src/Widget.ts"]);
    const again = await requestLease(repo, "T-001", ["src/widget.ts"]);
    assert.equal(again.ok, true, again.ok ? undefined : again.reason);
    const store = await readActiveLeases(repo);
    assert.equal(store.ok, true);
    if (store.ok) {
      assert.deepEqual(
        Object.keys(store.store),
        ["src/Widget.ts"],
        "the same task under two spellings still holds one key, spelled as first granted"
      );
    }
  });
});

test("a scope list naming one file under two spellings is refused, not quietly halved", async () => {
  await withLeaseRepo(async (repo) => {
    const result = await canonicalizeConcreteFileScope(repo, ["src/Widget.ts", "src/widget.ts"], "allowed_files");
    if ((await pathCaseBehaviour(repo)) === "case-insensitive") {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, /same file on this filesystem/u);
        assert.match(result.reason, /capitalisation/u);
      }
    } else {
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.paths.length, 2);
    }
  });
});

test("a lease store already holding both spellings is refused rather than tolerated", async () => {
  await withLeaseRepo(async (repo) => {
    if ((await pathCaseBehaviour(repo)) !== "case-insensitive") return;
    const storePath = path.join(repo, ".hivemind", "leases", "active.json");
    await mkdir(path.dirname(storePath), { recursive: true });
    /* Exactly what an older build would have written. */
    await writeFile(storePath, JSON.stringify({ "src/Widget.ts": "T-001", "src/widget.ts": "T-002" }), "utf8");

    const store = await readActiveLeases(repo);
    assert.equal(store.ok, false, "two holders over one file must not read as a normal store");
    if (!store.ok) assert.match(store.reason, /same file on this filesystem/u);
  });
});

/**
 * Windows can hand out a genuinely case-sensitive directory, which is the only
 * way to exercise the safe direction on a machine whose volumes are otherwise
 * all case-insensitive. It needs the WSL optional component and does not always
 * work, so the test proves the flag took effect before trusting it and skips
 * cleanly when it did not.
 */
test("a case-sensitive directory does not manufacture conflicts", async (t) => {
  if (process.platform !== "win32") {
    /* Every non-Windows CI volume here is already case-sensitive and the test
       above covers this direction on it. */
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "hivemind-case-sensitive-"));
  try {
    try {
      await execFileAsync("fsutil.exe", ["file", "setCaseSensitiveInfo", directory, "enable"]);
    } catch {
      t.skip("fsutil could not enable per-directory case sensitivity");
      return;
    }
    await writeFile(path.join(directory, "Marker.txt"), "x\n", "utf8");
    if (await readBack(path.join(directory, "marker.txt"))) {
      t.skip("the case-sensitive flag did not take effect on this volume");
      return;
    }

    await buildRepo(directory);
    assert.equal(await pathCaseBehaviour(directory), "case-sensitive");
    const first = await requestLease(directory, "T-001", ["src/Widget.ts"]);
    const second = await requestLease(directory, "T-002", ["src/widget.ts"]);
    assert.equal(first.ok, true, first.ok ? undefined : first.reason);
    assert.equal(second.ok, true, second.ok ? undefined : second.reason);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Does the other spelling reach the same bytes? The filesystem's own answer. */
async function readBack(target: string): Promise<boolean> {
  try {
    await stat(target);
    return (await readFile(target, "utf8")) === "x\n";
  } catch {
    return false;
  }
}

async function withLeaseRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(path.join(tmpdir(), "hivemind-case-lease-"));
  try {
    await buildRepo(repo);
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function buildRepo(repo: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Hivemind Test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "hivemind@example.test"], { cwd: repo });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  await initProject(repo);
  await createRatifiedSpec(repo);
}
