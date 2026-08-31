import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sha256, stableJson } from "../scripts/artifact-integrity.mjs";
import {
  downloadReleaseBytes,
  inspectWindowsSignature,
  UNSIGNED_BETA_INSTALL_NOTICE,
  validateTrustPolicy,
  validateUnsignedBetaTrustPolicy,
  verifyRemoteCandidate
} from "../scripts/release-verification.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("release verification", () => {
  test("an unsigned PE is identified without loading the PowerShell security module", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hivemind-unsigned-pe-test-"));
    const file = path.join(root, "unsigned.exe");
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(file, unsignedPeFixture());
    const runPowerShell = vi.fn(() => { throw new Error("PowerShell security module is unavailable"); });

    expect(inspectWindowsSignature(file, runPowerShell)).toEqual(unsignedWindowsSignature());
    expect(runPowerShell).not.toHaveBeenCalled();
  });

  test("a PE certificate table still requires the full PowerShell signature identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hivemind-signed-pe-test-"));
    const file = path.join(root, "signed.exe");
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(file, peFixture({ certificateOffset: 0x180, certificateSize: 8 }));
    const expected = validWindowsSignature();
    const runPowerShell = vi.fn(() => JSON.stringify(expected));

    expect(inspectWindowsSignature(file, runPowerShell)).toEqual(expected);
    expect(runPowerShell).toHaveBeenCalledTimes(1);
  });

  test("a partial PE certificate directory fails closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hivemind-invalid-pe-test-"));
    const file = path.join(root, "partial.exe");
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(file, peFixture({ certificateOffset: 0x180, certificateSize: 0 }));
    const runPowerShell = vi.fn();

    expect(() => inspectWindowsSignature(file, runPowerShell)).toThrow("invalid PE certificate directory");
    expect(runPowerShell).not.toHaveBeenCalled();
  });

  test("the production policy fails closed instead of carrying placeholder trust", async () => {
    const policy = JSON.parse(await readFile(path.resolve(import.meta.dirname, "..", "release", "trust-policy.json"), "utf8"));
    expect(() => validateTrustPolicy(policy)).toThrow("production updater public key is not configured");
  });

  test("downloads and verifies only the exact admitted candidate", async () => {
    const fixture = await candidateFixture();
    const verifyUpdaterSignature = vi.fn(async () => undefined);
    const inspectAuthenticode = vi.fn(async () => validWindowsSignature());
    const result = await verifyRemoteCandidate({
      candidateUrl: fixture.url,
      localManifestBytes: fixture.manifestBytes,
      trustPolicy: configuredPolicy(),
      verifyUpdaterSignature,
      inspectAuthenticode
    });
    expect(result.artifact_id).toBe(fixture.manifest.artifact_id);
    expect(verifyUpdaterSignature).toHaveBeenCalledOnce();
    expect(inspectAuthenticode).toHaveBeenCalledTimes(2);
  });

  test("an updater-signed beta is admitted only when both Windows files are explicitly unsigned", async () => {
    const fixture = await candidateFixture({ releaseTier: "unsigned-beta" });
    const verifyUpdaterSignature = vi.fn(async () => undefined);
    const inspectAuthenticode = vi.fn(async () => unsignedWindowsSignature());
    const result = await verifyRemoteCandidate({
      candidateUrl: fixture.url,
      localManifestBytes: fixture.manifestBytes,
      trustPolicy: configuredBetaPolicy(),
      releaseTier: "unsigned-beta",
      verifyUpdaterSignature,
      inspectAuthenticode
    });
    expect(result.release_tier).toBe("unsigned-beta");
    expect(verifyUpdaterSignature).toHaveBeenCalledOnce();
    expect(inspectAuthenticode).toHaveBeenCalledTimes(2);
  });

  test("the beta policy cannot hide a Windows signature mismatch", async () => {
    const fixture = await candidateFixture({ releaseTier: "unsigned-beta" });
    await expect(verifyRemoteCandidate({
      candidateUrl: fixture.url,
      localManifestBytes: fixture.manifestBytes,
      trustPolicy: configuredBetaPolicy(),
      releaseTier: "unsigned-beta",
      verifyUpdaterSignature: async () => undefined,
      inspectAuthenticode: async () => validWindowsSignature()
    })).rejects.toThrow("explicitly unsigned beta policy");
  });

  test("changed downloaded bytes never reach either signature check", async () => {
    const fixture = await candidateFixture({ corruptInstaller: true });
    const updater = vi.fn(async () => undefined);
    const windows = vi.fn(async () => validWindowsSignature());
    await expect(verifyRemoteCandidate({
      candidateUrl: fixture.url,
      localManifestBytes: fixture.manifestBytes,
      trustPolicy: configuredPolicy(),
      verifyUpdaterSignature: updater,
      inspectAuthenticode: windows
    })).rejects.toThrow("downloaded installer does not match");
    expect(updater).not.toHaveBeenCalled();
    expect(windows).not.toHaveBeenCalled();
  });

  test("an updater signature cannot substitute for publisher identity", async () => {
    const fixture = await candidateFixture();
    await expect(verifyRemoteCandidate({
      candidateUrl: fixture.url,
      localManifestBytes: fixture.manifestBytes,
      trustPolicy: configuredPolicy(),
      verifyUpdaterSignature: async () => undefined,
      inspectAuthenticode: async () => ({ ...validWindowsSignature(), Thumbprint: "B".repeat(40) })
    })).rejects.toThrow("required valid, timestamped Windows publisher signature");
  });

  test("cross-origin asset substitution is refused", async () => {
    const fixture = await candidateFixture({ crossOrigin: true });
    await expect(verifyRemoteCandidate({
      candidateUrl: fixture.url,
      localManifestBytes: fixture.manifestBytes,
      trustPolicy: configuredPolicy(),
      verifyUpdaterSignature: async () => undefined,
      inspectAuthenticode: async () => validWindowsSignature()
    })).rejects.toThrow("must share one origin");
  });

  test("only one GitHub API asset redirect is accepted and authorization is not forwarded", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get("authorization") });
      if (url.startsWith("https://api.github.com/")) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://release-assets.githubusercontent.com/fixture?signature=bounded" }
        });
      }
      return new Response("exact", { status: 200, headers: { "Content-Length": "5" } });
    });
    const authorizedFetch: typeof fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      if (new URL(String(input)).origin === "https://api.github.com") headers.set("Authorization", "Bearer fixture");
      return fetchImpl(input, { ...init, headers }) as ReturnType<typeof fetch>;
    };
    await expect(downloadReleaseBytes(
      authorizedFetch,
      new URL("https://api.github.com/repos/owner/repo/releases/assets/1"),
      10
    )).resolves.toEqual(Buffer.from("exact"));
    expect(calls).toEqual([
      { url: "https://api.github.com/repos/owner/repo/releases/assets/1", authorization: "Bearer fixture" },
      { url: "https://release-assets.githubusercontent.com/fixture?signature=bounded", authorization: null }
    ]);
  });
});

async function candidateFixture(options: { corruptInstaller?: boolean; crossOrigin?: boolean; releaseTier?: "production" | "unsigned-beta" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "hivemind-release-test-"));
  const payload = Buffer.from(validPayloadManifest());
  const installer = Buffer.from("signed-installer-fixture");
  const executable = Buffer.from("signed-executable-fixture");
  const signature = "fixture signature";
  const base = {
    schema_version: 2,
    kind: "hivemind-windows-artifact",
    platform: "windows-x86_64",
    version: "1.2.3",
    generated_at_ms: 1,
    source_commit: "a".repeat(40),
    rust_advisory: {
      schema_version: 1,
      kind: "hivemind-rust-advisory-evidence",
      platform: "windows-x86_64",
      tool: "cargo-audit-audit 0.22.2",
      database: { origin: "https://github.com/RustSec/advisory-db.git", commit: "c".repeat(40), updated_at: "2026-08-29T08:11:09+02:00" },
      lockfile_sha256: "d".repeat(64),
      dependency_count: 482,
      vulnerability_count: 0
    },
    payload_manifest: { filename: "payload.json", size: payload.length, sha256: sha256(payload) },
    installer: { filename: "setup.exe", size: installer.length, sha256: sha256(installer) },
    executable: { filename: "app.exe", bundle_type: "nsis", size: executable.length, source_size: executable.length, source_sha256: "b".repeat(64), sha256: sha256(executable) }
  };
  const manifest = { ...base, artifact_id: sha256(stableJson(base)) };
  const manifestBytes = Buffer.from(stableJson(manifest));
  await Promise.all([
    writeFile(path.join(root, "artifact.json"), manifestBytes),
    writeFile(path.join(root, "payload.json"), payload),
    writeFile(path.join(root, "setup.exe"), options.corruptInstaller ? Buffer.from("changed") : installer),
    writeFile(path.join(root, "app.exe"), executable),
    writeFile(path.join(root, "setup.exe.sig"), signature),
    writeFile(path.join(root, "latest.json"), JSON.stringify({
      version: manifest.version,
      notes: (options.releaseTier ?? "production") === "unsigned-beta"
        ? `Unsigned beta. ${UNSIGNED_BETA_INSTALL_NOTICE}`
        : `Immutable Windows x64 artifact ${manifest.artifact_id}`,
      pub_date: "2026-08-29T00:00:00.000Z",
      platforms: {
        "windows-x86_64": { signature, url: "https://github.com/owner/repo/releases/download/v1.2.3/setup.exe" }
      }
    }))
  ]);
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.url === "/candidate.json") {
      const assetOrigin = options.crossOrigin ? "https://example.invalid" : origin;
      response.end(JSON.stringify({
        schema_version: 3,
        kind: "hivemind-release-candidate",
        release_tier: options.releaseTier ?? "production",
        artifact_id: manifest.artifact_id,
        version: manifest.version,
        tag_name: `v${manifest.version}`,
        source_commit: manifest.source_commit,
        artifact_manifest_url: `${assetOrigin}/artifact.json`,
        payload_manifest_url: `${assetOrigin}/payload.json`,
        installer_url: `${assetOrigin}/setup.exe`,
        executable_url: `${assetOrigin}/app.exe`,
        updater_signature_url: `${assetOrigin}/setup.exe.sig`,
        updater_manifest_url: `${assetOrigin}/latest.json`,
        public_installer_url: "https://github.com/owner/repo/releases/download/v1.2.3/setup.exe",
        updater_signature: signature,
        ...((options.releaseTier ?? "production") === "unsigned-beta" ? { install_notice: UNSIGNED_BETA_INSTALL_NOTICE } : {})
      }));
      return;
    }
    try { response.end(await readFile(path.join(root, path.basename(request.url ?? "")))); }
    catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/candidate.json`, manifest, manifestBytes };
}

function configuredPolicy() {
  return {
    schema_version: 1,
    kind: "hivemind-release-trust-policy",
    release_tier: "production" as const,
    updater_public_key: "R".repeat(40),
    windows_publisher: { certificate_subject: "CN=Hivemind AI", certificate_thumbprint: "A".repeat(40) }
  };
}

function configuredBetaPolicy() {
  const policy = {
    schema_version: 1,
    kind: "hivemind-release-trust-policy",
    release_tier: "unsigned-beta" as const,
    updater_public_key: "R".repeat(40),
    windows_publisher: {
      status: "deferred" as const,
      certificate_subject: null,
      certificate_thumbprint: null,
      revisit_when_mrr_usd: 200
    },
    install_notice: UNSIGNED_BETA_INSTALL_NOTICE
  };
  expect(() => validateUnsignedBetaTrustPolicy(policy)).not.toThrow();
  return policy;
}

function validWindowsSignature() {
  return { Status: "Valid", Subject: "CN=Hivemind AI", Thumbprint: "A".repeat(40), TimestampSubject: "CN=Timestamp Authority", TimestampThumbprint: "C".repeat(40) };
}

function unsignedWindowsSignature() {
  return { Status: "NotSigned", Subject: null, Thumbprint: null, TimestampSubject: null, TimestampThumbprint: null };
}

function unsignedPeFixture() {
  return peFixture();
}

function peFixture(
  { certificateOffset = 0, certificateSize = 0 }: { certificateOffset?: number; certificateSize?: number } = {}
) {
  const bytes = Buffer.alloc(0x200);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(0xf0, 0x94);
  const optionalHeader = 0x98;
  bytes.writeUInt16LE(0x20b, optionalHeader);
  bytes.writeUInt32LE(16, optionalHeader + 108);
  bytes.writeUInt32LE(certificateOffset, optionalHeader + 112 + (4 * 8));
  bytes.writeUInt32LE(certificateSize, optionalHeader + 112 + (4 * 8) + 4);
  return bytes;
}

function validPayloadManifest() {
  const files = [{ path: "core/app.js", size: 1, sha256: "c".repeat(64) }];
  const inputs = [{ path: "package.json", size: 1, sha256: "d".repeat(64) }];
  return stableJson({
    schema_version: 1,
    kind: "hivemind-payload",
    platform: "windows-x86_64",
    version: "1.2.3",
    generated_at_ms: 1,
    source: {
      clean: true,
      commit: "a".repeat(40),
      inputs,
      input_tree_sha256: sha256(stableJson(inputs)),
      lockfiles: {
        "desktop/package-lock.json": "e".repeat(64),
        "desktop/src-tauri/Cargo.lock": "f".repeat(64),
        "package-lock.json": "1".repeat(64)
      }
    },
    build: { core_build_id: "2".repeat(64), shell_build_id: "3".repeat(64), runtime: { version: "22.22.3", sha256: "4".repeat(64) } },
    files
  });
}
