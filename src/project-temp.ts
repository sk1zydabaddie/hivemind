import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./atomic.js";
import { getProcessLiveness, type ProcessLiveness } from "./process-liveness.js";
import { findGitRoot } from "./repo.js";

const execFileAsync = promisify(execFile);

// Leaves at least 139 characters of the legacy Windows MAX_PATH budget for
// tracked relative paths. Git for Windows may not enable long paths, so keep
// disposable checkout roots short and fail loudly if the environment cannot.
export const WINDOWS_DISPOSABLE_ROOT_BUDGET = 120;

export type ProjectTempPurpose = "checkout" | "changeset" | "consolidation";

interface ProjectIdentity {
  canonical_root: string;
  project_hash: string;
  namespace_id: string;
}

export interface ProjectTempManifest {
  version: 1;
  project_hash: string;
  project_root: string;
  namespace_id: string;
  instance_id: string;
  purpose: ProjectTempPurpose;
  pid: number;
  started_at: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtime_ns: bigint;
  ctime_ns: bigint;
}

interface ProjectTempObservation {
  directory_identity: FileIdentity;
  manifest_identity: FileIdentity;
  manifest_raw: string;
  manifest: ProjectTempManifest;
}

type ProjectTempInspection =
  | { status: "valid"; observation: ProjectTempObservation }
  | { status: "missing" }
  | { status: "uncertain"; reason: string };

export interface ProjectTempDirectory {
  path: string;
  manifest: ProjectTempManifest;
}

export interface ProjectTempOptions {
  tempRoot?: string;
  probeLiveness?: (pid: number) => ProcessLiveness;
  namespaceId?: string;
  instanceId?: string;
  pid?: number;
  platform?: NodeJS.Platform;
  reconcile?: boolean;
}

export interface ProjectTempReconciliation {
  removed: string[];
  retained: Array<{ path: string; reason: string }>;
}

const purposeCodes: Record<ProjectTempPurpose, string> = {
  checkout: "co",
  changeset: "cs",
  consolidation: "mc"
};

export async function withProjectTempDirectory<T>(
  repoRoot: string,
  purpose: ProjectTempPurpose,
  callback: (directory: ProjectTempDirectory) => Promise<T>,
  options: ProjectTempOptions = {}
): Promise<T> {
  const directory = await createProjectTempDirectory(repoRoot, purpose, options);
  let value: T | undefined;
  let operationError: unknown;
  try {
    value = await callback(directory);
  } catch (error: unknown) {
    operationError = error;
  }

  const cleanup = await removeOwnedProjectTempDirectory(repoRoot, directory, options);
  if (!cleanup.ok) {
    const cleanupError = new Error(cleanup.reason);
    if (operationError !== undefined) {
      throw new AggregateError([operationError, cleanupError], "project operation and disposable cleanup both failed");
    }
    throw cleanupError;
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  return value as T;
}

export async function createProjectTempDirectory(
  repoRoot: string,
  purpose: ProjectTempPurpose,
  options: ProjectTempOptions = {}
): Promise<ProjectTempDirectory> {
  const identity = await resolveProjectIdentity(repoRoot, options.namespaceId);
  if (options.reconcile !== false) {
    await reconcileProjectTempDirectories(identity.canonical_root, options);
  }

  const manifest: ProjectTempManifest = {
    version: 1,
    project_hash: identity.project_hash,
    project_root: identity.canonical_root,
    namespace_id: identity.namespace_id,
    instance_id: options.instanceId ?? randomUUID(),
    purpose,
    pid: options.pid ?? process.pid,
    started_at: new Date().toISOString()
  };
  validateInstanceId(manifest.instance_id);
  if (!Number.isSafeInteger(manifest.pid) || manifest.pid <= 0) {
    throw new Error("project disposable owner pid must be a positive safe integer");
  }

  const directoryPath = path.join(
    options.tempRoot ?? tmpdir(),
    disposableDirectoryName(manifest.namespace_id, purpose, manifest.instance_id)
  );
  assertDisposablePathBudget(directoryPath, options.platform);
  await mkdir(directoryPath);
  try {
    await writeJsonAtomic(projectTempManifestPath(directoryPath), manifest);
  } catch (error: unknown) {
    await rm(directoryPath, { recursive: true, force: true });
    throw error;
  }
  return { path: directoryPath, manifest };
}

export async function reconcileProjectTempDirectories(
  repoRoot: string,
  options: ProjectTempOptions = {}
): Promise<ProjectTempReconciliation> {
  const identity = await resolveProjectIdentity(repoRoot, options.namespaceId);
  const tempRoot = options.tempRoot ?? tmpdir();
  const prefix = `hvm-${identity.namespace_id}-`;
  const result: ProjectTempReconciliation = { removed: [], retained: [] };

  let names: string[];
  try {
    names = await readdir(tempRoot);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return result;
    }
    throw error;
  }

  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || !isDisposableDirectoryName(name)) {
      continue;
    }
    const directoryPath = path.join(tempRoot, name);
    const inspection = await inspectProjectTempDirectory(directoryPath);
    if (inspection.status !== "valid") {
      result.retained.push({
        path: directoryPath,
        reason: inspection.status === "missing" ? "directory disappeared during reconciliation" : inspection.reason
      });
      continue;
    }
    if (!manifestMatchesProject(inspection.observation.manifest, identity)) {
      result.retained.push({ path: directoryPath, reason: "ownership manifest does not match the selected project" });
      continue;
    }
    const probeLiveness = options.probeLiveness ?? getProcessLiveness;
    if (probeLiveness(inspection.observation.manifest.pid) !== "dead") {
      result.retained.push({ path: directoryPath, reason: "owner is live or liveness is uncertain" });
      continue;
    }

    const removed = await removeObservedProjectTempDirectory(
      identity.canonical_root,
      directoryPath,
      inspection.observation,
      probeLiveness,
      true
    );
    if (removed.ok) {
      result.removed.push(directoryPath);
    } else {
      result.retained.push({ path: directoryPath, reason: removed.reason });
    }
  }
  return result;
}

export function assertDisposablePathBudget(
  directoryPath: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === "win32" && directoryPath.length > WINDOWS_DISPOSABLE_ROOT_BUDGET) {
    throw new Error(
      `project disposable path exceeds the ${WINDOWS_DISPOSABLE_ROOT_BUDGET}-character Windows root budget: ${directoryPath}`
    );
  }
}

async function removeOwnedProjectTempDirectory(
  repoRoot: string,
  directory: ProjectTempDirectory,
  options: ProjectTempOptions
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const identity = await resolveProjectIdentity(repoRoot, options.namespaceId);
  if (!manifestMatchesProject(directory.manifest, identity)) {
    return { ok: false, reason: "project disposable cleanup identity does not match the selected project" };
  }
  const inspection = await inspectProjectTempDirectory(directory.path);
  if (inspection.status === "missing") {
    return { ok: true };
  }
  if (inspection.status !== "valid") {
    return { ok: false, reason: inspection.reason };
  }
  if (!sameManifest(inspection.observation.manifest, directory.manifest)) {
    return { ok: false, reason: "project disposable ownership changed before cleanup" };
  }
  return removeObservedProjectTempDirectory(
    identity.canonical_root,
    directory.path,
    inspection.observation,
    options.probeLiveness ?? getProcessLiveness,
    false
  );
}

async function removeObservedProjectTempDirectory(
  repoRoot: string,
  directoryPath: string,
  observed: ProjectTempObservation,
  probeLiveness: (pid: number) => ProcessLiveness,
  requireDeadOwner: boolean
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(await prepareWorktreeMetadataForRemoval(repoRoot, directoryPath, observed.manifest.purpose))) {
    return { ok: false, reason: "could not safely detach disposable git worktree metadata" };
  }

  const current = await inspectProjectTempDirectory(directoryPath);
  if (current.status !== "valid" || !sameOwnershipAfterPreparation(current.observation, observed)) {
    return { ok: false, reason: "project disposable identity changed before removal" };
  }
  if (requireDeadOwner && probeLiveness(current.observation.manifest.pid) !== "dead") {
    return { ok: false, reason: "project disposable owner became live or uncertain before removal" };
  }
  try {
    await rm(directoryPath, { recursive: true });
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: `could not remove project disposable directory: ${errorMessage(error)}` };
  }
}

async function inspectProjectTempDirectory(directoryPath: string): Promise<ProjectTempInspection> {
  let directoryBefore: BigIntStats;
  try {
    directoryBefore = await stat(directoryPath, { bigint: true });
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT")
      ? { status: "missing" }
      : { status: "uncertain", reason: `could not inspect disposable directory: ${errorMessage(error)}` };
  }
  if (!directoryBefore.isDirectory()) {
    return { status: "uncertain", reason: "project disposable path is not a directory" };
  }

  const manifestPath = projectTempManifestPath(directoryPath);
  let handle;
  try {
    handle = await open(manifestPath, "r");
  } catch (error: unknown) {
    return {
      status: "uncertain",
      reason: isNodeError(error, "ENOENT")
        ? "project disposable ownership manifest is missing"
        : `could not open project disposable ownership manifest: ${errorMessage(error)}`
    };
  }

  let manifestBefore: BigIntStats;
  let manifestAfter: BigIntStats;
  let manifestRaw: string;
  try {
    manifestBefore = await handle.stat({ bigint: true });
    manifestRaw = await handle.readFile("utf8");
    manifestAfter = await handle.stat({ bigint: true });
  } catch (error: unknown) {
    return { status: "uncertain", reason: `could not read project disposable ownership: ${errorMessage(error)}` };
  } finally {
    await handle.close();
  }
  if (!sameFileIdentity(toFileIdentity(manifestBefore), toFileIdentity(manifestAfter))) {
    return { status: "uncertain", reason: "project disposable ownership changed while being inspected" };
  }

  let manifestPathStats: BigIntStats;
  let directoryAfter: BigIntStats;
  try {
    [manifestPathStats, directoryAfter] = await Promise.all([
      stat(manifestPath, { bigint: true }),
      stat(directoryPath, { bigint: true })
    ]);
  } catch (error: unknown) {
    return {
      status: "uncertain",
      reason: `could not revalidate project disposable identity: ${errorMessage(error)}`
    };
  }
  if (
    !sameFileIdentity(toFileIdentity(manifestAfter), toFileIdentity(manifestPathStats)) ||
    !sameFileIdentity(toFileIdentity(directoryBefore), toFileIdentity(directoryAfter))
  ) {
    return { status: "uncertain", reason: "project disposable identity changed while being inspected" };
  }

  const manifest = parseProjectTempManifest(manifestRaw);
  if (manifest === null) {
    return { status: "uncertain", reason: "project disposable ownership manifest is empty, partial, or invalid" };
  }
  if (path.basename(directoryPath) !== disposableDirectoryName(manifest.namespace_id, manifest.purpose, manifest.instance_id)) {
    return { status: "uncertain", reason: "project disposable path does not match its ownership manifest" };
  }
  return {
    status: "valid",
    observation: {
      directory_identity: toFileIdentity(directoryAfter),
      manifest_identity: toFileIdentity(manifestAfter),
      manifest_raw: manifestRaw,
      manifest
    }
  };
}

async function resolveProjectIdentity(repoRoot: string, namespaceOverride?: string): Promise<ProjectIdentity> {
  const gitRoot = await findGitRoot(repoRoot);
  if (gitRoot === null) {
    throw new Error("project disposable state requires a git repository");
  }
  const canonicalRoot = normalizeCanonicalRoot(await realpath(gitRoot));
  const projectHash = createHash("sha256").update(canonicalRoot).digest("hex");
  const namespaceId = namespaceOverride ?? projectHash.slice(0, 24);
  if (!/^[a-z0-9]{1,32}$/u.test(namespaceId)) {
    throw new Error("project disposable namespace id must contain 1-32 lowercase letters or digits");
  }
  return {
    canonical_root: canonicalRoot,
    project_hash: projectHash,
    namespace_id: namespaceId
  };
}

async function prepareWorktreeMetadataForRemoval(
  repoRoot: string,
  directoryPath: string,
  purpose: ProjectTempPurpose
): Promise<boolean> {
  const checkoutPaths =
    purpose === "checkout"
      ? [path.join(directoryPath, "checkout")]
      : purpose === "changeset"
        ? [path.join(directoryPath, "base"), path.join(directoryPath, "applied")]
        : [];
  for (const checkoutPath of checkoutPaths) {
    if (!(await removeWorktreeRegistration(repoRoot, checkoutPath))) {
      return false;
    }
  }
  return true;
}

async function removeWorktreeRegistration(repoRoot: string, checkoutPath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", checkoutPath], {
      cwd: repoRoot,
      windowsHide: true
    });
    return true;
  } catch {
    try {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoRoot,
        windowsHide: true
      });
      const target = normalizeComparablePath(checkoutPath);
      return !stdout
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("worktree "))
        .some((line) => normalizeComparablePath(line.slice("worktree ".length)) === target);
    } catch {
      return false;
    }
  }
}

function parseProjectTempManifest(raw: string): ProjectTempManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "instance_id,namespace_id,pid,project_hash,project_root,purpose,started_at,version" ||
    value.version !== 1 ||
    typeof value.project_hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.project_hash) ||
    typeof value.project_root !== "string" ||
    value.project_root.length === 0 ||
    typeof value.namespace_id !== "string" ||
    !/^[a-z0-9]{1,32}$/u.test(value.namespace_id) ||
    typeof value.instance_id !== "string" ||
    !/^[A-Za-z0-9-]{1,64}$/u.test(value.instance_id) ||
    !isProjectTempPurpose(value.purpose) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.started_at !== "string" ||
    Number.isNaN(Date.parse(value.started_at))
  ) {
    return null;
  }
  return value as unknown as ProjectTempManifest;
}

function manifestMatchesProject(manifest: ProjectTempManifest, identity: ProjectIdentity): boolean {
  return (
    manifest.project_hash === identity.project_hash &&
    manifest.namespace_id === identity.namespace_id &&
    normalizeComparablePath(manifest.project_root) === normalizeComparablePath(identity.canonical_root)
  );
}

function sameOwnershipAfterPreparation(left: ProjectTempObservation, right: ProjectTempObservation): boolean {
  return (
    left.manifest_raw === right.manifest_raw &&
    sameManifest(left.manifest, right.manifest) &&
    left.directory_identity.dev === right.directory_identity.dev &&
    left.directory_identity.ino === right.directory_identity.ino &&
    sameFileIdentity(left.manifest_identity, right.manifest_identity)
  );
}

function sameManifest(left: ProjectTempManifest, right: ProjectTempManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function disposableDirectoryName(namespaceId: string, purpose: ProjectTempPurpose, instanceId: string): string {
  return `hvm-${namespaceId}-${purposeCodes[purpose]}-${instanceId}`;
}

function isDisposableDirectoryName(value: string): boolean {
  return /^hvm-[a-z0-9]{1,32}-(?:co|cs|mc)-[A-Za-z0-9-]{1,64}$/u.test(value);
}

function projectTempManifestPath(directoryPath: string): string {
  return path.join(directoryPath, "owner.json");
}

function validateInstanceId(value: string): void {
  if (!/^[A-Za-z0-9-]{1,64}$/u.test(value)) {
    throw new Error("project disposable instance id must contain 1-64 letters, digits, or hyphens");
  }
}

function normalizeCanonicalRoot(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function toFileIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtime_ns: stats.mtimeNs,
    ctime_ns: stats.ctimeNs
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtime_ns === right.mtime_ns &&
    left.ctime_ns === right.ctime_ns
  );
}

function isProjectTempPurpose(value: unknown): value is ProjectTempPurpose {
  return value === "checkout" || value === "changeset" || value === "consolidation";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
