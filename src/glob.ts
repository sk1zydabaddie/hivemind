import { foldPath } from "./path-identity.js";

/**
 * `caseInsensitive` exists for filesystems where two spellings are one file.
 * It folds BOTH sides with the same function the lease store keys by, rather
 * than setting the regex `i` flag on one side, so a path and a pattern that
 * compare equal here are the same two strings the lease index treats as one.
 */
export interface MatchOptions {
  caseInsensitive?: boolean;
}

export function matchesAny(pathValue: string, patterns: string[], options: MatchOptions = {}): boolean {
  return patterns.some((pattern) => matchesPattern(pathValue, pattern, options));
}

export function matchesPattern(pathValue: string, pattern: string, options: MatchOptions = {}): boolean {
  const fold = (value: string): string => (options.caseInsensitive === true ? foldPath(value) : value);
  const normalizedPattern = fold(normalizePattern(pattern));
  const normalizedPath = fold(pathValue);
  if (!normalizedPattern.includes("*")) {
    return normalizedPath === normalizedPattern;
  }

  return globToRegExp(normalizedPattern).test(normalizedPath);
}

function normalizePattern(pattern: string): string {
  return pattern.replaceAll("\\", "/");
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
