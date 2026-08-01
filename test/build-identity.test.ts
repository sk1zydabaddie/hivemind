import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { computeBuildIdentity } from "../src/build-identity.js";

test("Core build identity is deterministic, order-independent, and content-sensitive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hivemind-build-identity-"));
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "z.js"), "export const z = 1;\n");
    await writeFile(path.join(root, "nested", "a.js"), "export const a = 1;\n");
    await writeFile(path.join(root, "ignored.map"), "not part of the identity\n");
    const first = await computeBuildIdentity(root);
    const second = await computeBuildIdentity(root);
    assert.match(first, /^[a-f0-9]{64}$/u);
    assert.equal(second, first);

    await writeFile(path.join(root, "nested", "a.js"), "export const a = 2;\n");
    assert.notEqual(await computeBuildIdentity(root), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
