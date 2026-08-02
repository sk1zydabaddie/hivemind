import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedBuildIdentity: Promise<string> | undefined;
let cachedShellBuildIdentity: Promise<string> | undefined;

export function currentBuildIdentity(): Promise<string> {
  cachedBuildIdentity ??= computeBuildIdentity(path.dirname(fileURLToPath(import.meta.url)));
  return cachedBuildIdentity;
}

export function currentShellBuildIdentity(): Promise<string> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  cachedShellBuildIdentity ??= computeShellBuildIdentity(path.join(repoRoot, "desktop"));
  return cachedShellBuildIdentity;
}

export async function computeBuildIdentity(compiledSourceRoot: string): Promise<string> {
  const files = await listCompiledModules(compiledSourceRoot);
  const hash = createHash("sha256");
  hash.update("hivemind-core-build-v1\0");
  for (const relativePath of files) {
    const contents = await readFile(path.join(compiledSourceRoot, relativePath));
    hash.update(relativePath.replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function computeShellBuildIdentity(desktopRoot: string): Promise<string> {
  const files = await listShellBuildInputs(desktopRoot);
  const hash = createHash("sha256");
  hash.update("hivemind-desktop-shell-v1\0");
  for (const relativePath of files) {
    const contents = await readFile(path.join(desktopRoot, relativePath));
    hash.update(relativePath.replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listShellBuildInputs(desktopRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const relativePath of [
    "index.html",
    "package-lock.json",
    "package.json",
    "tsconfig.app.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    path.join("src-tauri", "build.rs"),
    path.join("src-tauri", "Cargo.lock"),
    path.join("src-tauri", "Cargo.toml"),
    path.join("src-tauri", "tauri.conf.json")
  ]) {
    try {
      await readFile(path.join(desktopRoot, relativePath));
      files.push(relativePath);
    } catch (error: unknown) {
      if (!isMissingFile(error)) throw error;
    }
  }
  for (const relativeDirectory of ["src", path.join("src-tauri", "src"), path.join("src-tauri", "capabilities")]) {
    await visitAllFiles(desktopRoot, relativeDirectory, files);
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

async function visitAllFiles(root: string, relativeDirectory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFile(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) await visitAllFiles(root, relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function listCompiledModules(root: string): Promise<string[]> {
  const files: string[] = [];
  await visit(root, "", files);
  return files.sort((left, right) => left.localeCompare(right));
}

async function visit(root: string, relativeDirectory: string, files: string[]): Promise<void> {
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      await visit(root, relativePath, files);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(relativePath);
    }
  }
}
