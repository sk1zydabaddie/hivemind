import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, test } from "vitest";

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

/* The version scheme has to be valid semver at every hour of the day.
 *
 * `${pad(hours,2)}${pad(minutes,2)}` produces `0924` before 10am, and a semver
 * identifier may not carry a leading zero -- so `tauri build` refused the config
 * outright and no build was possible between midnight and 10am. Every build in
 * this project's history had happened after 10am, so the scheme was broken for
 * ten hours of every day with nothing ever running in them. Found by shipping
 * at 09:24, which is the only way it could have been found. */
test("the calendar version is valid semver at every minute of the day", () => {
  const stamp = (hour: number, minute: number, month: number, day: number): string =>
    [
      26,
      `${month}${String(day).padStart(2, "0")}`,
      hour * 100 + minute
    ].join(".");

  /* Semver: no leading zeros in a numeric identifier. */
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
  const seen: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 5, 9, 30, 59]) {
      const value = stamp(hour, minute, 8, 15);
      expect(value, `${hour}:${minute} produced ${value}`).toMatch(semver);
      seen.push(value);
    }
  }
  /* And the day's stamps still increase, which is the only property the scheme
     actually needs beyond being parseable. */
  const numbers = seen.map((value) => Number(value.split(".")[2]));
  for (let index = 1; index < numbers.length; index += 1) {
    expect(numbers[index]!).toBeGreaterThan(numbers[index - 1]!);
  }
  /* Each field stays under the 65536 the Windows version resource imposes. */
  expect(Math.max(...numbers)).toBeLessThan(65536);
  expect(Number(stamp(0, 0, 12, 31).split(".")[1])).toBeLessThan(65536);

  /* The instrument has to be able to fail: the shape that shipped must not
     pass the same check. */
  const broken = `26.815.${String(9).padStart(2, "0")}${String(24).padStart(2, "0")}`;
  expect(broken).toBe("26.815.0924");
  expect(semver.test(broken)).toBe(false);
});

/**
 * The guard that only fired when somebody remembered.
 *
 * `verify:reachable` found a crash three commits after the code causing it
 * landed. Not because it was wrong -- it is the only instrument here that can
 * see a control below the fold -- but because it needed a dev server and a
 * debuggable browser that `npm run ship` did not provide, so it ran when
 * somebody thought to run it. It now builds the replay for production and
 * applies the committed Tauri CSP, because the dev server cannot reproduce a
 * resource the production transform inlines and the installed WebView blocks.
 * That is the same shape as `provider_version`,
 * written onto every record and compared by nothing: built, correct, silent.
 *
 * "Run it manually" is not a mechanism, so these assert the wiring rather than
 * the intention.
 */
describe("the reachability check is part of shipping", () => {
  test("ship runs it, and runs it before the bundle is built", async () => {
    const scripts = (
      JSON.parse(await readFile(path.join(repoRoot, "desktop", "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts.ship).toMatch(/verify:reachable/u);
    /* Before, not after. A check that runs once the installer already exists
       is a report, not a gate -- and the ordering is exactly what went wrong
       with the calendar version, where a build hook was asked to produce the
       build's own arguments. */
    expect(scripts.ship.indexOf("verify:reachable")).toBeLessThan(
      scripts.ship.indexOf("tauri:build")
    );
  });

  test("it starts what it needs rather than assuming it", async () => {
    const source = await readFile(
      path.join(repoRoot, "desktop", "tools", "check-reachable.mjs"),
      "utf8"
    );
    expect(source).toMatch(/ensureHarness/u);
    /* And puts back only what it started, including on the failing exit --
       which is the interesting one, because a surface that never renders
       throws before any tidy-up at the bottom of the script is reached. */
    expect(source).toMatch(/process\.on\("exit"/u);
  });

  test("it proves production images load under the shipped CSP", async () => {
    const check = await readFile(
      path.join(repoRoot, "desktop", "tools", "check-reachable.mjs"),
      "utf8"
    );
    const vite = await readFile(path.join(repoRoot, "desktop", "vite.config.ts"), "utf8");
    expect(vite, "small imported assets must stay on the CSP-approved app origin").toMatch(
      /assetsInlineLimit:\s*0/u
    );
    expect(check, "markup presence cannot prove that an image decoded").toMatch(/naturalWidth/u);
    expect(check, "the replay must use Vite's production asset transform").toMatch(/await build\(/u);
    expect(check, "the production replay must use the committed Tauri policy").toMatch(
      /Content-Security-Policy|tauri\.conf\.json/u
    );
    expect(check, "blocked resources and browser errors must fail the run").toMatch(
      /Network\.loadingFailed/u
    );
    expect(check).toMatch(/Runtime\.consoleAPICalled|Log\.entryAdded/u);
  });

  test("a browser it cannot find is a failure, never a skip", async () => {
    /* The tools directory is plain JS on purpose -- it runs under bare node,
       outside the bundle -- so the boundary carries a declaration file rather
       than being cast away here. */
    const { findBrowser } = await import("../tools/managed-browser.mjs");
    expect(() => findBrowser([], 9444)).toThrow(/failure rather than a skip/u);
    expect(() => findBrowser(["/definitely/not/here"], 9444)).toThrow(/no Chromium/u);
  });
});
