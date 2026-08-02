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
        targets?: string[];
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
    expect(config.bundle?.targets).toContain("nsis");
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
