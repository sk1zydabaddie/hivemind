import path from "node:path";

export function validateRepoRelativePathOrGlob(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized === "") {
    return "entry must not be empty";
  }
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value.trim())) {
    return "absolute paths are not allowed";
  }
  const parts = normalized.split("/");
  if (parts.includes("..")) {
    return ".. traversal is not allowed";
  }
  if (parts.includes(".git")) {
    return ".git paths are not allowed";
  }
  return null;
}

export function normalizeRepoPathPattern(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/u, "").trim();
}
