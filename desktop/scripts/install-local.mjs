/** Install one admitted local artifact and verify every managed installed byte. */
import { execFile, execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  nsisExecutableIdentity,
  sha256File,
  validateArtifactManifest,
  validatePayloadManifest,
  verifyManagedInventory
} from "./artifact-integrity.mjs";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = path.join(desktopRoot, "src-tauri", "gen");
const releaseDir = path.join(desktopRoot, "src-tauri", "target", "release");
const nsisDir = path.join(releaseDir, "bundle", "nsis");
if (process.platform !== "win32") throw new Error("install:local supports only the qualified Windows x64 artifact");

const artifact = validateArtifactManifest(
  JSON.parse(await readFile(path.join(generatedDir, "artifact-manifest.json"), "utf8"))
);
const payloadFile = path.join(nsisDir, artifact.payload_manifest.filename);
const installer = path.join(nsisDir, artifact.installer.filename);
const builtExecutable = path.join(releaseDir, artifact.executable.filename);
const payload = validatePayloadManifest(JSON.parse(await readFile(payloadFile, "utf8")));
if (payload.version !== artifact.version || payload.source.commit !== artifact.source_commit) {
  throw new Error("artifact and payload manifests describe different source");
}
for (const [label, file, identity] of [
  ["payload manifest", payloadFile, artifact.payload_manifest],
  ["installer", installer, artifact.installer]
]) {
  await verifyFileIdentity(label, file, identity);
}
const builtExecutableIdentity = await nsisExecutableIdentity(builtExecutable, artifact.executable.filename);
for (const field of ["filename", "bundle_type", "size", "source_sha256", "sha256"]) {
  if (builtExecutableIdentity[field] !== artifact.executable[field]) {
    throw new Error(`built executable ${field} does not match the admitted NSIS transformation`);
  }
}

console.log(`installing admitted artifact ${artifact.artifact_id} (${artifact.version})`);
execFileSync(installer, ["/S"], { stdio: "inherit", windowsHide: true });

const installedRoot = path.join(process.env.LOCALAPPDATA ?? "", "Hivemind AI");
const installedExe = path.join(installedRoot, "hivemind_desktop.exe");
await verifyFileIdentity("installed executable", installedExe, artifact.executable);
const installedPayloadFile = path.join(installedRoot, "artifact", "payload-manifest.json");
await verifyFileIdentity("installed payload manifest", installedPayloadFile, artifact.payload_manifest);
const installedPayload = validatePayloadManifest(JSON.parse(await readFile(installedPayloadFile, "utf8")));
if (installedPayload.source.commit !== artifact.source_commit || installedPayload.version !== artifact.version) {
  throw new Error("installed payload manifest describes a different source or version");
}
await verifyManagedInventory(installedRoot, payload.files);

const installedVersion = await windowsFileVersion(installedExe);
if (installedVersion !== artifact.version) {
  throw new Error(`installed executable version ${installedVersion} does not match ${artifact.version}`);
}
const installedRuntime = path.join(installedRoot, "runtime", "node.exe");
const installedCli = path.join(installedRoot, "core", "dist", "src", "cli.js");
const installedCoreBuild = execFileSync(installedRuntime, [installedCli, "build-id"], {
  cwd: desktopRoot,
  encoding: "utf8",
  windowsHide: true
}).trim();
const installedRuntimeVersion = execFileSync(installedRuntime, ["--version"], {
  encoding: "utf8",
  windowsHide: true
}).trim();
if (installedCoreBuild !== payload.build.core_build_id ||
    installedRuntimeVersion !== `v${payload.build.runtime.version}` ||
    await sha256File(installedRuntime) !== payload.build.runtime.sha256) {
  throw new Error("installed executable identities do not match the admitted payload");
}

console.log(
  `installed ${artifact.version} — artifact ${artifact.artifact_id}, ${payload.files.length} managed files, Core, shell, and Node identities verified`
);

async function verifyFileIdentity(label, file, expected) {
  const details = await stat(file);
  const hash = await sha256File(file);
  if (!details.isFile() || details.size !== expected.size || hash !== expected.sha256) {
    throw new Error(`${label} does not match the admitted artifact: ${file}`);
  }
}

async function windowsFileVersion(file) {
  const escaped = file.replaceAll("'", "''");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`],
    { windowsHide: true }
  );
  return stdout.trim();
}
