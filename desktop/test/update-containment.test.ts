import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function doesNotExist(relativePath: string): Promise<boolean> {
  try {
    await access(path.join(desktopRoot, relativePath));
    return false;
  } catch {
    return true;
  }
}

describe("permanent update trust containment", () => {
  test("the consumer has no updater, source classifier, or update execution surface", async () => {
    const [main, cargo, config, capability, app, packageJson] = await Promise.all([
      readFile(path.join(desktopRoot, "src-tauri", "src", "main.rs"), "utf8"),
      readFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), "utf8"),
      readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"),
      readFile(path.join(desktopRoot, "src-tauri", "capabilities", "default.json"), "utf8"),
      readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8"),
      readFile(path.join(desktopRoot, "package.json"), "utf8")
    ]);

    for (const [name, source] of [
      ["Rust entrypoint", main],
      ["Rust manifest", cargo],
      ["Tauri configuration", config],
      ["Tauri capability", capability],
      ["React application", app],
      ["desktop package", packageJson]
    ] as const) {
      expect(source, `${name} must contain no updater authority`).not.toMatch(
        /tauri.plugin.updater|plugin-updater|updater:|newer_version|take_newer_version|selfbuild/iu
      );
    }

    await expect(doesNotExist("src-tauri/src/selfbuild.rs")).resolves.toBe(true);
    await expect(doesNotExist("src-tauri/src/newer_version.rs")).resolves.toBe(true);
    await expect(doesNotExist("src/components/workspace/update-bar.tsx")).resolves.toBe(true);
  });

  test("both release commands fail before signing, credential lookup, or publication", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(desktopRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };
    const containedCommand = "node scripts/release-contained.mjs";

    expect(packageJson.scripts["release:local"]).toBe(containedCommand);
    expect(packageJson.scripts["release:github"]).toBe(containedCommand);

    const scriptPath = path.join(desktopRoot, "scripts", "release-contained.mjs");
    const source = await readFile(scriptPath, "utf8");
    expect(source).not.toMatch(/signer|private.?key|git credential|fetch\(|api\.github/u);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: desktopRoot,
      encoding: "utf8",
      env: { ...process.env, HIVEMIND_UPDATER_PRIVATE_KEY: "must-not-be-read" }
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "Release pipeline contained: signing and publication are disabled until provenance, protected signing, and pre-publication verification are rebuilt."
    );
    await expect(doesNotExist("scripts/release-local.mjs")).resolves.toBe(true);
    await expect(doesNotExist("scripts/publish-github-release.mjs")).resolves.toBe(true);
  });
});
