import { stat } from "node:fs/promises";
import path from "node:path";
import { canonicalizeIntentPath } from "./canonicalize.js";

export async function canonicalizeConcreteFileScope(
  repoRoot: string,
  files: string[],
  label: string
): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const canonical = await canonicalizeIntentPath(repoRoot, file);
    if (!canonical.ok) {
      return { ok: false, reason: `invalid ${label} path "${file}": ${canonical.reason}` };
    }

    const directoryProblem = await rejectExistingDirectory(repoRoot, canonical.resolved);
    if (directoryProblem !== null) {
      return { ok: false, reason: `invalid ${label} path "${file}": ${directoryProblem}` };
    }

    if (!seen.has(canonical.resolved)) {
      paths.push(canonical.resolved);
      seen.add(canonical.resolved);
    }
  }
  return { ok: true, paths };
}

async function rejectExistingDirectory(repoRoot: string, filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(path.join(repoRoot, filePath));
    return fileStat.isDirectory() ? "path is a directory" : null;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
