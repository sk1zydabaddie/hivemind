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

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
}

describe("phase 0 update and release containment", () => {
  test("the consumer can discover an update but has no install or source-build command", async () => {
    const main = await readFile(path.join(desktopRoot, "src-tauri", "src", "main.rs"), "utf8");
    const updater = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "newer_version.rs"),
      "utf8"
    );
    const bar = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "update-bar.tsx"),
      "utf8"
    );

    expect(main).toMatch(/\bnewer_version\b/u);
    expect(main).not.toMatch(/\btake_newer_version\b|\bmod selfbuild\b/u);
    expect(updater).toMatch(/updater\.check\(\)\.await/u);
    expect(withoutComments(updater)).not.toMatch(
      /download_and_install|build_and_install|install_built_and_restart|source_standing|swap_marker/u
    );
    expect(bar).toMatch(/Updates are temporarily paused/u);
    expect(bar).not.toMatch(/take_newer_version|Build and restart|Update and restart/u);
    await expect(doesNotExist("src-tauri/src/selfbuild.rs")).resolves.toBe(true);
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
