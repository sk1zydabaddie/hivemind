export interface VerificationPolicy {
  version: 1;
  mappings: VerificationMapping[];
}

export interface VerificationMapping {
  check_id: string;
  paths: string[];
}

export type VerificationPolicyResult =
  | { ok: true; value: VerificationPolicy | null }
  | { ok: false; reason: string };

export function validateVerificationPolicy(value: unknown): VerificationPolicyResult {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.mappings)) {
    return { ok: false, reason: "verification policy must be a version 1 object with mappings" };
  }
  const mappings: VerificationMapping[] = [];
  for (const [index, mapping] of value.mappings.entries()) {
    if (
      !isRecord(mapping) ||
      typeof mapping.check_id !== "string" ||
      mapping.check_id.trim() === "" ||
      !Array.isArray(mapping.paths) ||
      mapping.paths.length === 0 ||
      mapping.paths.some((entry) => typeof entry !== "string" || entry.trim() === "")
    ) {
      return { ok: false, reason: `verification policy mappings[${index}] is invalid` };
    }
    mappings.push({
      check_id: mapping.check_id.trim(),
      paths: [...new Set(mapping.paths.map((entry) => String(entry).trim()))].sort(compareText)
    });
  }
  return {
    ok: true,
    value: {
      version: 1,
      mappings: mappings.sort(
        (left, right) => compareText(left.check_id, right.check_id) || compareText(left.paths.join("\0"), right.paths.join("\0"))
      )
    }
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
