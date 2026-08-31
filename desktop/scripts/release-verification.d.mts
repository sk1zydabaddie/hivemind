export interface ReleaseTrustPolicy {
  schema_version: number;
  kind: string;
  release_tier: "production" | "unsigned-beta";
  updater_public_key: string | null;
  windows_publisher: {
    status?: "deferred";
    certificate_subject: string | null;
    certificate_thumbprint: string | null;
    revisit_when_mrr_usd?: number;
  };
  install_notice?: string;
}

export interface ValidatedReleaseTrust {
  updaterPublicKey: string;
  publisherSubject: string;
  publisherThumbprint: string;
}

export interface ReleaseCandidateVerification {
  artifact_id: string;
  version: string;
  installer_sha256: string;
  source_commit: string;
  tag_name: string;
  release_tier: "production" | "unsigned-beta";
}

export const PRODUCTION_RELEASE_TIER: "production";
export const UNSIGNED_BETA_RELEASE_TIER: "unsigned-beta";
export const UNSIGNED_BETA_MRR_THRESHOLD_USD: 200;
export const UNSIGNED_BETA_INSTALL_NOTICE: string;
export function validateTrustPolicy(policy: ReleaseTrustPolicy): ValidatedReleaseTrust;
export function validateUnsignedBetaTrustPolicy(policy: ReleaseTrustPolicy): {
  releaseTier: "unsigned-beta";
  updaterPublicKey: string;
  installNotice: string;
  revisitWhenMrrUsd: number;
};
export function downloadReleaseBytes(fetchImpl: typeof fetch, url: URL, maximum: number): Promise<Buffer>;
export function verifyRemoteCandidate(options: {
  candidateUrl: string;
  localManifestBytes: NodeJS.ArrayBufferView;
  trustPolicy: ReleaseTrustPolicy;
  releaseTier?: "production" | "unsigned-beta";
  verifyUpdaterSignature?: (options: { installer: string; signature: string; publicKey: string }) => Promise<void> | void;
  inspectAuthenticode?: (file: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<ReleaseCandidateVerification>;
export function inspectWindowsSignature(file: string): Record<string, unknown>;
export function assertAuthenticode(label: string, signature: Record<string, unknown>, trust: ValidatedReleaseTrust): void;
export function assertUnsignedBeta(label: string, signature: Record<string, unknown>): void;
