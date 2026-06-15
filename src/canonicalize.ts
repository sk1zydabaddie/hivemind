import { realpath } from "node:fs/promises";
import path from "node:path";

export type CanonicalizeResult =
  | {
      ok: true;
      resolved: string;
    }
  | {
      ok: false;
      reason: string;
    };

export async function canonicalize(repoRoot: string, pathValue: string): Promise<CanonicalizeResult> {
  if (pathValue.length === 0) {
    return { ok: false, reason: "path is empty" };
  }

  if (pathValue.includes("\0")) {
    return { ok: false, reason: "path contains NUL byte" };
  }

  const rootResult = await realpathOrFalse(repoRoot);
  if (!rootResult.ok) {
    return { ok: false, reason: "repo root cannot be resolved" };
  }

  const inputPath = pathValue.replaceAll("\\", path.sep);
  const candidatePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootResult.resolved, inputPath);
  const candidateResult = await realpathOrFalse(candidatePath);
  if (!candidateResult.ok) {
    return { ok: false, reason: "path cannot be resolved" };
  }

  const relativePath = path.relative(rootResult.resolved, candidateResult.resolved);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, reason: "path resolves outside repo root" };
  }

  return { ok: true, resolved: normalizeRepoPath(relativePath) };
}

async function realpathOrFalse(pathValue: string): Promise<{ ok: true; resolved: string } | { ok: false }> {
  try {
    return { ok: true, resolved: await realpath(pathValue) };
  } catch {
    return { ok: false };
  }
}

function normalizeRepoPath(pathValue: string): string {
  if (pathValue.length === 0) {
    return ".";
  }

  return pathValue.split(path.sep).join("/");
}
