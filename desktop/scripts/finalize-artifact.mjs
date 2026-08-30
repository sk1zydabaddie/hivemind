/** Bind the built executable and NSIS installer to the clean payload manifest. */
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_SCHEMA_VERSION,
  nsisExecutableIdentity,
  sha256,
  sha256File,
  stableJson,
  validateArtifactManifest,
  validatePayloadManifest,
  WINDOWS_PLATFORM,
  writeFileAtomically
} from "./artifact-integrity.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");
const generatedDir = path.join(desktopRoot, "src-tauri", "gen");
const releaseDir = path.join(desktopRoot, "src-tauri", "target", "release");
const nsisDir = path.join(releaseDir, "bundle", "nsis");
const context = JSON.parse(await readFile(path.join(generatedDir, "build-context.json"), "utf8"));
const payloadBytes = await readFile(path.join(generatedDir, "payload-manifest.json"));
const payload = validatePayloadManifest(JSON.parse(payloadBytes.toString("utf8")));
const rustAdvisory = JSON.parse(await readFile(path.join(generatedDir, "rust-advisory.json"), "utf8"));
if (rustAdvisory.lockfile_sha256 !== await sha256File(path.join(desktopRoot, "src-tauri", "Cargo.lock")) ||
    rustAdvisory.vulnerability_count !== 0) {
  throw new Error("Rust advisory evidence is stale or did not pass for the admitted Cargo.lock");
}
assertCurrentSource(context.source_commit);
if (payload.version !== context.version || payload.source.commit !== context.source_commit) {
  throw new Error("the built payload does not belong to the current stamped source");
}

const installerFilename = `Hivemind AI_${context.version}_x64-setup.exe`;
const executableFilename = "hivemind_desktop.exe";
const payloadFilename = `Hivemind AI_${context.version}_x64-payload.json`;
const artifactFilename = `Hivemind AI_${context.version}_x64-artifact.json`;
const installer = path.join(nsisDir, installerFilename);
const executable = path.join(releaseDir, executableFilename);
const executableIdentity = await finalExecutableIdentity(executable, context);
const installedVersion = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${executable.replaceAll("'", "''")}').VersionInfo.FileVersion`],
  { encoding: "utf8", windowsHide: true }
).trim();
if (installedVersion !== context.version) {
  throw new Error(`built executable version ${installedVersion} does not match stamp ${context.version}`);
}

const base = {
  schema_version: ARTIFACT_SCHEMA_VERSION,
  kind: "hivemind-windows-artifact",
  platform: WINDOWS_PLATFORM,
  version: context.version,
  generated_at_ms: context.generated_at_ms,
  source_commit: context.source_commit,
  rust_advisory: rustAdvisory,
  payload_manifest: await fileIdentity(path.join(generatedDir, "payload-manifest.json"), payloadFilename),
  installer: await fileIdentity(installer, installerFilename),
  executable: executableIdentity
};
const manifest = { ...base, artifact_id: sha256(stableJson(base)) };
validateArtifactManifest(manifest);
const manifestBytes = stableJson(manifest);
await writeFileAtomically(path.join(nsisDir, payloadFilename), payloadBytes);
await writeFileAtomically(path.join(nsisDir, artifactFilename), manifestBytes);
await writeFileAtomically(path.join(generatedDir, "artifact-manifest.json"), manifestBytes);
console.log(`admitted local artifact ${manifest.artifact_id} (${installerFilename})`);

async function fileIdentity(file, filename) {
  const details = await stat(file);
  if (!details.isFile() || details.size < 1) throw new Error(`artifact file is missing: ${file}`);
  return { filename, size: details.size, sha256: await sha256File(file) };
}

async function finalExecutableIdentity(file, buildContext) {
  const source = await nsisExecutableIdentity(file, executableFilename);
  let signingContext;
  try {
    signingContext = JSON.parse(await readFile(path.join(generatedDir, "signing-context.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return source;
    throw error;
  }
  if (signingContext.version !== buildContext.version || signingContext.source_commit !== buildContext.source_commit) {
    return source;
  }
  const signedFile = path.join(generatedDir, "signed-hivemind_desktop.exe");
  const signed = await fileIdentity(signedFile, executableFilename);
  return {
    ...signed,
    bundle_type: "nsis",
    source_size: source.source_size,
    source_sha256: source.source_sha256
  };
}

function assertCurrentSource(sourceCommit) {
  if (git(["rev-parse", "HEAD"]).trim() !== sourceCommit) throw new Error("HEAD changed during artifact assembly");
  git(["diff", "--quiet"]);
  git(["diff", "--cached", "--quiet"]);
  if (git(["ls-files", "--others", "--exclude-standard", "-z"]) !== "") {
    throw new Error("release source became dirty during artifact assembly");
  }
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  } catch {
    throw new Error(`artifact provenance check failed: git ${args.join(" ")}`);
  }
}
