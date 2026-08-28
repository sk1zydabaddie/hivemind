import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
}

describe("read-only update discovery", () => {
  test("the plugin can check in Rust while every direct webview command is denied", async () => {
    const cargo = await readFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), "utf8");
    const main = await readFile(path.join(desktopRoot, "src-tauri", "src", "main.rs"), "utf8");
    expect(cargo).toMatch(/tauri-plugin-updater/u);
    expect(main).toMatch(/tauri_plugin_updater::Builder::new\(\)\.build\(\)/u);
    expect(main).toMatch(/\bnewer_version\b/u);

    const capability = JSON.parse(
      await readFile(path.join(desktopRoot, "src-tauri", "capabilities", "default.json"), "utf8")
    ) as { permissions: string[] };
    expect(capability.permissions.filter((permission) => permission.startsWith("updater:"))).toEqual([
      "updater:deny-check",
      "updater:deny-download",
      "updater:deny-install",
      "updater:deny-download-and-install"
    ]);

    const frontendFiles = execFileSync("git", ["ls-files", "src/**/*.ts", "src/**/*.tsx"], {
      cwd: desktopRoot,
      encoding: "utf8"
    })
      .split(/\r?\n/u)
      .filter((file) => file !== "" && existsSync(path.join(desktopRoot, file)));
    for (const file of frontendFiles) {
      const source = await readFile(path.join(desktopRoot, file), "utf8");
      expect(source, `${file} must not import the updater's direct JS API`).not.toMatch(
        /@tauri-apps\/plugin-updater/u
      );
    }
  });

  test("the endpoint has three honest read-only outcomes", async () => {
    const updater = await readFile(
      path.join(desktopRoot, "src-tauri", "src", "newer_version.rs"),
      "utf8"
    );
    for (const variant of ["None", "Release", "Unknown"]) {
      expect(updater).toMatch(new RegExp(`${variant}\\s*[{,]`, "u"));
    }
    expect(updater).toMatch(/updater\.check\(\)\.await/u);
    expect(withoutComments(updater)).not.toMatch(/download|install|source_standing|daemon_work/u);
  });

  test("an unavailable endpoint stays visible and a repeated check answers the click", async () => {
    const bar = await readFile(
      path.join(desktopRoot, "src", "components", "workspace", "update-bar.tsx"),
      "utf8"
    );
    expect(bar).toMatch(/answer\.source === "none"\) return null/u);
    expect(bar).toMatch(/Could not check for updates/u);
    expect(bar).toMatch(/not confirmation that it is current/u);
    expect(bar).toMatch(/setChecking\(true\)/u);
    expect(bar).toMatch(/Checking…/u);
    expect(bar).toMatch(/Checked again just now; the result did not change/u);
    expect(bar).toMatch(/onClick=\{\(\) => void look\(true\)\}/u);
  });

  test("the signing trust root is never committed", async () => {
    const ignore = await readFile(path.join(desktopRoot, ".gitignore"), "utf8");
    expect(ignore).toMatch(/\*\.key/u);
    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
    const keys = tracked.split(/\r?\n/u).filter((file) => /\.key$|\.key\.pub$|\.sig$/u.test(file));
    expect(keys).toEqual([]);
  });
});

describe("the shipped updater configuration", () => {
  test("the endpoint is HTTPS and no insecure transport flag ships", async () => {
    const conf = JSON.parse(
      await readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8")
    ) as {
      plugins?: { updater?: { endpoints?: string[]; dangerousInsecureTransportProtocol?: boolean } };
    };
    const updater = conf.plugins?.updater ?? {};
    for (const endpoint of updater.endpoints ?? []) {
      expect(endpoint).toMatch(/^https:\/\//u);
    }
    expect(updater.dangerousInsecureTransportProtocol).toBeUndefined();
  });

  test("obsolete local update transport and serving entries are gone", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(desktopRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["updater:serve"]).toBeUndefined();
    expect(packageJson.scripts["tauri:build:localupdate"]).toBeUndefined();
    expect(existsSync(path.join(desktopRoot, "src-tauri", "updater-dev.conf.json"))).toBe(false);
    expect(existsSync(path.join(desktopRoot, "scripts", "updater-serve.mjs"))).toBe(false);
  });
});
