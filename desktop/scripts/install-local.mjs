/* Install the build that was just produced, then PROVE it landed.
 *
 * The bug this exists for ran for two weeks and was reported three times:
 * `npm run tauri:build` writes an installer into `target/` and nothing runs it.
 * The Start menu kept opening a binary from the first install, faithfully,
 * because that was the only build ever installed. Two earlier fixes — a real
 * version string and a stray shortcut — were both true and both downstream of
 * the step that was missing entirely.
 *
 *   Building is not installing.
 *
 * The verification is the point, not the convenience. An install step that
 * silently does nothing is exactly the failure being fixed, so this compares
 * the version stamped into the freshly built binary against the version of the
 * binary that is actually installed, and fails loudly when they differ.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "win32") {
  console.error(
    "install:local runs the NSIS installer, which is Windows-only. On Linux install the .deb from target/release/bundle/deb."
  );
  process.exit(1);
}

/* What the build stamped. Written by `prepare-bundle.mjs` at build time, so a
   missing file means no build has run — which is itself the failure mode. */
const versionFile = path.join(desktopRoot, "src-tauri", "gen", "app-version.txt");
const expectedCoreBuildFile = path.join(desktopRoot, "src-tauri", "gen", "core-build-id.txt");
const expectedShellBuildFile = path.join(desktopRoot, "src-tauri", "gen", "shell-build-id.txt");
let expected;
let expectedCoreBuild;
let expectedShellBuild;
try {
  expected = (await readFile(versionFile, "utf8")).trim();
  expectedCoreBuild = (await readFile(expectedCoreBuildFile, "utf8")).trim();
  expectedShellBuild = (await readFile(expectedShellBuildFile, "utf8")).trim();
} catch {
  console.error(
    "No build to install: src-tauri/gen/app-version.txt is missing.\nRun `npm run tauri:build` first — that is the step that stamps a version."
  );
  process.exit(1);
}

const installer = path.join(
  desktopRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `Hivemind AI_${expected}_x64-setup.exe`
);
try {
  await stat(installer);
} catch {
  console.error(
    `No installer for version ${expected} at:\n  ${installer}\nThe build and the stamped version disagree; run \`npm run tauri:build\` again.`
  );
  process.exit(1);
}

console.log(`installing ${expected}`);
/* `/S` is NSIS silent mode. The installer is the one just built from this
   tree, so there is no question of what is being run. */
execFileSync(installer, ["/S"], { stdio: "inherit" });

/* ── The verification, which is the whole reason this file exists ────────── */

const installedExe = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Hivemind AI",
  "hivemind_desktop.exe"
);

/* Read the version out of the binary Windows will actually launch, via the
   same file-version resource the Start menu and the uninstall entry read.
   Asking the app would prove the app runs; asking the FILE proves the right
   bytes are on disk, which is what was wrong. */
const { stdout } = await execFileAsync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `(Get-Item ${JSON.stringify(installedExe)}).VersionInfo.FileVersion`
  ],
  { windowsHide: true }
);
const installed = stdout.trim();

if (installed !== expected) {
  console.error(
    [
      "",
      "INSTALL DID NOT TAKE.",
      `  built:     ${expected}`,
      `  installed: ${installed || "(no version could be read)"}`,
      `  path:      ${installedExe}`,
      "",
      "The installer ran and the binary on disk is not the one just built.",
      "Close any running copy of Hivemind and try again — a locked executable",
      "is the usual cause, and NSIS does not always report it."
    ].join("\n")
  );
  process.exit(1);
}

/* The executable version alone cannot see stale bundled resources. NSIS used
   to copy `core/` over the previous installation, leaving removed JavaScript
   modules behind. The executable was current while the Core it launched was
   not. Ask the CLI that is ACTUALLY installed for both identities and compare
   them with the manifests produced immediately before this installer. */
const installedCli = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Hivemind AI",
  "core",
  "dist",
  "src",
  "cli.js"
);
const installedCoreBuild = execFileSync(process.execPath, [installedCli, "build-id"], {
  cwd: desktopRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
const installedShellBuild = (
  await readFile(
    path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI", "core", "shell-build-id.txt"),
    "utf8"
  )
).trim();

if (installedCoreBuild !== expectedCoreBuild || installedShellBuild !== expectedShellBuild) {
  console.error(
    [
      "",
      "INSTALLED RUNTIME DID NOT MATCH THE BUNDLE.",
      `  Core built:       ${expectedCoreBuild}`,
      `  Core installed:   ${installedCoreBuild}`,
      `  shell built:      ${expectedShellBuild}`,
      `  shell installed:  ${installedShellBuild}`,
      "",
      "The executable version landed, but its bundled runtime did not."
    ].join("\n")
  );
  process.exit(1);
}

console.log(`installed ${installed} — executable, Core, and shell identities verified on disk`);
