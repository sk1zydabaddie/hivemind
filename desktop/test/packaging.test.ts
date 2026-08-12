import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("desktop packaging", () => {
  it("builds an installable GUI-subsystem bundle with Core runtime resources", async () => {
    const config = JSON.parse(
      await readFile(path.join(repoRoot, "desktop", "src-tauri", "tauri.conf.json"), "utf8")
    ) as {
      bundle?: {
        active?: boolean;
        targets?: string[] | string;
        icon?: string[];
        resources?: Record<string, string>;
      };
    };
    const main = await readFile(
      path.join(repoRoot, "desktop", "src-tauri", "src", "main.rs"),
      "utf8"
    );
    const project = await readFile(
      path.join(repoRoot, "desktop", "src-tauri", "src", "project.rs"),
      "utf8"
    );

    expect(config.bundle?.active).toBe(true);

    /* The bundle config must not be shaped for one platform. It used to pin
       `["nsis"]`, which is Windows-only, and it declared no icon set at all --
       Windows fell back to a default and the AppImage bundler failed with
       "couldn't find a square icon" the first time Linux packaging was
       attempted. `all` lets each host build what it can, and each platform's
       npm script names the bundles it actually ships. */
    expect(config.bundle?.targets).toBe("all");
    expect(config.bundle?.icon).toEqual(
      expect.arrayContaining(["icons/128x128.png", "icons/icon.ico", "icons/icon.icns"])
    );

    const scripts = (
      JSON.parse(await readFile(path.join(repoRoot, "desktop", "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["tauri:build"]).toContain("nsis");
    expect(scripts["tauri:build:linux"]).toMatch(/deb|appimage/u);
    /* Every platform Hivemind claims names its own bundles. macOS is still
       UNVERIFIED-ON-MACOS -- the script existing is not a claim that the bundle
       has ever been built, only that the config is no longer shaped for two
       platforms out of three. See docs/MACOS-CHECKLIST.md item 5. */
    expect(scripts["tauri:build:mac"]).toMatch(/app|dmg/u);
    expect(config.bundle?.resources).toMatchObject({
      "../../dist": "core/dist",
      "../../node_modules": "core/node_modules",
      "gen/shell-build-id.txt": "core/shell-build-id.txt"
    });
    expect(main).toContain('windows_subsystem = "windows"');
    expect(project).toContain('.join("core")');
    expect(project).toContain('.join("cli.js")');
    expect(project).toContain("installed Hivemind Core resource is missing");
    expect(project).toContain("packaged shell build identity is missing");
  });
});
