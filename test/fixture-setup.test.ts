import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");
const fixtureScript = path.join(projectRoot, "scripts", "create-isolated-fixture-repo.mjs");

test("isolated fixture setup initializes Git only inside the explicit new target", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "hivemind-fixture-parent-"));
  try {
    const target = path.join(parent, "target");
    const result = await execFileAsync(process.execPath, [fixtureScript, target], {
      cwd: parent,
      windowsHide: true
    });
    const output = JSON.parse(result.stdout) as { repo: string; branch: string };

    assert.equal(samePath(output.repo, await realpath(target)), true);
    assert.equal(output.branch, "main");
    assert.equal(await exists(path.join(parent, ".git")), false);
    assert.equal(await exists(path.join(target, ".git")), true);

    const topLevel = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: target,
      windowsHide: true
    });
    assert.equal(samePath(topLevel.stdout.trim(), await realpath(target)), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("isolated fixture setup refuses missing or existing targets before Git can touch the caller", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "hivemind-fixture-refusal-"));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [fixtureScript], { cwd: parent, windowsHide: true }),
      (error: unknown) => {
        assert.match(String((error as { stderr?: unknown }).stderr ?? ""), /absolute-new-directory/u);
        return true;
      }
    );

    const existing = path.join(parent, "existing");
    await mkdir(existing);
    await assert.rejects(
      execFileAsync(process.execPath, [fixtureScript, existing], { cwd: parent, windowsHide: true }),
      (error: unknown) => {
        assert.match(String((error as { stderr?: unknown }).stderr ?? ""), /fixture target must be a new directory/u);
        return true;
      }
    );

    assert.equal(await exists(path.join(parent, ".git")), false);
    assert.equal(await exists(path.join(existing, ".git")), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
