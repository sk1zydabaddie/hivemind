export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function formatErrorDetail(error: unknown, fallback: string): string {
  return formatValue(error, fallback, new Set<unknown>());
}

function formatValue(value: unknown, fallback: string, seen: Set<unknown>): string {
  if (typeof value === "string") {
    return value.trim() === "" ? fallback : value.trim();
  }
  if (typeof value !== "object" || value === null) {
    return fallback;
  }
  if (seen.has(value)) {
    return fallback;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const message =
    typeof record.message === "string" && record.message.trim() !== ""
      ? record.message.trim()
      : fallback;
  const code =
    typeof record.code === "string" && record.code.trim() !== ""
      ? record.code.trim()
      : null;
  const primary = code === null || message.includes(code) ? message : `${message} [${code}]`;
  if (!("cause" in record) || record.cause === undefined || record.cause === null) {
    return primary;
  }

  const cause = formatValue(record.cause, "unknown cause", seen);
  return cause === "unknown cause" ? primary : `${primary}; cause: ${cause}`;
}
