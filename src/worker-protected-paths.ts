const canonRoot = ".hivemind/canon";

export function workerProtectedPathReason(pathValue: string): string | null {
  const normalized = normalize(pathValue);
  return normalized === canonRoot || normalized.startsWith(`${canonRoot}/`)
    ? "Hivemind canon is writable only through interactive human review"
    : null;
}

export function workerProtectedScopeReason(pathOrGlob: string): string | null {
  const normalized = normalize(pathOrGlob);
  if (!/[*?]/u.test(normalized)) {
    return workerProtectedPathReason(normalized);
  }

  const wildcardIndex = normalized.search(/[*?]/u);
  const literalPrefix = normalized.slice(0, wildcardIndex);
  if (
    literalPrefix === "" ||
    canonRoot.startsWith(literalPrefix) ||
    literalPrefix.startsWith(`${canonRoot}/`)
  ) {
    return "scope glob could reach Hivemind canon, which is writable only through interactive human review";
  }
  return null;
}

/**
 * Case-folded unconditionally, unlike every other scope comparison.
 *
 * `.hivemind/canon` is not a user's path, it is ours, and there is exactly one
 * of it. On a case-insensitive filesystem a worker writing `.Hivemind/Canon/x`
 * reaches the real canon while a byte comparison says it did not -- so folding
 * here closes an evasion. On a case-sensitive filesystem folding refuses a
 * `.Hivemind/canon` that would genuinely be a different directory, which costs
 * nothing: nobody has one, and the guard being stricter than the filesystem is
 * the harmless direction for a path human review is the only way into.
 */
function normalize(pathValue: string): string {
  return pathValue
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+/gu, "/")
    .trim()
    .toLowerCase();
}
