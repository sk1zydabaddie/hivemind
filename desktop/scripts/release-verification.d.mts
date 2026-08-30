export interface ReleaseTrustPolicy {
  schema_version: number;
  kind: string;
  updater_public_key: string | null;
  windows_publisher: {
    certificate_subject: string | null;
    certificate_thumbprint: string | null;
  };
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
}

export function validateTrustPolicy(policy: ReleaseTrustPolicy): ValidatedReleaseTrust;
export function verifyRemoteCandidate(options: {
  candidateUrl: string;
  localManifestBytes: NodeJS.ArrayBufferView;
  trustPolicy: ReleaseTrustPolicy;
  verifyUpdaterSignature?: (options: { installer: string; signature: string; publicKey: string }) => Promise<void> | void;
  inspectAuthenticode?: (file: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<ReleaseCandidateVerification>;
export function inspectWindowsSignature(file: string): Record<string, unknown>;
export function assertAuthenticode(label: string, signature: Record<string, unknown>, trust: ValidatedReleaseTrust): void;
