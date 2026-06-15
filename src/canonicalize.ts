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

export async function canonicalizeIntentPath(repoRoot: string, pathValue: string): Promise<CanonicalizeResult> {
  const lexicalProblem = validateIntentPathLexically(pathValue);
  if (lexicalProblem !== null) {
    return { ok: false, reason: lexicalProblem };
  }

  const rootResult = await realpathOrFalse(repoRoot);
  if (!rootResult.ok) {
    return { ok: false, reason: "repo root cannot be resolved" };
  }

  const parts = pathValue.replaceAll("\\", "/").split("/");
  const ancestorResult = await resolveDeepestExistingAncestor(rootResult.resolved, parts);
  if (!ancestorResult.ok) {
    return { ok: false, reason: ancestorResult.reason };
  }

  const ancestorRelativePath = path.relative(rootResult.resolved, ancestorResult.resolved);
  if (ancestorRelativePath.startsWith("..") || path.isAbsolute(ancestorRelativePath)) {
    return { ok: false, reason: "path resolves outside repo root" };
  }

  const candidatePath = path.join(ancestorResult.resolved, ...parts.slice(ancestorResult.depth));
  const relativePath = path.relative(rootResult.resolved, candidatePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, reason: "path resolves outside repo root" };
  }

  return { ok: true, resolved: normalizeRepoPath(relativePath) };
}

function validateIntentPathLexically(pathValue: string): string | null {
  if (pathValue.length === 0) {
    return "path is empty";
  }
  if (pathValue.includes("\0")) {
    return "path contains NUL byte";
  }
  const normalized = pathValue.replaceAll("\\", "/");
  if (path.isAbsolute(pathValue) || path.posix.isAbsolute(normalized)) {
    return "absolute paths are not allowed";
  }
  if (normalized.includes("*")) {
    return "globs are not allowed";
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === ".")) {
    return "path must be a concrete repo-relative file path";
  }
  if (parts.includes("..")) {
    return ".. traversal is not allowed";
  }
  if (parts.includes(".git")) {
    return ".git paths are not allowed";
  }
  return null;
}

async function resolveDeepestExistingAncestor(
  repoRoot: string,
  parts: string[]
): Promise<{ ok: true; resolved: string; depth: number } | { ok: false; reason: string }> {
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const candidate = path.join(repoRoot, ...parts.slice(0, depth));
    const resolved = await realpathOrFalse(candidate);
    if (resolved.ok) {
      return { ok: true, resolved: resolved.resolved, depth };
    }
  }
  return { ok: false, reason: "repo root cannot be resolved" };
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
