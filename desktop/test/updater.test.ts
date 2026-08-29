import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");

describe("retired updater trust root", () => {
  test("no production source or manifest retains the legacy updater", async () => {
    const tracked = execFileSync("git", ["ls-files", "src", "src-tauri", "package.json"], {
      cwd: desktopRoot,
      encoding: "utf8"
    })
      .split(/\r?\n/u)
      .filter((file) => file !== "" && existsSync(path.join(desktopRoot, file)));

    for (const file of tracked) {
      const source = await readFile(path.join(desktopRoot, file), "utf8");
      expect(source, `${file} retains the retired updater trust path`).not.toMatch(
        /tauri.plugin.updater|plugin-updater|updater:|newer_version|take_newer_version|download_and_install|source_standing/iu
      );
    }
  });

  test("the signing trust root is never committed", async () => {
    const ignore = await readFile(path.join(desktopRoot, ".gitignore"), "utf8");
    expect(ignore).toMatch(/\*\.key/u);
    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
    const keys = tracked.split(/\r?\n/u).filter((file) => /\.key$|\.key\.pub$|\.sig$/u.test(file));
    expect(keys).toEqual([]);
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
