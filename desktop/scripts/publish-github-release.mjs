/** Publish one already-built, installed, signed, immutable artifact through a verified draft. */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sha256File,
  stableJson,
  validateArtifactManifest,
  writeFileAtomically
} from "./artifact-integrity.mjs";
import {
  assertCurrentReleaseSource,
  createGitHubApi,
  publishDraftTransaction,
  validateReleaseChannel,
  validateReleaseEnvironment,
  validateWorkflowEnvelope
} from "./github-publication.mjs";
import { loadReleaseTrustPolicy } from "./release-policy.mjs";
import {
  assertAuthenticode,
  inspectWindowsSignature,
  validateTrustPolicy,
  verifyRemoteCandidate
} from "./release-verification.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..");
const generatedDir = path.join(desktopRoot, "src-tauri", "gen");
const releaseDir = path.join(desktopRoot, "src-tauri", "target", "release");
const nsisDir = path.join(releaseDir, "bundle", "nsis");

validateWorkflowEnvelope(process.env);
const channel = validateReleaseChannel(JSON.parse(await readFile(path.join(desktopRoot, "release", "channel.json"), "utf8")));
const manifestBytes = await readFile(path.join(generatedDir, "artifact-manifest.json"));
const manifest = validateArtifactManifest(JSON.parse(manifestBytes.toString("utf8")));
const token = validateReleaseEnvironment(process.env, channel, manifest.source_commit);
assertCurrentReleaseSource(manifest.source_commit, channel, git);

const trustPolicy = await loadReleaseTrustPolicy(desktopRoot);
const trust = validateTrustPolicy(trustPolicy);
await validateInstallReceipt(manifest);

const publicationDir = path.join(generatedDir, "publication");
await rm(publicationDir, { recursive: true, force: true });
await mkdir(publicationDir, { recursive: true });
const names = publicNames(manifest.version);
const sourceFiles = {
  artifact: path.join(generatedDir, "artifact-manifest.json"),
  payload: path.join(nsisDir, manifest.payload_manifest.filename),
  installer: path.join(nsisDir, manifest.installer.filename),
  executable: path.join(generatedDir, "signed-hivemind_desktop.exe")
};
await Promise.all([
  verifyIdentity("payload manifest", sourceFiles.payload, manifest.payload_manifest),
  verifyIdentity("installer", sourceFiles.installer, manifest.installer),
  verifyIdentity("signed executable", sourceFiles.executable, manifest.executable)
]);
for (const [label, file] of [["installer", sourceFiles.installer], ["executable", sourceFiles.executable]]) {
  assertAuthenticode(label, inspectWindowsSignature(file), trust);
}

const publicInstaller = path.join(publicationDir, names.installer);
await copyFile(sourceFiles.installer, publicInstaller);
const signature = await signUpdater(publicInstaller, trust.updaterPublicKey);
const publicInstallerUrl = `https://github.com/${channel.repository}/releases/download/v${manifest.version}/${names.installer}`;
const updaterManifestBytes = Buffer.from(stableJson({
  version: manifest.version,
  notes: `Immutable Windows x64 artifact ${manifest.artifact_id}`,
  pub_date: new Date(manifest.generated_at_ms).toISOString(),
  platforms: {
    "windows-x86_64": { signature, url: publicInstallerUrl }
  }
}));

const assets = [
  await asset("artifact", names.artifact, "application/json", sourceFiles.artifact),
  await asset("payload", names.payload, "application/json", sourceFiles.payload),
  await asset("installer", names.installer, "application/vnd.microsoft.portable-executable", publicInstaller),
  await asset("executable", names.executable, "application/vnd.microsoft.portable-executable", sourceFiles.executable),
  { role: "signature", name: names.signature, contentType: "text/plain", bytes: Buffer.from(signature) },
  { role: "updater", name: "latest.json", contentType: "application/json", bytes: updaterManifestBytes }
];
const api = createGitHubApi({ channel, token });
const result = await publishDraftTransaction({
  api,
  manifest,
  assets,
  buildDescriptor(uploaded) {
    return {
      schema_version: 2,
      kind: "hivemind-release-candidate",
      artifact_id: manifest.artifact_id,
      version: manifest.version,
      tag_name: `v${manifest.version}`,
      source_commit: manifest.source_commit,
      artifact_manifest_url: uploaded.get("artifact").url,
      payload_manifest_url: uploaded.get("payload").url,
      installer_url: uploaded.get("installer").url,
      executable_url: uploaded.get("executable").url,
      updater_signature_url: uploaded.get("signature").url,
      updater_manifest_url: uploaded.get("updater").url,
      public_installer_url: uploaded.get("installer").browser_download_url,
      updater_signature: signature
    };
  },
  async verifyDraft(candidateUrl) {
    await verifyRemoteCandidate({
      candidateUrl,
      localManifestBytes: manifestBytes,
      trustPolicy,
      fetchImpl: api.authorizedFetch
    });
    assertCurrentReleaseSource(manifest.source_commit, channel, git);
  }
});
await writeFileAtomically(path.join(generatedDir, "publication-receipt.json"), stableJson({
  schema_version: 1,
  kind: "hivemind-github-publication-receipt",
  ...result,
  source_commit: manifest.source_commit,
  published_at_ms: Date.now()
}));
console.log(`published verified release ${result.tag_name}: artifact ${result.artifact_id}, release ${result.release_id}`);

function publicNames(version) {
  return {
    artifact: `Hivemind-AI_${version}_x64-artifact.json`,
    payload: `Hivemind-AI_${version}_x64-payload.json`,
    installer: `Hivemind-AI_${version}_x64-setup.exe`,
    executable: `Hivemind-AI_${version}_x64.exe`,
    signature: `Hivemind-AI_${version}_x64-setup.exe.sig`
  };
}

async function asset(role, name, contentType, file) {
  return { role, name, contentType, bytes: await readFile(file) };
}

async function verifyIdentity(label, file, expected) {
  const details = await stat(file);
  if (!details.isFile() || details.size !== expected.size || await sha256File(file) !== expected.sha256) {
    throw new Error(`${label} does not match the admitted artifact`);
  }
}

async function validateInstallReceipt(artifact) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path.join(generatedDir, "install-receipt.json"), "utf8"));
  } catch {
    throw new Error("the exact admitted artifact has not passed local installation verification");
  }
  if (receipt?.schema_version !== 1 || receipt?.kind !== "hivemind-local-install-receipt" ||
      receipt.artifact_id !== artifact.artifact_id || receipt.version !== artifact.version ||
      receipt.source_commit !== artifact.source_commit || receipt.installed_executable_sha256 !== artifact.executable.sha256) {
    throw new Error("local installation receipt belongs to another artifact");
  }
}

async function signUpdater(installer, publicKey) {
  if (typeof process.env.TAURI_SIGNING_PRIVATE_KEY !== "string" || process.env.TAURI_SIGNING_PRIVATE_KEY === "" ||
      typeof process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== "string" || process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === "") {
    throw new Error("protected updater signing key and password are unavailable");
  }
  const tauriCli = path.join(desktopRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const signatureFile = `${installer}.sig`;
  await rm(signatureFile, { force: true });
  execFileSync(process.execPath, [tauriCli, "signer", "sign", installer], {
    cwd: desktopRoot,
    env: process.env,
    stdio: "pipe",
    windowsHide: true
  });
  const signature = await readFile(signatureFile, "utf8");
  if (signature.trim() === "" || signature.length > 16 * 1024) throw new Error("updater signer produced an invalid signature");
  execFileSync("cargo", [
    "run", "--locked", "--quiet", "--manifest-path", path.join(desktopRoot, "src-tauri", "Cargo.toml"),
    "--package", "release_signature_verify", "--bin", "release_signature_verify", "--", installer, signatureFile, publicKey
  ], { cwd: desktopRoot, stdio: "pipe", windowsHide: true });
  return signature;
}

function git(args) {
  try { return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true }); }
  catch { throw new Error(`release provenance check failed: git ${args.join(" ")}`); }
}
