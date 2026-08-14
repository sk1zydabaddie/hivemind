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

/* A version that actually changes, and the reason it has to.
 *
 * `tauri.conf.json` carried a hardcoded `0.0.0`. Every build therefore produced
 * an identically-named installer, every uninstall entry read `DisplayVersion
 * 0.0.0` forever, and Windows could not tell an upgrade from a reinstall. The
 * observed symptom was the Start menu opening an eleven-day-old build with
 * nothing anywhere indicating it was stale -- because nothing anywhere WAS
 * different.
 *
 * Calendar version, `YY.MMDD.HHmm`, because this project has no release cadence
 * to hang semver off and a date is the only thing that is honestly monotonic
 * here. Each field stays under 65536, which the Windows version resource
 * requires -- `20260814` would not, which is why the year is two digits and the
 * date is packed rather than concatenated.
 *
 * Written to a generated overlay rather than edited into the checked-in config:
 * a build must not dirty the working tree, and `tauri build --config` merges
 * this over the base.
 */
const stamp = new Date();
const pad = (value, width) => String(value).padStart(width, "0");
const version = [
  stamp.getFullYear() % 100,
  `${stamp.getMonth() + 1}${pad(stamp.getDate(), 2)}`,
  `${pad(stamp.getHours(), 2)}${pad(stamp.getMinutes(), 2)}`
].join(".");
await writeFile(
  path.join(generatedDir, "version.conf.json"),
  `${JSON.stringify({ version }, null, 2)}\n`,
  "utf8"
);
/* Readable by the app itself, so "which build am I running" is answerable from
   inside rather than from the uninstall registry. */
await writeFile(path.join(generatedDir, "app-version.txt"), `${version}\n`, "utf8");
console.log(`bundle version ${version}`);
