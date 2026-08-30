import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("desktop packaging", () => {
  test("names the desktop application explicitly when release tools add Rust binaries", async () => {
    const config = JSON.parse(await readFile(path.join(repoRoot, "desktop", "src-tauri", "tauri.conf.json"), "utf8"));
    const cargo = await readFile(path.join(repoRoot, "desktop", "src-tauri", "Cargo.toml"), "utf8");
    expect(config.mainBinaryName).toBe("hivemind_desktop");
    expect(cargo).toMatch(/^default-run = "hivemind_desktop"$/mu);
    expect(cargo).toMatch(/^members = \["release-tools"\]$/mu);
    expect(cargo).not.toMatch(/^minisign-verify\s*=/mu);
  });

  it("permits only Tauri IPC and loopback daemon traffic through connect-src", async () => {
    const config = JSON.parse(
      await readFile(path.join(repoRoot, "desktop", "src-tauri", "tauri.conf.json"), "utf8")
    ) as { app?: { security?: { csp?: string } } };
    const csp = config.app?.security?.csp ?? "";

    expect(csp).toContain("connect-src ipc: http://ipc.localhost");
    expect(csp).toContain("http://127.0.0.1:*");
    expect(csp).toContain("http://localhost:*");
    expect(csp).not.toMatch(/connect-src[^;]*https?:\/\/(?!ipc\.localhost|127\.0\.0\.1|localhost)/u);
  });

  it("builds an installable GUI-subsystem bundle with Core runtime resources", async () => {
    const config = JSON.parse(
      await readFile(path.join(repoRoot, "desktop", "src-tauri", "tauri.conf.json"), "utf8")
    ) as {
      bundle?: {
        active?: boolean;
        targets?: string[] | string;
        icon?: string[];
        resources?: Record<string, string>;
        windows?: { nsis?: { installerHooks?: string } };
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

    /* One qualified product means one platform contract. The prior Linux and
       macOS command names bypassed stamping and had no install verifier. A
       command that has never produced the admitted artifact is not support. */
    expect(config.bundle?.targets).toEqual(["nsis"]);
    expect(config.bundle?.icon).toEqual(
      expect.arrayContaining(["icons/128x128.png", "icons/icon.ico"])
    );

    const scripts = (
      JSON.parse(await readFile(path.join(repoRoot, "desktop", "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["tauri:build"]).toContain("nsis");
    expect(scripts["tauri:build:linux"]).toBeUndefined();
    expect(scripts["tauri:build:mac"]).toBeUndefined();

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
    /* Generated staging is packaging-only. Keeping it in tauri.conf makes a
       clean `cargo test` fail before prepare-bundle can create the paths. */
    expect(config.bundle?.resources).toBeUndefined();
    const stamp = await readFile(
      path.join(repoRoot, "desktop", "scripts", "stamp-version.mjs"),
      "utf8"
    );
    expect(stamp).toContain('"gen/bundle/core": "core"');
    expect(stamp).toContain('"gen/bundle/runtime": "runtime"');
    expect(stamp).toContain('"gen/payload-manifest.json": "artifact/payload-manifest.json"');
    expect(prepare).toMatch(/"ci", "--omit=dev"/u);
    expect(prepare).not.toMatch(/repoRoot, "node_modules"|"\.\.\/\.\.\/node_modules"/u);
    expect(config.bundle?.windows?.nsis?.installerHooks).toBe("./windows/installer-hooks.nsh");
    const installerHooks = await readFile(
      path.join(repoRoot, "desktop", "src-tauri", "windows", "installer-hooks.nsh"),
      "utf8"
    );
    expect(installerHooks).toMatch(/NSIS_HOOK_PREINSTALL/u);
    expect(installerHooks).toMatch(/RMDir \/r "\$INSTDIR\\core"/u);
    expect(installerHooks).toMatch(/RMDir \/r "\$INSTDIR\\runtime"/u);
    expect(installerHooks).toMatch(/RMDir \/r "\$INSTDIR\\artifact"/u);
    expect(main).toContain('windows_subsystem = "windows"');
    expect(project).toContain('.join("core")');
    expect(project).toContain('.join("cli.js")');
    expect(project).toContain("installed Hivemind Core resource is missing");
    expect(project).toContain("packaged shell build identity is missing");
    expect(project).toContain("installed Hivemind runtime is missing");

    const runtime = JSON.parse(
      await readFile(path.join(repoRoot, "desktop", "runtime", "node-runtime.json"), "utf8")
    ) as Record<string, string>;
    expect(runtime).toEqual({
      version: "22.23.2",
      platform: "win32",
      arch: "x64",
      url: "https://nodejs.org/dist/v22.23.2/win-x64/node.exe",
      sha256: "0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4"
    });
    expect(prepare).toMatch(/sha256File\(runtimePath\).*manifest\.sha256/su);
    expect(prepare).toMatch(/fetch\(manifest\.url/u);
    expect(prepare).toMatch(/version !== `v\$\{manifest\.version\}`/u);
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
  expect(installer).toMatch(/validateArtifactManifest/u);
  expect(installer).toMatch(/verifyManagedInventory/u);
  expect(installer).toMatch(/installedCoreBuild !== payload\.build\.core_build_id/u);
  expect(installer).toMatch(/installedRuntimeVersion !== `v\$\{payload\.build\.runtime\.version\}`/u);
  expect(installer).toMatch(/execFileSync\(installedRuntime, \[installedCli, "build-id"\]/u);
  expect(installer).toMatch(/installed payload manifest/u);
  expect(installer).toMatch(/artifact\.artifact_id/u);
});
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
    expect(scripts["admit:common"]).toMatch(/verify:reachable/u);
    /* Before, not after. A check that runs once the installer already exists
       is a report, not a gate -- and the ordering is exactly what went wrong
       with the calendar version, where a build hook was asked to produce the
       build's own arguments. */
    expect(scripts.ship.indexOf("admit:common")).toBeLessThan(
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

/**
 * The dependency advisory gate is part of shipping (A-29).
 *
 * Four vulnerable packages sat in the production MCP path while every
 * documented release check stayed green, because no check ever asked. Worse,
 * they sat in the LOCKFILE while node_modules held patched versions -- so the
 * suites kept passing against code a clean `npm ci` would never install. The
 * gate audits both lockfiles, which is exactly the artifact the suites cannot
 * vouch for.
 *
 * Policy (decided 2026-08-21): production advisories at high or above block
 * the ship; dev-only advisories are printed and never block, because a gate
 * that blocks for things nobody can act on gets removed by whoever it blocks.
 */
describe("the advisory gate is part of shipping", () => {
  test("ship runs it, and runs it before anything is built", async () => {
    const scripts = (
      JSON.parse(await readFile(path.join(repoRoot, "desktop", "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["verify:advisories"]).toBe("node scripts/audit-gate.mjs && node scripts/rust-audit-gate.mjs");
    expect(scripts["admit:common"]).toBe("npm run verify:advisories && npm run verify:reachable");
    expect(scripts.ship).toMatch(/admit:common/u);
    expect(scripts["tauri:build:signed"]).toMatch(/admit:common/u);
    /* Before the build, for the same reason verify:reachable runs first: a
       check that runs once the installer exists is a report, not a gate. */
    expect(scripts.ship.indexOf("admit:common")).toBeLessThan(
      scripts.ship.indexOf("tauri:build")
    );
  });

  test("it audits both packages, blocks at high on production deps, and only reports dev", async () => {
    const gate = (
      await readFile(path.join(repoRoot, "desktop", "scripts", "audit-gate.mjs"), "utf8")
    ).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    /* Both lockfiles are the product: the root package ships inside the app
       as Core. A gate scoped to one of them is scoped to where the problem
       was found, not where it lives. */
    expect(gate).toMatch(/repoRoot/u);
    expect(gate).toMatch(/desktop/u);
    expect(gate).toMatch(/--omit=dev/u);
    expect(gate).toMatch(/--audit-level=high/u);
    /* The blocking decision reads the tool's exit status -- its contractual
       signal -- never its printed text. */
    expect(gate).toMatch(/result\.status !== 0/u);
    expect(gate).not.toMatch(/vulnerabilit(y|ies)"|stdout.*match/u);
  });
});
