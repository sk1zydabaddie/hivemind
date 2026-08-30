import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_SCHEMA_VERSION,
  inventoryManagedRoots,
  nsisExecutableIdentity,
  sha256,
  stableJson,
  validateArtifactManifest,
  validatePayloadManifest,
  verifyManagedInventory,
  WINDOWS_PLATFORM
} from "../scripts/artifact-integrity.mjs";
import {
  nextMonotonicVersion,
  parseVersion,
  versionFromEpochMilliseconds
} from "../scripts/versioning.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("release version allocation", () => {
  it("is Windows-safe and cannot collide within one millisecond or after clock rollback", () => {
    const now = Date.UTC(2026, 7, 29, 17, 9, 0, 123);
    const first = versionFromEpochMilliseconds(now);
    const second = nextMonotonicVersion(now, first);
    const rollback = nextMonotonicVersion(now - 60_000, second);

    expect(compare(first, second)).toBeLessThan(0);
    expect(compare(second, rollback)).toBeLessThan(0);
    for (const version of [first, second, rollback]) {
      expect(version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
      expect(parseVersion(version).every((field) => field <= 65_535)).toBe(true);
    }
  });

  it("rejects invalid time and overflowing Windows fields", () => {
    expect(() => versionFromEpochMilliseconds(-1)).toThrow(/non-negative/u);
    expect(() => versionFromEpochMilliseconds(Number.MAX_SAFE_INTEGER)).toThrow(/Windows/u);
  });
});

describe("managed payload inventory", () => {
  it("rejects changed, additional, and missing installed bytes", async () => {
    const root = await payloadRoot();
    const expected = await inventoryManagedRoots(root);
    await expect(verifyManagedInventory(root, expected)).resolves.toBeUndefined();

    await writeFile(path.join(root, "core", "dist", "cli.js"), "changed\n");
    await expect(verifyManagedInventory(root, expected)).rejects.toThrow(/changed: core\/dist\/cli\.js/u);

    await writeFile(path.join(root, "core", "dist", "cli.js"), "original\n");
    await writeFile(path.join(root, "runtime", "stale.dll"), "stale\n");
    await expect(verifyManagedInventory(root, expected)).rejects.toThrow(/unexpected: runtime\/stale\.dll/u);

    await unlink(path.join(root, "runtime", "stale.dll"));
    await unlink(path.join(root, "runtime", "node.exe"));
    await expect(verifyManagedInventory(root, expected)).rejects.toThrow(/missing: runtime\/node\.exe/u);
  });

  it("rejects an artifact manifest whose fields no longer match its identity", () => {
    const hash = "a".repeat(64);
    const sourceCommit = "b".repeat(40);
    const base = {
      schema_version: ARTIFACT_SCHEMA_VERSION,
      kind: "hivemind-windows-artifact",
      platform: WINDOWS_PLATFORM,
      version: "414.1.2",
      generated_at_ms: 1,
      source_commit: sourceCommit,
      payload_manifest: { filename: "payload.json", size: 1, sha256: hash },
      installer: { filename: "setup.exe", size: 1, sha256: hash },
      executable: {
        filename: "hivemind_desktop.exe",
        bundle_type: "nsis",
        size: 1,
        source_sha256: hash,
        sha256: hash
      }
    };
    const manifest = { ...base, artifact_id: sha256(stableJson(base)) };
    expect(validateArtifactManifest(manifest)).toBe(manifest);
    expect(() => validateArtifactManifest({ ...manifest, version: "414.1.3" })).toThrow(/identity/u);
  });

  it("binds Tauri's exact NSIS marker transformation and rejects ambiguous inputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hivemind-nsis-test-"));
    temporaryDirectories.push(root);
    const executable = path.join(root, "app.exe");
    await writeFile(executable, "before__TAURI_BUNDLE_TYPE_VAR_UNKafter");
    const identity = await nsisExecutableIdentity(executable, "app.exe");
    expect(identity.source_sha256).toBe(sha256("before__TAURI_BUNDLE_TYPE_VAR_UNKafter"));
    expect(identity.sha256).toBe(sha256("before__TAURI_BUNDLE_TYPE_VAR_NSSafter"));
    expect(identity.source_sha256).not.toBe(identity.sha256);

    await writeFile(executable, "no marker");
    await expect(nsisExecutableIdentity(executable)).rejects.toThrow(/exactly one/u);
    await writeFile(
      executable,
      "__TAURI_BUNDLE_TYPE_VAR_UNK__TAURI_BUNDLE_TYPE_VAR_UNK"
    );
    await expect(nsisExecutableIdentity(executable)).rejects.toThrow(/exactly one/u);
  });

  it("requires clean source inputs and all three lockfiles to agree with their identities", () => {
    const hash = "a".repeat(64);
    const inputs = [{ path: "desktop/index.html", size: 1, sha256: hash }];
    const manifest = {
      schema_version: 1,
      kind: "hivemind-payload",
      platform: WINDOWS_PLATFORM,
      version: "414.1.2",
      generated_at_ms: 1,
      source: {
        commit: "b".repeat(40),
        clean: true,
        input_tree_sha256: sha256(stableJson(inputs)),
        inputs,
        lockfiles: {
          "package-lock.json": hash,
          "desktop/package-lock.json": hash,
          "desktop/src-tauri/Cargo.lock": hash
        }
      },
      build: {
        core_build_id: hash,
        shell_build_id: hash,
        runtime: { version: "22.23.2", sha256: hash }
      },
      files: [
        { path: "core/dist/cli.js", size: 1, sha256: hash },
        { path: "runtime/node.exe", size: 1, sha256: hash }
      ]
    };
    expect(validatePayloadManifest(manifest)).toBe(manifest);
    expect(() => validatePayloadManifest({
      ...manifest,
      source: { ...manifest.source, input_tree_sha256: "c".repeat(64) }
    })).toThrow(/source input identity/u);
    expect(() => validatePayloadManifest({
      ...manifest,
      source: { ...manifest.source, lockfiles: { "package-lock.json": hash } }
    })).toThrow(/three admitted lockfiles/u);
  });
});

async function payloadRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hivemind-payload-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "core", "dist"), { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  await writeFile(path.join(root, "core", "dist", "cli.js"), "original\n");
  await writeFile(path.join(root, "runtime", "node.exe"), "runtime\n");
  return root;
}

function compare(left: string, right: string): number {
  const leftFields = parseVersion(left);
  const rightFields = parseVersion(right);
  for (let index = 0; index < leftFields.length; index += 1) {
    if (leftFields[index] !== rightFields[index]) return leftFields[index]! - rightFields[index]!;
  }
  return 0;
}
