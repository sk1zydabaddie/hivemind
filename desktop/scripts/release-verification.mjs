import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256, sha256File, stableJson, validateArtifactManifest, validatePayloadManifest } from "./artifact-integrity.mjs";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_ASSET_ORIGIN = "https://release-assets.githubusercontent.com";
export const PRODUCTION_RELEASE_TIER = "production";
export const UNSIGNED_BETA_RELEASE_TIER = "unsigned-beta";
export const UNSIGNED_BETA_MRR_THRESHOLD_USD = 200;
export const UNSIGNED_BETA_INSTALL_NOTICE = "Hivemind AI beta is not yet signed with a Windows publisher certificate. Windows may show ‘Microsoft Defender SmartScreen prevented an unrecognized app.’ Download only from the official Hivemind GitHub release, verify the installer SHA-256 shown below, then choose More info → Run anyway. If the source or checksum differs, do not run it.";

export function validateTrustPolicy(policy) {
  if (policy?.schema_version !== 1 || policy?.kind !== "hivemind-release-trust-policy") {
    throw new Error("release trust policy has an unsupported schema");
  }
  if (policy.release_tier !== PRODUCTION_RELEASE_TIER) {
    throw new Error("production release requires the production trust tier");
  }
  if (typeof policy.updater_public_key !== "string" || policy.updater_public_key.trim().length < 40) {
    throw new Error("production updater public key is not configured");
  }
  const subject = policy.windows_publisher?.certificate_subject;
  const thumbprint = policy.windows_publisher?.certificate_thumbprint;
  if (typeof subject !== "string" || subject.trim() === "" ||
      typeof thumbprint !== "string" || !/^[A-F0-9]{40,64}$/u.test(thumbprint)) {
    throw new Error("Windows publisher identity is not configured");
  }
  return {
    releaseTier: PRODUCTION_RELEASE_TIER,
    updaterPublicKey: policy.updater_public_key.trim(),
    publisherSubject: subject.trim(),
    publisherThumbprint: thumbprint
  };
}

export function validateUnsignedBetaTrustPolicy(policy) {
  if (policy?.schema_version !== 1 || policy?.kind !== "hivemind-release-trust-policy" ||
      policy.release_tier !== UNSIGNED_BETA_RELEASE_TIER) {
    throw new Error("unsigned beta trust policy has an unsupported schema or tier");
  }
  if (typeof policy.updater_public_key !== "string" || policy.updater_public_key.trim().length < 40) {
    throw new Error("beta updater public key is not configured");
  }
  if (policy.windows_publisher?.status !== "deferred" ||
      policy.windows_publisher?.certificate_subject !== null ||
      policy.windows_publisher?.certificate_thumbprint !== null ||
      policy.windows_publisher?.revisit_when_mrr_usd !== UNSIGNED_BETA_MRR_THRESHOLD_USD ||
      policy.install_notice !== UNSIGNED_BETA_INSTALL_NOTICE) {
    throw new Error("unsigned beta publisher deferral or install notice is not configured exactly");
  }
  return {
    releaseTier: UNSIGNED_BETA_RELEASE_TIER,
    updaterPublicKey: policy.updater_public_key.trim(),
    installNotice: policy.install_notice,
    revisitWhenMrrUsd: policy.windows_publisher.revisit_when_mrr_usd
  };
}

export async function verifyRemoteCandidate({
  candidateUrl,
  localManifestBytes,
  trustPolicy,
  releaseTier = PRODUCTION_RELEASE_TIER,
  verifyUpdaterSignature = verifyMinisign,
  inspectAuthenticode = inspectWindowsSignature,
  fetchImpl = fetch
}) {
  if (releaseTier !== PRODUCTION_RELEASE_TIER && releaseTier !== UNSIGNED_BETA_RELEASE_TIER) {
    throw new Error("release verification received an unsupported trust tier");
  }
  const trust = releaseTier === UNSIGNED_BETA_RELEASE_TIER
    ? validateUnsignedBetaTrustPolicy(trustPolicy)
    : validateTrustPolicy(trustPolicy);
  const descriptorUrl = checkedUrl(candidateUrl, undefined, true);
  const descriptor = parseJson(await downloadReleaseBytes(fetchImpl, descriptorUrl, MAX_DESCRIPTOR_BYTES), "release candidate descriptor");
  validateDescriptor(descriptor, releaseTier, trust);
  const urls = Object.fromEntries(
    ["artifact_manifest_url", "payload_manifest_url", "installer_url", "executable_url", "updater_signature_url", "updater_manifest_url"]
      .map((field) => [field, checkedUrl(descriptor[field], descriptorUrl.origin, true)])
  );
  const publicInstallerUrl = checkedUrl(descriptor.public_installer_url, undefined, false);
  const localManifest = validateArtifactManifest(parseJson(localManifestBytes, "local artifact manifest"));
  if (descriptor.artifact_id !== localManifest.artifact_id || descriptor.version !== localManifest.version ||
      descriptor.source_commit !== localManifest.source_commit || descriptor.tag_name !== `v${localManifest.version}`) {
    throw new Error("remote candidate does not name the admitted local artifact");
  }

  const work = await mkdtemp(path.join(tmpdir(), "hivemind-release-verify-"));
  try {
    const remoteManifestBytes = await downloadReleaseBytes(fetchImpl, urls.artifact_manifest_url, MAX_MANIFEST_BYTES);
    if (sha256(remoteManifestBytes) !== sha256(localManifestBytes)) {
      throw new Error("remote artifact manifest bytes differ from the admitted manifest");
    }
    const remoteManifest = validateArtifactManifest(parseJson(remoteManifestBytes, "remote artifact manifest"));
    if (stableJson(remoteManifest) !== stableJson(localManifest)) {
      throw new Error("remote artifact manifest content differs from the admitted manifest");
    }
    const files = {
      payload: path.join(work, localManifest.payload_manifest.filename),
      installer: path.join(work, localManifest.installer.filename),
      executable: path.join(work, localManifest.executable.filename),
      signature: path.join(work, `${localManifest.installer.filename}.sig`)
    };
    await writeDownloaded(fetchImpl, urls.payload_manifest_url, files.payload, MAX_MANIFEST_BYTES);
    await writeDownloaded(fetchImpl, urls.installer_url, files.installer, MAX_ARTIFACT_BYTES);
    await writeDownloaded(fetchImpl, urls.executable_url, files.executable, MAX_ARTIFACT_BYTES);
    await verifyIdentity("payload manifest", files.payload, localManifest.payload_manifest);
    await verifyIdentity("installer", files.installer, localManifest.installer);
    await verifyIdentity("executable", files.executable, localManifest.executable);
    const remotePayload = validatePayloadManifest(parseJson(await readFile(files.payload), "remote payload manifest"));
    if (remotePayload.version !== localManifest.version || remotePayload.source.commit !== localManifest.source_commit) {
      throw new Error("remote payload manifest does not belong to the admitted artifact");
    }
    const signatureBytes = await downloadReleaseBytes(fetchImpl, urls.updater_signature_url, MAX_SIGNATURE_BYTES);
    if (signatureBytes.toString("utf8") !== descriptor.updater_signature) {
      throw new Error("downloaded updater signature differs from the candidate descriptor");
    }
    const updaterManifest = parseJson(await downloadReleaseBytes(fetchImpl, urls.updater_manifest_url, MAX_DESCRIPTOR_BYTES), "remote updater manifest");
    validateUpdaterManifest(updaterManifest, localManifest, descriptor.updater_signature, publicInstallerUrl, releaseTier, trust);
    await writeFile(files.signature, descriptor.updater_signature, { encoding: "utf8", flag: "wx" });
    await verifyUpdaterSignature({ installer: files.installer, signature: files.signature, publicKey: trust.updaterPublicKey });
    for (const [label, file] of [["installer", files.installer], ["executable", files.executable]]) {
      const signature = await inspectAuthenticode(file);
      if (releaseTier === UNSIGNED_BETA_RELEASE_TIER) assertUnsignedBeta(label, signature);
      else assertAuthenticode(label, signature, trust);
    }
    return {
      artifact_id: localManifest.artifact_id,
      version: localManifest.version,
      installer_sha256: localManifest.installer.sha256,
      source_commit: localManifest.source_commit,
      tag_name: descriptor.tag_name,
      release_tier: releaseTier
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function validateDescriptor(value, releaseTier, trust) {
  if (value?.schema_version !== 3 || value?.kind !== "hivemind-release-candidate" ||
      value.release_tier !== releaseTier ||
      typeof value.artifact_id !== "string" || !/^[a-f0-9]{64}$/u.test(value.artifact_id) ||
      typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(value.version) ||
      value.tag_name !== `v${value.version}` || typeof value.source_commit !== "string" || !/^[a-f0-9]{40}$/u.test(value.source_commit) ||
      typeof value.updater_signature !== "string" || value.updater_signature.length > 16 * 1024 || value.updater_signature.trim() === "") {
    throw new Error("release candidate descriptor is incomplete");
  }
  if (releaseTier === UNSIGNED_BETA_RELEASE_TIER && value.install_notice !== trust.installNotice) {
    throw new Error("unsigned beta candidate does not carry the exact install notice");
  }
  for (const field of ["artifact_manifest_url", "payload_manifest_url", "installer_url", "executable_url", "updater_signature_url", "updater_manifest_url", "public_installer_url"]) {
    if (typeof value[field] !== "string") throw new Error(`release candidate descriptor has no ${field}`);
  }
}

function validateUpdaterManifest(value, artifact, signature, publicInstallerUrl, releaseTier, trust) {
  const platform = value?.platforms?.["windows-x86_64"];
  const expectedNotes = releaseTier === UNSIGNED_BETA_RELEASE_TIER
    ? `Unsigned beta. ${trust.installNotice}`
    : `Immutable Windows x64 artifact ${artifact.artifact_id}`;
  if (value?.version !== artifact.version || value.notes !== expectedNotes ||
      typeof value.pub_date !== "string" || !Number.isFinite(Date.parse(value.pub_date)) ||
      platform?.signature !== signature || platform?.url !== publicInstallerUrl.href) {
    throw new Error("remote updater manifest does not name the admitted signed installer");
  }
}

function checkedUrl(value, origin, allowLoopback) {
  let result;
  try { result = new URL(value); } catch { throw new Error(`release candidate contains an invalid URL: ${value}`); }
  const loopback = allowLoopback && result.protocol === "http:" && (result.hostname === "127.0.0.1" || result.hostname === "localhost");
  if (result.protocol !== "https:" && !loopback) throw new Error(`release URL is not secure: ${result}`);
  if (result.username || result.password || result.hash) throw new Error(`release URL contains forbidden credentials or fragment: ${result}`);
  if (origin !== undefined && result.origin !== origin) throw new Error("release candidate assets must share one origin");
  return result;
}

export async function downloadReleaseBytes(fetchImpl, url, maximum) {
  let response = await fetchImpl(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": "Hivemind-Release-Verifier" },
    redirect: "manual"
  });
  if (isRedirect(response.status)) {
    if (url.origin !== GITHUB_API_ORIGIN || !/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/u.test(url.pathname)) {
      throw new Error(`release download refused an unexpected redirect: ${url}`);
    }
    const destination = checkedUrl(response.headers.get("location"), undefined, false);
    if (destination.origin !== GITHUB_ASSET_ORIGIN) {
      throw new Error(`release download redirected outside GitHub's asset service: ${destination}`);
    }
    response = await fetchImpl(destination, {
      headers: { Accept: "application/octet-stream", "User-Agent": "Hivemind-Release-Verifier" },
      redirect: "error"
    });
  }
  if (!response.ok) throw new Error(`release download returned HTTP ${response.status}: ${url}`);
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maximum) throw new Error(`release download exceeds its ${maximum}-byte limit: ${url}`);
  if (!response.body) throw new Error(`release download has no body: ${url}`);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximum) {
      await reader.cancel();
      throw new Error(`release download exceeds its ${maximum}-byte limit: ${url}`);
    }
    chunks.push(Buffer.from(value));
  }
  if (received < 1) throw new Error(`release download has an invalid size: ${url}`);
  return Buffer.concat(chunks, received);
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function writeDownloaded(fetchImpl, url, destination, maximum) {
  await writeFile(destination, await downloadReleaseBytes(fetchImpl, url, maximum), { flag: "wx" });
}

async function verifyIdentity(label, file, expected) {
  const bytes = await readFile(file);
  if (bytes.length !== expected.size || await sha256File(file) !== expected.sha256) {
    throw new Error(`downloaded ${label} does not match the admitted artifact`);
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error(`${label} is not valid JSON`); }
}

function verifyMinisign({ installer, signature, publicKey }) {
  const desktopRoot = path.resolve(import.meta.dirname, "..");
  execFileSync("cargo", [
    "run", "--locked", "--quiet", "--manifest-path", path.join(desktopRoot, "src-tauri", "Cargo.toml"),
    "--package", "release_signature_verify", "--bin", "release_signature_verify", "--", installer, signature, publicKey
  ], { stdio: "pipe", windowsHide: true });
}

export function inspectWindowsSignature(file, runPowerShell = execFileSync) {
  if (!hasEmbeddedWindowsCertificate(file)) {
    return {
      Status: "NotSigned",
      Subject: null,
      Thumbprint: null,
      TimestampSubject: null,
      TimestampThumbprint: null
    };
  }
  const escaped = file.replaceAll("'", "''");
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    "[pscustomobject]@{ Status = [string]$signature.Status; Subject = $signature.SignerCertificate.Subject; Thumbprint = $signature.SignerCertificate.Thumbprint; TimestampSubject = $signature.TimeStamperCertificate.Subject; TimestampThumbprint = $signature.TimeStamperCertificate.Thumbprint } | ConvertTo-Json -Compress"
  ].join("\n");
  return JSON.parse(runPowerShell("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }));
}

function hasEmbeddedWindowsCertificate(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("Windows signature inspection refused a malformed PE image");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset > bytes.length - 24 || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error("Windows signature inspection refused a malformed PE image");
  }
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  if (optionalHeader > bytes.length - optionalHeaderSize) {
    throw new Error("Windows signature inspection refused a truncated PE optional header");
  }
  const magic = bytes.readUInt16LE(optionalHeader);
  const numberOfDirectoriesOffset = magic === 0x10b ? 92 : magic === 0x20b ? 108 : -1;
  const directoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1;
  if (numberOfDirectoriesOffset < 0 || optionalHeaderSize < numberOfDirectoriesOffset + 4) {
    throw new Error("Windows signature inspection refused an unsupported PE optional header");
  }
  const numberOfDirectories = bytes.readUInt32LE(optionalHeader + numberOfDirectoriesOffset);
  if (numberOfDirectories <= 4) return false;
  const certificateEntry = directoriesOffset + (4 * 8);
  if (optionalHeaderSize < certificateEntry + 8) {
    throw new Error("Windows signature inspection refused a truncated PE certificate directory");
  }
  const certificateOffset = bytes.readUInt32LE(optionalHeader + certificateEntry);
  const certificateSize = bytes.readUInt32LE(optionalHeader + certificateEntry + 4);
  if (certificateOffset === 0 && certificateSize === 0) return false;
  if (certificateOffset === 0 || certificateSize < 8 || certificateOffset > bytes.length - certificateSize) {
    throw new Error("Windows signature inspection refused an invalid PE certificate directory");
  }
  return true;
}

export function assertAuthenticode(label, signature, trust) {
  if (signature?.Status !== "Valid" || signature.Subject !== trust.publisherSubject || signature.Thumbprint !== trust.publisherThumbprint ||
      typeof signature.TimestampSubject !== "string" || signature.TimestampSubject === "" ||
      typeof signature.TimestampThumbprint !== "string" || signature.TimestampThumbprint === "") {
    throw new Error(`${label} does not carry the required valid, timestamped Windows publisher signature`);
  }
}

export function assertUnsignedBeta(label, signature) {
  if (signature?.Status !== "NotSigned" ||
      (signature.Subject !== null && signature.Subject !== "") ||
      (signature.Thumbprint !== null && signature.Thumbprint !== "") ||
      (signature.TimestampSubject !== null && signature.TimestampSubject !== "") ||
      (signature.TimestampThumbprint !== null && signature.TimestampThumbprint !== "")) {
    throw new Error(`${label} does not match the explicitly unsigned beta policy`);
  }
}
