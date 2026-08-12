import { stat } from "node:fs/promises";
import path from "node:path";
import { canonicalizeIntentPath } from "./canonicalize.js";
import { findCaseCollision } from "./lease-index.js";
import { pathCaseBehaviour } from "./path-identity.js";

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

  /* An exact repeat is a harmless list, already deduplicated above. Two
     DIFFERENT spellings of one file are not: on this filesystem the scope names
     one file while reading as two, and whoever wrote the list meant two. Said
     out loud rather than quietly collapsed, because collapsing it is how a task
     ends up with half the scope it asked for and no indication why. */
  const collision = findCaseCollision(paths, await pathCaseBehaviour(repoRoot));
  if (collision !== null) {
    return {
      ok: false,
      reason:
        `${label} names ${collision.left} and ${collision.right}, which are the same file on this ` +
        `filesystem; these differ only in capitalisation`
    };
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
