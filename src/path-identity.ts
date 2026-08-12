import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * When are two path strings the same file?
 *
 * Every scope guard in Hivemind -- the lease store, the allowed-files gate, the
 * forbidden and protected lists -- answers that question by comparing repo-
 * relative strings for byte equality. That substitution is exact on a
 * case-sensitive filesystem and WRONG on a case-insensitive one, where
 * `src/Foo.js` and `src/foo.js` are one file with two names.
 *
 * The consequence is not cosmetic. The lease store's whole job is that at most
 * one task holds write scope over a file; two spellings produce two keys, two
 * grants, and two workers writing the same bytes while the store and the
 * decision gate both report normal. The disjoint invariant defeated by the
 * shift key.
 *
 * `process.platform` is the wrong way to decide this. macOS is case-insensitive
 * by default and case-sensitive if you formatted it that way; Linux is
 * case-sensitive unless the directory carries the ext4 casefold flag; a network
 * mount or a disk image can be either anywhere. The filesystem is asked what it
 * does instead of being predicted from the kernel it runs on.
 */

export type PathCaseBehaviour = "case-sensitive" | "case-insensitive" | "unknown";

/* One probe per root per process. The answer is a property of a mounted volume,
   so it does not change under a running process in any way worth re-reading. */
const probes = new Map<string, Promise<PathCaseBehaviour>>();

export async function pathCaseBehaviour(repoRoot: string): Promise<PathCaseBehaviour> {
  const key = path.resolve(repoRoot);
  const cached = probes.get(key);
  if (cached !== undefined) return cached;
  const probe = probeCaseBehaviour(key);
  probes.set(key, probe);
  return probe;
}

/**
 * The comparison key for a repo-relative path.
 *
 * This is a key, never a value. The path a plan wrote is what gets stored in
 * the lease store, recorded in the trail, and shown to a person; folding the
 * stored spelling would make the record lie about what was asked for, and would
 * hand a worker a path spelled differently from the one its contract names.
 */
export function pathIdentityKey(pathValue: string, behaviour: PathCaseBehaviour): string {
  return behaviour === "case-sensitive" ? pathValue : foldPath(pathValue);
}

/**
 * Case folding is approximate, and pretending otherwise would be the same
 * over-claim as reading a capability off a declaration.
 *
 * `toLowerCase` matches what APFS and NTFS do for ASCII, which is every path in
 * every project seen so far. It is NOT identical to either for exotic pairs:
 * APFS folds full Unicode and compares normalisation-insensitively, NTFS uses a
 * fixed upcase table frozen per volume at format time. A path pair that folds
 * equal on the volume but not here would still produce two lease keys.
 * ASCII-only is the claim; anything beyond it is unverified.
 */
export function foldPath(pathValue: string): string {
  return pathValue.toLowerCase();
}

/**
 * Ask the volume, by name lookup only.
 *
 * Nothing is written. An earlier draft created a probe file under `.hivemind/`,
 * which works but pollutes a directory during the window between create and
 * unlink and fails on a read-only checkout. Flipping the case of a name that
 * already exists costs two `stat` calls and no side effects at all.
 *
 * Inode identity is the test rather than "did the stat succeed", because on a
 * case-sensitive volume somebody may genuinely have both `.git` and `.GIT`;
 * that is two files, and the dev/ino pair says so.
 */
async function probeCaseBehaviour(repoRoot: string): Promise<PathCaseBehaviour> {
  for (const candidate of await probeCandidates(repoRoot)) {
    const verdict = await compareSpellings(candidate.directory, candidate.name);
    if (verdict !== "unknown") return verdict;
  }
  return "unknown";
}

async function probeCandidates(
  repoRoot: string
): Promise<{ directory: string; name: string }[]> {
  const candidates: { directory: string; name: string }[] = [];

  /* `.git` first: it is in the repo root, so it is on the volume the repo's
     files live on, and in a git repository it always exists -- as a directory
     normally, as a file in a linked worktree. Either stats fine. */
  candidates.push({ directory: repoRoot, name: ".git" });

  try {
    const entries = await readdir(repoRoot);
    for (const entry of entries.slice(0, 64)) {
      if (entry !== ".git") candidates.push({ directory: repoRoot, name: entry });
    }
  } catch {
    /* Unreadable root. The caller is about to fail on its own terms. */
  }

  /* Last resort for a root that is empty or whose every entry is digits: ask
     about the root's own name in its parent. This measures the parent's volume,
     which differs from the root's only when the root is itself a mount point --
     rare enough to accept as the final fallback rather than the first choice. */
  const parent = path.dirname(repoRoot);
  const base = path.basename(repoRoot);
  if (parent !== repoRoot && base !== "") candidates.push({ directory: parent, name: base });

  return candidates;
}

async function compareSpellings(directory: string, name: string): Promise<PathCaseBehaviour> {
  const flipped = flipAsciiCase(name);
  if (flipped === name) return "unknown";

  const original = await statOrNull(path.join(directory, name));
  if (original === null) return "unknown";
  const other = await statOrNull(path.join(directory, flipped));
  if (other === null) return "case-sensitive";

  return other.dev === original.dev && other.ino === original.ino
    ? "case-insensitive"
    : "case-sensitive";
}

async function statOrNull(target: string): Promise<{ dev: bigint; ino: bigint } | null> {
  try {
    /* bigint, because a 64-bit inode silently loses precision as a JS number
       and this comparison is the whole probe. */
    const stats = await stat(target, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

function flipAsciiCase(value: string): string {
  let flipped = "";
  for (const char of value) {
    if (char >= "a" && char <= "z") flipped += char.toUpperCase();
    else if (char >= "A" && char <= "Z") flipped += char.toLowerCase();
    else flipped += char;
  }
  return flipped;
}
