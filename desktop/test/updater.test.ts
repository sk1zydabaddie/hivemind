import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");

/**
 * The updater, wired end to end — because every part of it fails silently.
 *
 * A missing public key, an endpoint that is never reached, an unsigned
 * installer: none of those announce themselves, and all three present as "no
 * updates available". That is the exact silence that put a four-hour-old build
 * in front of a person four sessions running, each time with the fix already
 * written.
 */
describe("the updater", () => {
  test("the plugin is registered for Rust but every webview updater command is denied", async () => {
    const cargo = await readFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), "utf8");
    expect(cargo).toMatch(/tauri-plugin-updater/u);

    const main = await readFile(path.join(desktopRoot, "src-tauri", "src", "main.rs"), "utf8");
    expect(main).toMatch(/tauri_plugin_updater::Builder::new\(\)\.build\(\)/u);
    expect(main).toMatch(/newer_version/u);

    const capability = JSON.parse(
      await readFile(path.join(desktopRoot, "src-tauri", "capabilities", "default.json"), "utf8")
    ) as { permissions: string[] };
    const updaterPermissions = capability.permissions.filter((permission) =>
      permission.startsWith("updater:")
    );
    expect(updaterPermissions).toEqual([
      "updater:deny-check",
      "updater:deny-download",
      "updater:deny-install",
      "updater:deny-download-and-install"
    ]);
    expect(
      updaterPermissions.some((permission) =>
        permission === "updater:default" || permission.includes(":allow-")
      ),
      "any updater grant lets webview code walk around the Rust idleness gate"
    ).toBe(false);

    const frontendFiles = execFileSync(
      "git",
      ["ls-files", "src/**/*.ts", "src/**/*.tsx"],
      { cwd: desktopRoot, encoding: "utf8" }
    )
      .split(/\r?\n/u)
      .filter(Boolean);
    for (const file of frontendFiles) {
      const source = await readFile(path.join(desktopRoot, file), "utf8");
      expect(source, `${file} must not import the updater's direct JS API`).not.toMatch(
        /@tauri-apps\/plugin-updater/u
      );
    }
  });

  /* A build with no public key cannot verify anything, so the plugin refuses
     every update — and reports that as nothing to install. */
  test("a public key is configured, and it is a real one", async () => {
    const conf = JSON.parse(
      await readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8")
    ) as { plugins?: { updater?: { pubkey?: string; endpoints?: string[] } } };

    const pubkey = conf.plugins?.updater?.pubkey ?? "";
    expect(pubkey.length, "no public key means no update can ever be verified").toBeGreaterThan(80);
    expect(Buffer.from(pubkey, "base64").toString("utf8")).toMatch(/minisign public key/iu);

    expect(
      conf.plugins?.updater?.endpoints ?? [],
      "an updater with no endpoint checks nothing"
    ).not.toHaveLength(0);
  });

  /**
   * The risk that is worse than it sounds.
   *
   * The public key is compiled into every installed copy, so a LOST private key
   * cannot be replaced — a new one signs nothing those copies will accept, and
   * they would each have to be re-installed by hand. It lives outside the
   * repository so deleting the checkout cannot delete it.
   *
   * This asserts the other half: it never gets committed. A signing key in git
   * history is not removed by deleting the file.
   */
  test("no signing key is in the repository, and none can be added", async () => {
    const ignore = await readFile(path.join(desktopRoot, ".gitignore"), "utf8");
    expect(ignore).toMatch(/\*\.key/u);

    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
    const keys = tracked.split(/\r?\n/u).filter((file) => /\.key$|\.key\.pub$|\.sig$/u.test(file));
    expect(keys, "a signing key is committed; git history keeps it after deletion").toEqual([]);
  });

  test("published updates are not committed", async () => {
    const ignore = await readFile(path.join(desktopRoot, ".gitignore"), "utf8");
    expect(ignore).toMatch(/updates\//u);
  });

  /**
   * The gate lives in Rust, not in the bar.
   *
   * `take_newer_version` replaces the running binary. A gate evaluated in React is
   * one that anything able to call the plugin walks around, and the standing
   * rule is that the client holds no gate logic. So the refusal is computed
   * where the reservations can actually be read — from disk, rather than by
   * asking a daemon that may have crashed.
   */
  test("install is gated on the on-disk idleness proof, in Rust", async () => {
    const updater = await readFile(path.join(desktopRoot, "src-tauri", "src", "newer_version.rs"), "utf8");
    expect(updater).toMatch(/daemon_work/u);
    /* Anything other than Idle refuses — Unknown included, because a daemon
       that cannot answer must not read as one with nothing running. */
    expect(updater).toMatch(/matches!\(standing\.work, DaemonWork::Idle\)/u);
    expect(updater).toMatch(/WorkInFlight/u);

    /* And check is NOT gated: a busy project must still be able to discover
       that an update exists, or the silence is rebuilt at a different level. */
    const check = updater.slice(
      updater.indexOf("pub async fn newer_version"),
      updater.indexOf("pub async fn take_newer_version")
    );
    expect(check).not.toMatch(/daemon_work/u);
  });

  /* An unreachable endpoint is a REPORTED state, not an absence of news, and it
     is a distinct variant precisely so the surface cannot render it as
     up-to-date. */
  test("every outcome is a named state, and unreachable is not up to date", async () => {
    const updater = await readFile(path.join(desktopRoot, "src-tauri", "src", "newer_version.rs"), "utf8");
    /* Where a newer version could come from, and what happened when it was
       taken. `None` and `Unknown` are separate variants on purpose: checked and
       current is not the same fact as could not check. */
    for (const variant of ["None", "Release", "Source", "Unknown"]) {
      expect(updater).toMatch(new RegExp(`${variant}\\s*[{,]`, "u"));
    }
    for (const variant of ["Restarting", "WorkInFlight", "Failed"]) {
      expect(updater).toMatch(new RegExp(`${variant}\\s*[{,]`, "u"));
    }

    const bar = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "update-bar.tsx"),
      "utf8"
    );
    /* The bar hides for exactly two reasons: it has not answered yet, and it
       answered "nothing to offer". Any third early return would be the silence
       being rebuilt. */
    expect(
      [...bar.matchAll(/return null;/gu)].length,
      "the bar may only be silent when it has nothing to say"
    ).toBe(2);
    expect(bar).toMatch(/source === "none" && outcome === null/u);
    expect(bar, "an unreachable check must say it is not confirmation").toMatch(
      /not<\/em> confirmation|not.{0,12}confirmation/iu
    );
  });

  /* ONE surface answers "is a newer version available". The build bar was a
     second answer to the same question, and a person was left to work out which
     mechanism had produced which sentence — while a third box explained that a
     background process from the previous version was still running. Both routes
     now come through `newer_version`, which picks the source; the daemon
     restart is a consequence of updating and happens without being asked. */
  test("exactly one surface answers the question", async () => {
    const app = await readFile(path.join(desktopRoot, "src", "App.tsx"), "utf8");
    expect(app).toMatch(/<UpdateBar/u);
    expect(app, "a second bar answering the same question is what this replaced")
      .not.toMatch(/<BuildBar/u);
  });

  /* A release step nobody can run is a release step that does not exist. */
  test("publishing and serving are scripts, not instructions", async () => {
    const scripts = (
      JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["release:local"]).toBeDefined();
    expect(scripts["updater:serve"]).toBeDefined();

    const release = await readFile(path.join(desktopRoot, "scripts", "release-local.mjs"), "utf8");
    /* It signs. An unsigned installer is rejected by the plugin, which presents
       as "no update available" — silence again. */
    expect(release).toMatch(/"sign"/u);
    expect(release).toMatch(/signature/u);
    /* And it refuses loudly when the key is missing, rather than publishing
       something nothing will accept. */
    expect(release).toMatch(/No signing key/u);
  });
});

/**
 * The insecure endpoint must never ship.
 *
 * The plugin refuses `http://` outright — the app panicked on startup with
 * "The configured updater endpoint must use a secure protocol like `https`",
 * which is a good refusal and was found by launching the build rather than by
 * reading the docs. The escape (`dangerousInsecureTransportProtocol`) exists
 * for exactly this local case, and it is quarantined in an overlay that only
 * `tauri:build:localupdate` applies.
 *
 * Worth being precise about what the flag does and does not cost: the Ed25519
 * signature is verified whatever the transport, so an http endpoint weakens the
 * channel, not the code-integrity guarantee. It still must not ship, and the
 * committed config is what ships.
 */
describe("the shipped configuration", () => {
  test("the committed endpoint is https and carries no dangerous flag", async () => {
    const conf = JSON.parse(
      await readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8")
    ) as {
      plugins?: { updater?: { endpoints?: string[]; dangerousInsecureTransportProtocol?: boolean } };
    };
    const updater = conf.plugins?.updater ?? {};
    for (const endpoint of updater.endpoints ?? []) {
      expect(endpoint, "a shipped endpoint must be https").toMatch(/^https:\/\//u);
    }
    expect(
      updater.dangerousInsecureTransportProtocol,
      "the insecure transport flag must never be in the committed config"
    ).toBeUndefined();
  });

  test("the local overlay exists, is separate, and is applied by its own script", async () => {
    const overlay = JSON.parse(
      await readFile(path.join(desktopRoot, "src-tauri", "updater-dev.conf.json"), "utf8")
    ) as { plugins: { updater: { dangerousInsecureTransportProtocol: boolean } } };
    expect(overlay.plugins.updater.dangerousInsecureTransportProtocol).toBe(true);

    const scripts = (
      JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["tauri:build:localupdate"]).toMatch(/updater-dev\.conf\.json/u);
    /* And the normal build must NOT apply it. */
    expect(scripts["tauri:build"]).not.toMatch(/updater-dev/u);
  });
});

/**
 * Three states, three treatments — and the middle one is where most machines
 * live.
 *
 * A clay-toned "could not check for updates", standing permanently on a machine
 * where no release is published, is an alarm about a non-problem. Alarms about
 * non-problems are ignored within a week, and the real one is ignored with
 * them. Flattening it to "up to date" would be the opposite lie, because the
 * remote genuinely was not reached. So it is its own answer, rendered quietly.
 */
describe("the volume of the answer matches the news", () => {
  test("Rust distinguishes nothing-newer from could-not-look", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "newer_version.rs"),
      "utf8"
    );
    /* `None` carries an optional caveat; `Unknown` is reserved for the case
       where NEITHER source answered. */
    expect(source).toMatch(/caveat: Option<String>/u);
    expect(source).toMatch(/source_answered/u);
    expect(source).toMatch(/\(false, true\) => NewerVersion::None/u);
    expect(source).toMatch(/\(false, false\) => NewerVersion::Unknown/u);
  });

  test("the bar renders three distinct volumes", async () => {
    const bar = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "update-bar.tsx"),
      "utf8"
    );
    /* Silent when both agree. */
    expect(bar).toMatch(/answer\.caveat === null && outcome === null\) return null/u);
    /* Nearly silent otherwise: no tint, no border, no button, and the caveat on
       the element rather than in the sentence. */
    const quiet = bar.slice(bar.indexOf("The near-silence"), bar.indexOf("const take ="));
    expect(quiet).toMatch(/text-muted-foreground/u);
    expect(quiet).toMatch(/title=\{answer\.caveat/u);
    expect(quiet, "the quiet state must not carry a tint").not.toMatch(/bg-clay-wash|bg-navy-wash|bg-amber-wash/u);
    expect(quiet, "the quiet state must not offer a button").not.toMatch(/<Button/u);
    /* And the loud one still exists for a genuine fault. */
    expect(bar).toMatch(/answer\.source === "unknown"[\s\S]{0,200}bg-clay-wash|bg-clay-wash/u);
  });
});

describe("update progress reports only facts the shell has", () => {
  test("release downloads report real byte progress through the audited command", async () => {
    const shell = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "newer_version.rs"),
      "utf8"
    );
    expect(shell).toMatch(/on_progress:\s*Channel<UpdateProgress>/u);
    expect(shell).toMatch(/downloaded_bytes\s*=\s*downloaded_bytes\.saturating_add/u);
    expect(shell).toMatch(/total_bytes/u);
    const download = shell.slice(
      shell.indexOf(".download_and_install("),
      shell.indexOf("/* Otherwise this machine's source")
    );
    expect(download, "the updater callbacks must not buffer progress into silence").toMatch(
      /UpdateProgress::Download/u
    );
    expect(download).not.toMatch(/\|_, _\| \{\}/u);
  });

  test("source builds stream proven stages and never invent a percentage", async () => {
    const source = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "selfbuild.rs"),
      "utf8"
    );
    const build = source.slice(
      source.indexOf("pub async fn rebuild_app"),
      source.indexOf("/// Install what was just built")
    );
    const buildCode = build.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    expect(build).toMatch(/stdout\(Stdio::piped\(\)\)/u);
    expect(build).toMatch(/read_build_stream/u);
    expect(build).toMatch(/build_stage/u);
    expect(buildCode, "buffering until completion cannot report a current stage").not.toMatch(
      /\.output\(\)/u
    );

    const bar = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "update-bar.tsx"),
      "utf8"
    );
    expect(bar).toMatch(/new Channel<UpdateProgress>/u);
    expect(bar).toMatch(/elapsedSeconds/u);
    expect(bar).toMatch(/setInterval\(tick, 1_000\)/u);
    expect(bar).toMatch(/downloaded_bytes \/ progress\.total_bytes/u);
    expect(bar).toMatch(/not a truthful percentage/u);
  });
});

describe("a repeated update check always answers the click", () => {
  test("the button reports checking and confirms an unchanged answer", async () => {
    const bar = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "update-bar.tsx"),
      "utf8"
    );
    expect(bar).toMatch(/setChecking\(true\)/u);
    expect(bar).toMatch(/Checking…/u);
    expect(bar).toMatch(/Checked again just now; the result did not change/u);
    expect(bar).toMatch(/onClick=\{\(\) => void look\(true\)\}/u);
  });
});
