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

function normalize(pathValue: string): string {
  return pathValue.replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+/gu, "/").trim();
}
