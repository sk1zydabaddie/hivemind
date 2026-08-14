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

    /* The version overlay must be generated BEFORE the CLI is invoked, not by
       the `beforeBuildCommand` hook the CLI runs. `--config` is validated while
       arguments are parsed, so a hook cannot produce it:

         error: invalid value for '--config': failed to read configuration file

       That is not hypothetical -- it is what every clean checkout did, silently
       leaving the installed binary reporting the hardcoded 0.0.0 the calendar
       versioning existed to replace, because `src-tauri/gen/` is gitignored.

       Asserted as an ORDER, not a presence: stamping must appear ahead of
       `tauri build` in the same script. And it must appear exactly once per
       build -- stamping in both places lets the clock cross a minute between
       them, so the build carries one version while `app-version.txt` records
       another and `install-local.mjs` fails a correct install. */
    const build = scripts["tauri:build"];
    expect(build).toContain("bundle:stamp");
    expect(build.indexOf("bundle:stamp")).toBeLessThan(build.indexOf("tauri build"));
    expect(scripts["bundle:prepare"]).not.toContain("stamp-version");
    const prepare = await readFile(
      path.join(repoRoot, "desktop", "scripts", "prepare-bundle.mjs"),
      "utf8"
    );
    expect(prepare).not.toContain("version.conf.json\",");
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

/* Installing is a step, and it verifies.
 *
 * `npm run tauri:build` writes an installer into `target/` and nothing ran it.
 * The Start menu opened the same binary for two weeks, faithfully, because it
 * was the only build ever installed -- and two earlier fixes (a real version
 * string, a stray shortcut) were both true and both downstream of the step that
 * was missing entirely.
 *
 *   Building is not installing.
 *
 * The verification is the point rather than the convenience: an install step
 * that silently does nothing is precisely the failure being fixed.
 */
describe("shipping", () => {
  it("installs what it built, and proves it landed", async () => {
  const scripts = (
    JSON.parse(await readFile(path.join(repoRoot, "desktop", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  expect(scripts["install:local"]).toBeDefined();
  /* One command that does both, so the two cannot drift apart in someone's
     head the way they did for two weeks. */
  expect(scripts.ship).toMatch(/tauri:build/u);
  expect(scripts.ship).toMatch(/install:local/u);

  const installer = await readFile(
    path.join(repoRoot, "desktop", "scripts", "install-local.mjs"),
    "utf8"
  );

  /* It compares the version stamped into the build against the version of the
     binary actually on disk -- read from the FILE, not from the running app,
     because what was wrong was the bytes on disk rather than the app's ability
     to start. */
  expect(installer).toMatch(/VersionInfo\.FileVersion/u);
  expect(installer).toMatch(/installed !== expected/u);
  expect(installer).toMatch(/INSTALL DID NOT TAKE/u);
  /* And it exits non-zero, or the check is decoration. */
  expect(installer).toMatch(/process\.exit\(1\)/u);

  /* It refuses to claim success when there is nothing to install, which is the
     state the repository was in the whole time. */
  expect(installer).toMatch(/No build to install/u);
  expect(installer).toMatch(/No installer for version/u);
});
});
