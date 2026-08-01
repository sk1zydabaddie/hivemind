import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedBuildIdentity: Promise<string> | undefined;

export function currentBuildIdentity(): Promise<string> {
  cachedBuildIdentity ??= computeBuildIdentity(path.dirname(fileURLToPath(import.meta.url)));
  return cachedBuildIdentity;
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
