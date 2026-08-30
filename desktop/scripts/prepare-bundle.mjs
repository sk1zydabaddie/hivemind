import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inventoryManagedRoots,
  PAYLOAD_SCHEMA_VERSION,
  sha256,
  sha256File,
  stableJson,
  validatePayloadManifest,
  WINDOWS_PLATFORM,
  writeFileAtomically
} from "./artifact-integrity.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");
const generatedDir = path.join(desktopRoot, "src-tauri", "gen");
const bundleDir = path.join(generatedDir, "bundle");
const candidateDir = path.join(generatedDir, `bundle-candidate-${process.pid}`);
const npmEntry = process.env.npm_execpath;
if (!npmEntry) throw new Error("npm_execpath is required to prepare the desktop bundle");

const context = JSON.parse(await readFile(path.join(generatedDir, "build-context.json"), "utf8"));
assertBuildContext(context);
assertCurrentSource(context.source_commit);

const runtimeManifestPath = path.join(desktopRoot, "runtime", "node-runtime.json");
const runtime = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
validateRuntime(runtime);
if (process.platform !== runtime.platform || process.arch !== runtime.arch) {
  throw new Error(`the qualified consumer bundle supports ${runtime.platform}/${runtime.arch}; received ${process.platform}/${process.arch}`);
}

const stagedRuntimePath = path.join(desktopRoot, "runtime", "node.exe");
await ensurePinnedRuntime(stagedRuntimePath, runtime);

execNpm(["run", "build"], repoRoot);
const cli = path.join(repoRoot, "dist", "src", "cli.js");
const shellBuildId = execFileSync(process.execPath, [cli, "shell-build-id"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
const coreBuildId = execFileSync(process.execPath, [cli, "build-id"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
for (const [name, value] of [["Core", coreBuildId], ["desktop shell", shellBuildId]]) {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} returned an invalid build identity`);
}

await rm(candidateDir, { recursive: true, force: true });
try {
  const core = path.join(candidateDir, "core");
  const candidateRuntime = path.join(candidateDir, "runtime");
  await mkdir(core, { recursive: true });
  await mkdir(candidateRuntime, { recursive: true });
  for (const filename of ["package.json", "package-lock.json"]) {
    await cp(path.join(repoRoot, filename), path.join(core, filename));
  }
  execNpm(["ci", "--omit=dev", "--no-audit", "--no-fund"], core);
  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  for (const dependency of Object.keys(rootPackage.devDependencies ?? {})) {
    try {
      await stat(path.join(core, "node_modules", ...dependency.split("/")));
      throw new Error(`clean production staging retained development dependency ${dependency}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (await sha256File(path.join(core, "package-lock.json")) !== await sha256File(path.join(repoRoot, "package-lock.json"))) {
    throw new Error("npm ci changed the admitted Core lockfile");
  }
  await cp(path.join(repoRoot, "dist"), path.join(core, "dist"), { recursive: true });
  await writeFileAtomically(path.join(core, "core-build-id.txt"), `${coreBuildId}\n`);
  await writeFileAtomically(path.join(core, "shell-build-id.txt"), `${shellBuildId}\n`);
  await cp(runtimeManifestPath, path.join(candidateRuntime, "node-runtime.json"));
  await cp(stagedRuntimePath, path.join(candidateRuntime, "node.exe"));

  execNpm(["run", "build"], desktopRoot);
  assertCurrentSource(context.source_commit);

  const sourceInputs = await buildInputInventory();
  const lockfiles = {};
  for (const relative of ["package-lock.json", "desktop/package-lock.json", "desktop/src-tauri/Cargo.lock"]) {
    lockfiles[relative] = await sha256File(path.join(repoRoot, ...relative.split("/")));
  }
  const files = await inventoryManagedRoots(candidateDir);
  const payload = {
    schema_version: PAYLOAD_SCHEMA_VERSION,
    kind: "hivemind-payload",
    platform: WINDOWS_PLATFORM,
    version: context.version,
    generated_at_ms: context.generated_at_ms,
    source: {
      commit: context.source_commit,
      clean: true,
      input_tree_sha256: sha256(stableJson(sourceInputs)),
      inputs: sourceInputs,
      lockfiles
    },
    build: {
      core_build_id: coreBuildId,
      shell_build_id: shellBuildId,
      runtime: { version: runtime.version, sha256: runtime.sha256 }
    },
    files
  };
  validatePayloadManifest(payload);
  await rm(bundleDir, { recursive: true, force: true });
  await rename(candidateDir, bundleDir);
  await writeFileAtomically(path.join(generatedDir, "payload-manifest.json"), stableJson(payload));
  console.log(`prepared clean payload: ${files.length} files from ${sourceInputs.length} source inputs`);
} catch (error) {
  await rm(candidateDir, { recursive: true, force: true });
  throw error;
}

async function ensurePinnedRuntime(runtimePath, manifest) {
  let valid = false;
  try {
    valid = await sha256File(runtimePath) === manifest.sha256;
  } catch { /* download below */ }
  if (!valid) {
    const response = await fetch(manifest.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`could not download pinned Node ${manifest.version}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== manifest.sha256) throw new Error("pinned Node checksum mismatch");
    await writeFileAtomically(runtimePath, bytes);
  }
  const version = execFileSync(runtimePath, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  if (version !== `v${manifest.version}`) throw new Error(`pinned Node version mismatch: received ${version}`);
}

async function buildInputInventory() {
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean).filter(isBuildInput).sort();
  const entries = [];
  for (const relative of tracked) {
    const file = path.join(repoRoot, ...relative.split("/"));
    const details = await stat(file);
    entries.push({ path: relative, size: details.size, sha256: await sha256File(file) });
  }
  return entries;
}

function isBuildInput(relative) {
  return relative.startsWith("src/") ||
    relative.startsWith("desktop/src/") ||
    relative.startsWith("desktop/scripts/") ||
    relative.startsWith("desktop/runtime/") ||
    relative.startsWith("desktop/src-tauri/") ||
    relative === "package.json" || relative === "package-lock.json" ||
    relative.startsWith("tsconfig") || relative === "tools/clean-dist.mjs" ||
    relative === "desktop/index.html" ||
    relative === "desktop/package.json" || relative === "desktop/package-lock.json" ||
    relative.startsWith("desktop/tsconfig") || relative === "desktop/vite.config.ts";
}

function assertBuildContext(value) {
  if (value?.schema_version !== 1 || value?.platform !== WINDOWS_PLATFORM ||
      typeof value.version !== "string" || !Number.isSafeInteger(value.generated_at_ms) ||
      !/^[a-f0-9]{40,64}$/u.test(value.source_commit ?? "")) {
    throw new Error("generated build context is missing or malformed; run bundle:stamp first");
  }
}

function assertCurrentSource(sourceCommit) {
  const current = git(["rev-parse", "HEAD"]).trim();
  if (current !== sourceCommit) throw new Error("HEAD changed after the release version was allocated");
  git(["diff", "--quiet"]);
  git(["diff", "--cached", "--quiet"]);
  if (git(["ls-files", "--others", "--exclude-standard", "-z"]) !== "") {
    throw new Error("release source became dirty after the release version was allocated");
  }
}

function validateRuntime(value) {
  if (typeof value.version !== "string" || value.platform !== "win32" || value.arch !== "x64" ||
      !/^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/win-x64\/node\.exe$/u.test(value.url) ||
      !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error("node-runtime.json is not an official pinned Windows x64 runtime");
  }
}

function execNpm(args, cwd) {
  execFileSync(process.execPath, [npmEntry, ...args], { cwd, stdio: "inherit", windowsHide: true });
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  } catch {
    throw new Error(`release source check failed: git ${args.join(" ")}`);
  }
}
