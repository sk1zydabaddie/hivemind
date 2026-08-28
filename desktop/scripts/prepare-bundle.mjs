import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");
const npmEntry = process.env.npm_execpath;
if (!npmEntry) throw new Error("npm_execpath is required to prepare the desktop bundle");

const runtimeManifestPath = path.join(desktopRoot, "runtime", "node-runtime.json");
const runtime = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
if (
  typeof runtime.version !== "string" ||
  runtime.platform !== "win32" ||
  runtime.arch !== "x64" ||
  !/^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/win-x64\/node\.exe$/u.test(runtime.url) ||
  !/^[a-f0-9]{64}$/u.test(runtime.sha256)
) {
  throw new Error("desktop/runtime/node-runtime.json is malformed or is not pinned to official Windows x64 Node");
}
if (process.platform !== runtime.platform || process.arch !== runtime.arch) {
  throw new Error(
    `the consumer bundle currently supports ${runtime.platform}/${runtime.arch}; received ${process.platform}/${process.arch}`
  );
}

const stagedRuntimePath = path.join(desktopRoot, "runtime", "node.exe");
if (!existsSync(stagedRuntimePath) || await sha256File(stagedRuntimePath) !== runtime.sha256) {
  const response = await fetch(runtime.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`could not download pinned Node ${runtime.version}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const receivedSha256 = sha256(bytes);
  if (receivedSha256 !== runtime.sha256) {
    throw new Error(
      `pinned Node checksum mismatch: expected ${runtime.sha256}, received ${receivedSha256}`
    );
  }
  const temporaryRuntime = `${stagedRuntimePath}.${process.pid}.tmp`;
  await writeFile(temporaryRuntime, bytes);
  await rm(stagedRuntimePath, { force: true });
  await rename(temporaryRuntime, stagedRuntimePath);
}
const stagedRuntimeVersion = execFileSync(stagedRuntimePath, ["--version"], {
  encoding: "utf8",
  windowsHide: true
}).trim();
if (stagedRuntimeVersion !== `v${runtime.version}`) {
  throw new Error(
    `pinned Node version mismatch: expected v${runtime.version}, received ${stagedRuntimeVersion}`
  );
}

execFileSync(process.execPath, [npmEntry, "run", "build"], { cwd: repoRoot, stdio: "inherit" });
const shellBuildId = execFileSync(
  process.execPath,
  [path.join(repoRoot, "dist", "src", "cli.js"), "shell-build-id"],
  { cwd: repoRoot, encoding: "utf8" }
).trim();
const coreBuildId = execFileSync(
  process.execPath,
  [path.join(repoRoot, "dist", "src", "cli.js"), "build-id"],
  { cwd: repoRoot, encoding: "utf8" }
).trim();
if (!/^[a-f0-9]{64}$/u.test(shellBuildId)) {
  throw new Error("Core returned an invalid desktop shell build identity");
}
if (!/^[a-f0-9]{64}$/u.test(coreBuildId)) {
  throw new Error("Core returned an invalid Core build identity");
}

const generatedDir = path.join(desktopRoot, "src-tauri", "gen");
await mkdir(generatedDir, { recursive: true });
await writeFile(path.join(generatedDir, "shell-build-id.txt"), `${shellBuildId}\n`, "utf8");
await writeFile(path.join(generatedDir, "core-build-id.txt"), `${coreBuildId}\n`, "utf8");

execFileSync(process.execPath, [npmEntry, "run", "build"], { cwd: desktopRoot, stdio: "inherit" });

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/* The version is NOT stamped here. It is stamped by `stamp-version.mjs`, which
   the shipping script runs before invoking the Tauri CLI -- because the CLI
   validates `--config src-tauri/gen/version.conf.json` while parsing its
   arguments, which is before it ever runs this file as `beforeBuildCommand`.
   Generating a tool's own arguments from that tool's build hook cannot work.
   See the header of `stamp-version.mjs` for what that cost. */
