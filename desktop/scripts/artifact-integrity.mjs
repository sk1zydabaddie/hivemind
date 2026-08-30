import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export const PAYLOAD_SCHEMA_VERSION = 1;
export const ARTIFACT_SCHEMA_VERSION = 1;
export const WINDOWS_PLATFORM = "windows-x86_64";

export async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export async function writeFileAtomically(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const candidate = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  const handle = await open(candidate, "wx");
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(candidate, file);
  } finally {
    await rm(candidate, { force: true });
  }
}

export async function inventoryManagedRoots(root, managedRoots = ["core", "runtime"]) {
  const entries = [];
  for (const managedRoot of managedRoots) {
    await walk(root, managedRoot, entries);
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export async function verifyManagedInventory(root, expectedEntries, managedRoots = ["core", "runtime"]) {
  validateEntries(expectedEntries, managedRoots);
  const actualEntries = await inventoryManagedRoots(root, managedRoots);
  const expected = new Map(expectedEntries.map((entry) => [entry.path, entry]));
  const actual = new Map(actualEntries.map((entry) => [entry.path, entry]));
  const missing = [...expected.keys()].filter((entry) => !actual.has(entry));
  const unexpected = [...actual.keys()].filter((entry) => !expected.has(entry));
  const changed = [...expected.keys()].filter((entry) => {
    const found = actual.get(entry);
    const wanted = expected.get(entry);
    return found !== undefined && (found.size !== wanted.size || found.sha256 !== wanted.sha256);
  });
  if (missing.length || unexpected.length || changed.length) {
    throw new Error([
      "installed managed payload does not match the admitted manifest",
      missing.length ? `missing: ${missing.slice(0, 10).join(", ")}` : "",
      unexpected.length ? `unexpected: ${unexpected.slice(0, 10).join(", ")}` : "",
      changed.length ? `changed: ${changed.slice(0, 10).join(", ")}` : ""
    ].filter(Boolean).join("\n"));
  }
}

export function validatePayloadManifest(manifest) {
  if (!isRecord(manifest) || manifest.schema_version !== PAYLOAD_SCHEMA_VERSION || manifest.kind !== "hivemind-payload") {
    throw new Error("payload manifest has an unsupported schema");
  }
  if (manifest.platform !== WINDOWS_PLATFORM || !validVersion(manifest.version) ||
      !Number.isSafeInteger(manifest.generated_at_ms) || manifest.generated_at_ms < 0) {
    throw new Error("payload manifest has an unsupported platform or version");
  }
  if (!isRecord(manifest.source) || manifest.source.clean !== true ||
      !gitHash(manifest.source.commit) || !fullHash(manifest.source.input_tree_sha256)) {
    throw new Error("payload manifest has incomplete source provenance");
  }
  validateSourceInputs(manifest.source.inputs);
  if (sha256(stableJson(manifest.source.inputs)) !== manifest.source.input_tree_sha256) {
    throw new Error("payload manifest source input identity does not match its inventory");
  }
  const expectedLocks = ["desktop/package-lock.json", "desktop/src-tauri/Cargo.lock", "package-lock.json"];
  if (!isRecord(manifest.source.lockfiles) ||
      Object.keys(manifest.source.lockfiles).sort().join("\0") !== expectedLocks.join("\0") ||
      expectedLocks.some((lockfile) => !fullHash(manifest.source.lockfiles[lockfile]))) {
    throw new Error("payload manifest does not bind the three admitted lockfiles");
  }
  if (!isRecord(manifest.build) || !fullHash(manifest.build.core_build_id) || !fullHash(manifest.build.shell_build_id)) {
    throw new Error("payload manifest has incomplete build identities");
  }
  if (!isRecord(manifest.build.runtime) || typeof manifest.build.runtime.version !== "string" || !fullHash(manifest.build.runtime.sha256)) {
    throw new Error("payload manifest has incomplete runtime identity");
  }
  validateEntries(manifest.files, ["core", "runtime"]);
  return manifest;
}

export function validateArtifactManifest(manifest) {
  if (!isRecord(manifest) || manifest.schema_version !== ARTIFACT_SCHEMA_VERSION || manifest.kind !== "hivemind-windows-artifact") {
    throw new Error("artifact manifest has an unsupported schema");
  }
  if (manifest.platform !== WINDOWS_PLATFORM || !fullHash(manifest.artifact_id) || !gitHash(manifest.source_commit) ||
      !validVersion(manifest.version) || !Number.isSafeInteger(manifest.generated_at_ms) || manifest.generated_at_ms < 0) {
    throw new Error("artifact manifest has incomplete identity or provenance");
  }
  for (const field of ["payload_manifest", "installer", "executable"]) {
    const entry = manifest[field];
    if (!isRecord(entry) || typeof entry.filename !== "string" || !Number.isSafeInteger(entry.size) || entry.size < 1 || !fullHash(entry.sha256)) {
      throw new Error(`artifact manifest has an invalid ${field} entry`);
    }
    if (path.basename(entry.filename) !== entry.filename || entry.filename === "." || entry.filename === "..") {
      throw new Error(`artifact manifest has an unsafe ${field} filename`);
    }
  }
  const identityInput = { ...manifest };
  delete identityInput.artifact_id;
  if (sha256(stableJson(identityInput)) !== manifest.artifact_id) {
    throw new Error("artifact manifest identity does not match its admitted fields");
  }
  return manifest;
}

async function walk(root, relative, entries) {
  const absolute = path.join(root, ...relative.split("/"));
  const details = await lstat(absolute);
  if (details.isSymbolicLink()) throw new Error(`managed payload contains a symbolic link: ${relative}`);
  if (details.isFile()) {
    entries.push({ path: relative, size: details.size, sha256: await sha256File(absolute) });
    return;
  }
  if (!details.isDirectory()) throw new Error(`managed payload contains an unsupported entry: ${relative}`);
  const children = await readdir(absolute);
  children.sort((left, right) => left.localeCompare(right, "en"));
  for (const child of children) await walk(root, `${relative}/${child}`, entries);
}

function validateEntries(entries, managedRoots) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("payload manifest has no file inventory");
  let previous = "";
  const allowed = new Set(managedRoots);
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !Number.isSafeInteger(entry.size) || entry.size < 0 || !fullHash(entry.sha256)) {
      throw new Error("payload manifest contains an invalid file entry");
    }
    const normalized = entry.path.replaceAll("\\", "/");
    if (normalized !== entry.path || path.posix.normalize(normalized) !== normalized ||
        normalized.startsWith("/") || !allowed.has(normalized.split("/")[0])) {
      throw new Error(`payload manifest contains an unsafe file path: ${entry.path}`);
    }
    if (previous !== "" && entry.path.localeCompare(previous, "en") <= 0) {
      throw new Error("payload manifest file inventory is not unique and sorted");
    }
    previous = entry.path;
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function fullHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function gitHash(value) {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function validVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) return false;
  return value.split(".").every((field) => Number(field) <= 65_535);
}

function validateSourceInputs(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("payload manifest has no source input inventory");
  let previous = "";
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !Number.isSafeInteger(entry.size) ||
        entry.size < 0 || !fullHash(entry.sha256)) {
      throw new Error("payload manifest contains an invalid source input");
    }
    const normalized = entry.path.replaceAll("\\", "/");
    if (normalized !== entry.path || path.posix.normalize(normalized) !== normalized ||
        normalized.startsWith("/") || /^[a-zA-Z]:/u.test(normalized) || normalized === ".") {
      throw new Error(`payload manifest contains an unsafe source input path: ${entry.path}`);
    }
    if (previous !== "" && entry.path <= previous) {
      throw new Error("payload manifest source inputs are not unique and sorted");
    }
    previous = entry.path;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
