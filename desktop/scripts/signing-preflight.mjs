/** Produce a Tauri signing overlay only from a usable trusted publisher cert. */
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson, writeFileAtomically } from "./artifact-integrity.mjs";
import { validateTrustPolicy } from "./release-verification.mjs";

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) await main();

export function validatePublisherCertificate(certificate, policy, nowMs) {
  if (certificate?.Subject !== policy.publisherSubject || certificate?.Thumbprint !== policy.publisherThumbprint ||
      certificate.HasPrivateKey !== true || certificate.CodeSigning !== true ||
      !Number.isFinite(Date.parse(certificate.NotBefore)) || !Number.isFinite(Date.parse(certificate.NotAfter)) ||
      Date.parse(certificate.NotBefore) > nowMs || Date.parse(certificate.NotAfter) <= nowMs) {
    throw new Error("trusted Windows publisher certificate is missing, expired, mismatched, or has no usable private key");
  }
}

export function isSecureTimestampUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function inspectCertificate(thumbprint) {
  const escaped = thumbprint.replaceAll("'", "''");
  const script = [
    `$certificate = Get-ChildItem -LiteralPath 'Cert:\\CurrentUser\\My\\${escaped}' -ErrorAction Stop`,
    "$codeSigning = @($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -eq 1",
    "[pscustomobject]@{ Subject = $certificate.Subject; Thumbprint = $certificate.Thumbprint; HasPrivateKey = $certificate.HasPrivateKey; CodeSigning = $codeSigning; NotBefore = $certificate.NotBefore.ToUniversalTime().ToString('o'); NotAfter = $certificate.NotAfter.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress"
  ].join("\n");
  try {
    return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }));
  } catch {
    throw new Error("trusted Windows publisher certificate is not available in CurrentUser\\My");
  }
}

async function main() {
  const desktopRoot = path.resolve(path.dirname(scriptPath), "..");
  const policy = validateTrustPolicy(JSON.parse(await readFile(path.join(desktopRoot, "release", "trust-policy.json"), "utf8")));
  const timestampUrl = process.env.HIVEMIND_WINDOWS_TIMESTAMP_URL;
  if (typeof timestampUrl !== "string" || !isSecureTimestampUrl(timestampUrl)) {
    throw new Error("HIVEMIND_WINDOWS_TIMESTAMP_URL must be a credential-free HTTPS URL");
  }
  const certificate = inspectCertificate(policy.publisherThumbprint);
  validatePublisherCertificate(certificate, policy, Date.now());
  const buildContext = JSON.parse(await readFile(path.join(desktopRoot, "src-tauri", "gen", "build-context.json"), "utf8"));
  const signingScript = path.join(desktopRoot, "scripts", "windows-sign.mjs");
  const overlay = {
    bundle: {
      windows: {
        signCommand: {
          cmd: process.execPath,
          args: [signingScript, policy.publisherThumbprint, timestampUrl, "%1"]
        }
      }
    }
  };
  const signingContext = {
    schema_version: 1,
    kind: "hivemind-windows-signing-context",
    version: buildContext.version,
    source_commit: buildContext.source_commit,
    publisher_subject: policy.publisherSubject,
    publisher_thumbprint: policy.publisherThumbprint,
    timestamp_url: timestampUrl
  };
  await rm(path.join(desktopRoot, "src-tauri", "gen", "signed-hivemind_desktop.exe"), { force: true });
  await writeFileAtomically(path.join(desktopRoot, "src-tauri", "gen", "signing.conf.json"), stableJson(overlay));
  await writeFileAtomically(path.join(desktopRoot, "src-tauri", "gen", "signing-context.json"), stableJson(signingContext));
  console.log(`Windows publisher preflight passed for ${policy.publisherSubject}; signing overlay written without private-key material`);
}
