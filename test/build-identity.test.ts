import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { computeBuildIdentity, computeShellBuildIdentity } from "../src/build-identity.js";

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

test("desktop shell identity tracks build inputs but ignores generated output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hivemind-shell-identity-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await mkdir(path.join(root, "src-tauri", "src"), { recursive: true });
    await mkdir(path.join(root, "src-tauri", "target"), { recursive: true });
    await writeFile(path.join(root, "package.json"), "{}\n");
    await writeFile(path.join(root, "src", "App.tsx"), "export const App = 1;\n");
    await writeFile(path.join(root, "src-tauri", "src", "main.rs"), "fn main() {}\n");
    await writeFile(path.join(root, "dist", "bundle.js"), "generated one\n");
    await writeFile(path.join(root, "src-tauri", "target", "app.exe"), "generated one\n");

    const first = await computeShellBuildIdentity(root);
    await writeFile(path.join(root, "dist", "bundle.js"), "generated two\n");
    await writeFile(path.join(root, "src-tauri", "target", "app.exe"), "generated two\n");
    assert.equal(await computeShellBuildIdentity(root), first);

    await writeFile(path.join(root, "src", "App.tsx"), "export const App = 2;\n");
    assert.notEqual(await computeShellBuildIdentity(root), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
