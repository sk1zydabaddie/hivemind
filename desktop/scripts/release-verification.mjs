import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256, sha256File, stableJson, validateArtifactManifest, validatePayloadManifest } from "./artifact-integrity.mjs";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export function validateTrustPolicy(policy) {
  if (policy?.schema_version !== 1 || policy?.kind !== "hivemind-release-trust-policy") {
    throw new Error("release trust policy has an unsupported schema");
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
    updaterPublicKey: policy.updater_public_key.trim(),
    publisherSubject: subject.trim(),
    publisherThumbprint: thumbprint
  };
}

export async function verifyRemoteCandidate({
  candidateUrl,
  localManifestBytes,
  trustPolicy,
  verifyUpdaterSignature = verifyMinisign,
  inspectAuthenticode = inspectWindowsSignature,
  fetchImpl = fetch
}) {
  const trust = validateTrustPolicy(trustPolicy);
  const descriptorUrl = checkedUrl(candidateUrl, undefined, true);
  const descriptor = parseJson(await download(fetchImpl, descriptorUrl, MAX_DESCRIPTOR_BYTES), "release candidate descriptor");
  validateDescriptor(descriptor);
  const urls = Object.fromEntries(
    ["artifact_manifest_url", "payload_manifest_url", "installer_url", "executable_url"]
      .map((field) => [field, checkedUrl(descriptor[field], descriptorUrl.origin, true)])
  );
  const localManifest = validateArtifactManifest(parseJson(localManifestBytes, "local artifact manifest"));
  if (descriptor.artifact_id !== localManifest.artifact_id || descriptor.version !== localManifest.version) {
    throw new Error("remote candidate does not name the admitted local artifact");
  }

  const work = await mkdtemp(path.join(tmpdir(), "hivemind-release-verify-"));
  try {
    const remoteManifestBytes = await download(fetchImpl, urls.artifact_manifest_url, MAX_MANIFEST_BYTES);
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
    validatePayloadManifest(parseJson(await readFile(files.payload), "remote payload manifest"));
    await writeFile(files.signature, descriptor.updater_signature, { encoding: "utf8", flag: "wx" });
    await verifyUpdaterSignature({ installer: files.installer, signature: files.signature, publicKey: trust.updaterPublicKey });
    for (const [label, file] of [["installer", files.installer], ["executable", files.executable]]) {
      assertAuthenticode(label, await inspectAuthenticode(file), trust);
    }
    return {
      artifact_id: localManifest.artifact_id,
      version: localManifest.version,
      installer_sha256: localManifest.installer.sha256,
      source_commit: localManifest.source_commit
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function validateDescriptor(value) {
  if (value?.schema_version !== 1 || value?.kind !== "hivemind-release-candidate" ||
      typeof value.artifact_id !== "string" || !/^[a-f0-9]{64}$/u.test(value.artifact_id) ||
      typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(value.version) ||
      typeof value.updater_signature !== "string" || value.updater_signature.length > 16 * 1024 || value.updater_signature.trim() === "") {
    throw new Error("release candidate descriptor is incomplete");
  }
  for (const field of ["artifact_manifest_url", "payload_manifest_url", "installer_url", "executable_url"]) {
    if (typeof value[field] !== "string") throw new Error(`release candidate descriptor has no ${field}`);
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

async function download(fetchImpl, url, maximum) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": "Hivemind-Release-Verifier" },
    redirect: "error"
  });
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

async function writeDownloaded(fetchImpl, url, destination, maximum) {
  await writeFile(destination, await download(fetchImpl, url, maximum), { flag: "wx" });
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
    "--bin", "release_signature_verify", "--", installer, signature, publicKey
  ], { stdio: "pipe", windowsHide: true });
}

export function inspectWindowsSignature(file) {
  const escaped = file.replaceAll("'", "''");
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    "[pscustomobject]@{ Status = [string]$signature.Status; Subject = $signature.SignerCertificate.Subject; Thumbprint = $signature.SignerCertificate.Thumbprint; TimestampSubject = $signature.TimeStamperCertificate.Subject; TimestampThumbprint = $signature.TimeStamperCertificate.Thumbprint } | ConvertTo-Json -Compress"
  ].join("\n");
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }));
}

export function assertAuthenticode(label, signature, trust) {
  if (signature?.Status !== "Valid" || signature.Subject !== trust.publisherSubject || signature.Thumbprint !== trust.publisherThumbprint ||
      typeof signature.TimestampSubject !== "string" || signature.TimestampSubject === "" ||
      typeof signature.TimestampThumbprint !== "string" || signature.TimestampThumbprint === "") {
    throw new Error(`${label} does not carry the required valid, timestamped Windows publisher signature`);
  }
}
