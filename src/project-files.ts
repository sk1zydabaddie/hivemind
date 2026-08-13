import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { canonicalize } from "./canonicalize.js";
import { foldPath } from "./path-identity.js";

/**
 * Reading the project's own files, and nothing else.
 *
 * This exists for one reason: a file tree and a file viewer in the desktop had
 * no action to stand on. Every other surface renders something Core already
 * emitted as an event; a file tree renders the working tree itself, which
 * nothing in the action surface could reach.
 *
 * **It is a new authorization surface even though it only reads**, and it is
 * treated as one. Read-only is not the same as harmless: a reader that can be
 * talked out of its confinement hands over source, credentials and the trail
 * itself. So the rules are stated here, enforced in one place, and tested from
 * every caller rather than only from the function.
 *
 * 1. **Read-only.** There is no write path in this module and no function here
 *    opens a handle for writing. `files.list` and `files.read` are the whole
 *    surface.
 * 2. **Confined to the project root, resolved.** Every path is realpath'd
 *    before it is judged, so a symlink pointing out of the repository is
 *    refused on where it *lands*, not on how it is spelled. `..` and absolute
 *    paths are refused lexically as well, so the common case gets a clear
 *    reason rather than "path cannot be resolved".
 * 3. **`.hivemind/` is refused entirely**, and the refusal names the audited
 *    action that does serve it. None of it is user code: it is the trail, the
 *    canon, the patches and the config, each of which already has an action
 *    that shapes what a person may see. Serving it here would be a second,
 *    unshaped way to read the same state — the file-tree equivalent of the
 *    terminal argument, and refused for the same reason.
 * 4. **`.git/` is refused** on the same grounds, plus the obvious one: it holds
 *    every credential a helper ever cached.
 *
 * A listing OMITS those two directories rather than erroring, because a tree
 * that refuses to draw its own root is useless; naming one of them directly is
 * what earns a refusal.
 */

/** How much of a file a single read will return. */
export const PROJECT_FILE_READ_LIMIT_BYTES = 512 * 1024;

export interface ProjectDirectoryEntry {
  name: string;
  /** Repo-relative, forward-slashed, the spelling on disk. */
  path: string;
  kind: "file" | "directory";
}

export interface ProjectFileListing {
  path: string;
  entries: ProjectDirectoryEntry[];
}

export interface ProjectFileContent {
  path: string;
  text: string;
  bytes: number;
  /** True when the file was longer than the read limit and text is a prefix. */
  truncated: boolean;
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/* Hivemind's own directories, matched case-folded unconditionally.
   There is exactly one of each, they are ours rather than the user's, and on a
   case-insensitive volume `.Hivemind/config.json` reaches the real file while a
   byte comparison says it did not. Folding refuses a genuinely-different
   `.Hivemind` on a case-sensitive volume, which costs nothing: nobody has one,
   and stricter-than-the-filesystem is the harmless direction here. Same
   reasoning as `worker-protected-paths.ts`, which guards canon for writes. */
const REFUSED_ROOTS: { folded: string; reason: string }[] = [
  {
    folded: ".hivemind",
    reason:
      "Hivemind's own record is not read as project files; the trail, the change set and the " +
      "configuration are served by trail.inspect, change.inspect and config.inspect"
  },
  { folded: ".git", reason: "the git directory is not project source" }
];

/** The refusal reason for a resolved repo-relative path, or null if allowed. */
function refusedRootReason(resolvedRepoPath: string): string | null {
  const folded = foldPath(resolvedRepoPath);
  const first = folded.split("/")[0] ?? "";
  return REFUSED_ROOTS.find((entry) => entry.folded === first)?.reason ?? null;
}

/**
 * Lexical refusals, so the common mistakes get a reason a person can act on.
 *
 * These are NOT the confinement. `canonicalize` is, and it runs afterwards on
 * every path regardless of what this says — a spelling that slips past here
 * still has to land inside the resolved root. Two checks, and the one that
 * matters is the one that resolves.
 */
function lexicalProblem(pathValue: string): string | null {
  if (pathValue.includes("\0")) return "path contains NUL byte";
  const normalized = pathValue.replaceAll("\\", "/");
  if (path.isAbsolute(pathValue) || path.posix.isAbsolute(normalized)) {
    return "absolute paths are not allowed";
  }
  if (normalized.split("/").includes("..")) return ".. traversal is not allowed";
  if (/[*?]/u.test(normalized)) return "globs are not allowed";
  return null;
}

/**
 * Resolve a requested path to a repo-relative one, or say why not.
 *
 * The order is deliberate: lexical first for the message, then realpath for the
 * truth, then the refused-root check ON THE RESOLVED PATH. Checking the
 * refused roots against the *input* would be defeated by a symlink named
 * anything at all pointing at `.hivemind`.
 */
async function resolveWithin(
  repoRoot: string,
  requested: string
): Promise<Result<string>> {
  const lexical = lexicalProblem(requested);
  if (lexical !== null) return { ok: false, reason: lexical };

  const canonical = await canonicalize(repoRoot, requested === "" ? "." : requested);
  if (!canonical.ok) return { ok: false, reason: canonical.reason };

  const refused = refusedRootReason(canonical.resolved);
  if (refused !== null) return { ok: false, reason: refused };

  return { ok: true, value: canonical.resolved };
}

/** One directory's immediate children. Never recurses; the caller walks. */
export async function listProjectFiles(
  repoRoot: string,
  requested: string
): Promise<Result<ProjectFileListing>> {
  const resolved = await resolveWithin(repoRoot, requested);
  if (!resolved.ok) return resolved;

  const absolute = path.join(repoRoot, resolved.value === "." ? "" : resolved.value);
  let stats;
  try {
    stats = await stat(absolute);
  } catch {
    return { ok: false, reason: "path cannot be resolved" };
  }
  if (!stats.isDirectory()) return { ok: false, reason: "path is not a directory" };

  let dirents;
  try {
    dirents = await readdir(absolute, { withFileTypes: true });
  } catch {
    return { ok: false, reason: "directory cannot be read" };
  }

  const entries: ProjectDirectoryEntry[] = [];
  for (const dirent of dirents) {
    const childPath = resolved.value === "." ? dirent.name : `${resolved.value}/${dirent.name}`;
    /* Omitted rather than refused: a tree that will not draw its own root is
       useless. Asking for one of them BY NAME is what earns a refusal, which
       `resolveWithin` above does. */
    if (refusedRootReason(childPath) !== null) continue;
    /* A symlink is resolved before it is described, so a link out of the
       repository is dropped from the listing rather than offered as a file
       that then refuses to open. */
    const child = await resolveWithin(repoRoot, childPath);
    if (!child.ok) continue;
    let childStats;
    try {
      childStats = await stat(path.join(repoRoot, child.value));
    } catch {
      continue;
    }
    if (!childStats.isDirectory() && !childStats.isFile()) continue;
    entries.push({
      name: dirent.name,
      path: child.value,
      kind: childStats.isDirectory() ? "directory" : "file"
    });
  }

  entries.sort((left, right) =>
    left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind === "directory"
        ? -1
        : 1
  );
  return { ok: true, value: { path: resolved.value, entries } };
}

/** One file's text. Refuses a directory, and refuses what is not text. */
export async function readProjectFile(
  repoRoot: string,
  requested: string
): Promise<Result<ProjectFileContent>> {
  const resolved = await resolveWithin(repoRoot, requested);
  if (!resolved.ok) return resolved;
  if (resolved.value === ".") return { ok: false, reason: "path is a directory" };

  const absolute = path.join(repoRoot, resolved.value);
  let stats;
  try {
    stats = await stat(absolute);
  } catch {
    return { ok: false, reason: "path cannot be resolved" };
  }
  if (stats.isDirectory()) return { ok: false, reason: "path is a directory" };
  if (!stats.isFile()) return { ok: false, reason: "path is not a regular file" };

  let buffer;
  try {
    buffer = await readFile(absolute);
  } catch {
    return { ok: false, reason: "file cannot be read" };
  }

  /* A NUL in the first block is the same heuristic git uses to call a file
     binary. Said plainly rather than returning mojibake a viewer would render
     as damage. */
  const head = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (head.includes(0)) return { ok: false, reason: "file is not text" };

  const truncated = buffer.length > PROJECT_FILE_READ_LIMIT_BYTES;
  return {
    ok: true,
    value: {
      path: resolved.value,
      text: buffer.subarray(0, PROJECT_FILE_READ_LIMIT_BYTES).toString("utf8"),
      bytes: buffer.length,
      truncated
    }
  };
}
