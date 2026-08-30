export interface FileIdentity {
  path: string;
  size: number;
  sha256: string;
}

export interface NsisExecutableIdentity {
  filename: string;
  bundle_type: "nsis";
  size: number;
  source_sha256: string;
  sha256: string;
}

export const PAYLOAD_SCHEMA_VERSION: number;
export const ARTIFACT_SCHEMA_VERSION: number;
export const WINDOWS_PLATFORM: string;
export function sha256File(file: string): Promise<string>;
export function sha256(value: string | NodeJS.ArrayBufferView): string;
export function nsisExecutableIdentity(file: string, filename?: string): Promise<NsisExecutableIdentity>;
export function stableJson(value: unknown): string;
export function writeFileAtomically(file: string, contents: string | NodeJS.ArrayBufferView): Promise<void>;
export function inventoryManagedRoots(
  root: string,
  managedRoots?: string[]
): Promise<FileIdentity[]>;
export function verifyManagedInventory(
  root: string,
  expectedEntries: FileIdentity[],
  managedRoots?: string[]
): Promise<void>;
export function validatePayloadManifest<T>(manifest: T): T;
export function validateArtifactManifest<T>(manifest: T): T;
