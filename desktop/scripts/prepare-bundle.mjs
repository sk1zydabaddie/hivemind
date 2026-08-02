import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");
const npmEntry = process.env.npm_execpath;
if (!npmEntry) throw new Error("npm_execpath is required to prepare the desktop bundle");

execFileSync(process.execPath, [npmEntry, "run", "build"], { cwd: repoRoot, stdio: "inherit" });
const shellBuildId = execFileSync(
  process.execPath,
  [path.join(repoRoot, "dist", "src", "cli.js"), "shell-build-id"],
  { cwd: repoRoot, encoding: "utf8" }
).trim();
if (!/^[a-f0-9]{64}$/u.test(shellBuildId)) {
  throw new Error("Core returned an invalid desktop shell build identity");
}

const generatedDir = path.join(desktopRoot, "src-tauri", "gen");
await mkdir(generatedDir, { recursive: true });
await writeFile(path.join(generatedDir, "shell-build-id.txt"), `${shellBuildId}\n`, "utf8");

execFileSync(process.execPath, [npmEntry, "run", "build"], { cwd: desktopRoot, stdio: "inherit" });
