import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..");

test("package bin points at the emitted CLI", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    bin: { hivemind: string };
  };
  const binPath = path.resolve(repoRoot, manifest.bin.hivemind);

  await stat(binPath);
  await assert.rejects(
    execFileAsync("node", [binPath], { cwd: repoRoot, windowsHide: true }),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      assert.notEqual(error, null);
      assert.equal((error as { code?: number }).code, 1);
      assert.match(String((error as { stderr?: string }).stderr), /error: missing command/);
      return true;
    }
  );
});
