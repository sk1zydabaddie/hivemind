export function matchesAny(pathValue: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(pathValue, pattern));
}

export function matchesPattern(pathValue: string, pattern: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  if (!normalizedPattern.includes("*")) {
    return pathValue === normalizedPattern;
  }

  return globToRegExp(normalizedPattern).test(pathValue);
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
