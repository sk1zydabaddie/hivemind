import { pathIdentityKey, type PathCaseBehaviour } from "./path-identity.js";

/**
 * The lease store, read as files rather than as strings.
 *
 * The stored shape is unchanged -- repo-relative path to task id, exactly the
 * spelling the plan used, which is what the trail and every surface show. What
 * changes is how it is *looked up*: through a folded key when the filesystem
 * says two spellings name one file.
 *
 * Everything here is pure, and that is deliberate. The filesystem's behaviour
 * is a probe result; the decision that follows from it is arithmetic, and
 * arithmetic can be tested for both answers on a machine that can only produce
 * one of them.
 */

export type LeaseStore = Record<string, string>;

export interface LeaseIndex {
  /** Who holds the file this path names, whatever spelling either side used. */
  holderOf: (pathValue: string) => string | undefined;
  /** The spelling already recorded for this file, if it is already leased. */
  keyOf: (pathValue: string) => string | undefined;
}

export function buildLeaseIndex(store: LeaseStore, behaviour: PathCaseBehaviour): LeaseIndex {
  const byIdentity = new Map<string, { key: string; holder: string }>();
  for (const [key, holder] of Object.entries(store)) {
    const identity = pathIdentityKey(key, behaviour);
    /* First writer wins on a collision. A store that already holds two
       spellings of one file is a store written before this fix existed;
       `findLeaseStoreCollisions` reports it rather than letting a lookup pick
       one arbitrarily and call it normal. */
    if (!byIdentity.has(identity)) byIdentity.set(identity, { key, holder });
  }
  return {
    holderOf: (pathValue) => byIdentity.get(pathIdentityKey(pathValue, behaviour))?.holder,
    keyOf: (pathValue) => byIdentity.get(pathIdentityKey(pathValue, behaviour))?.key
  };
}

/**
 * Two keys in a stored lease file that name the same file.
 *
 * This state is unreachable once grants go through the index, so finding it
 * means the file was written by an older build or edited by hand. It is
 * reported on read instead of being tolerated, because tolerating it is exactly
 * the failure being fixed: two holders over one file, everything reporting
 * normal.
 */
export function findLeaseStoreCollisions(
  store: LeaseStore,
  behaviour: PathCaseBehaviour
): { left: string; right: string } | null {
  return findCaseCollision(Object.keys(store), behaviour);
}

/**
 * Two paths in one scope list that name the same file.
 *
 * Deduplicating these silently would be the wrong repair. On a case-insensitive
 * volume a plan naming both `src/Foo.js` and `src/foo.js` has made a mistake a
 * person should see -- it almost certainly meant two files and will get one --
 * and quietly collapsing them hides it. On a case-sensitive volume they really
 * are two files and nothing is reported.
 */
export function findCaseCollision(
  paths: string[],
  behaviour: PathCaseBehaviour
): { left: string; right: string } | null {
  const byIdentity = new Map<string, string>();
  for (const pathValue of paths) {
    const identity = pathIdentityKey(pathValue, behaviour);
    const existing = byIdentity.get(identity);
    if (existing !== undefined && existing !== pathValue) {
      return { left: existing, right: pathValue };
    }
    byIdentity.set(identity, pathValue);
  }
  return null;
}
