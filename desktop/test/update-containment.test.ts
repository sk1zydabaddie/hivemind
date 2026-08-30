import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");

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

  test("release commands share signed build and exact local installation before publication", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(desktopRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["release:local"]).toBe("npm run tauri:build:signed && npm run install:local");
    expect(packageJson.scripts["release:github"]).toBe(
      "npm run tauri:build:signed && npm run install:local && node scripts/publish-github-release.mjs"
    );
    const scriptPath = path.join(desktopRoot, "scripts", "publish-github-release.mjs");
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: desktopRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: "must-not-be-used" }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/protected manual GitHub Actions workflow/u);
    expect(result.stderr).not.toContain("must-not-be-used");
    await expect(doesNotExist("scripts/release-contained.mjs")).resolves.toBe(true);
    await expect(doesNotExist("scripts/release-local.mjs")).resolves.toBe(true);
    await expect(doesNotExist("src-tauri/gen/publication-receipt.json")).resolves.toBe(true);
  });

  test("public release is manual, master-only, serialized, and protected before secrets are used", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toMatch(/^\s*workflow_dispatch:\s*$/mu);
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/mu);
    expect(workflow).toMatch(/^\s*if: github\.ref == 'refs\/heads\/master'\s*$/mu);
    expect(workflow).toMatch(/^\s*environment: production-release\s*$/mu);
    expect(workflow).toMatch(/^\s*cancel-in-progress: false\s*$/mu);
    expect(workflow).toMatch(/^\s*contents: write\s*$/mu);
    expect(workflow).toMatch(/^\s*run: npm run release:github\s*$/mu);
    expect(workflow).toMatch(/Remove ephemeral publisher material/u);
    expect(workflow).toMatch(/if: always\(\)/u);
  });
});
