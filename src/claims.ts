/**
 * One representation of what an operation may write, used alike to plan,
 * to admit a run and to admit a filing . A claim is a key:
 *
 * - `drive:file:<id>` — a Drive file the operation may update, or created;
 * - `drive:folder:<id>` — a folder it may create files in (exclusive in this
 *   first change);
 * - `resource:<name>` — a task's explicit resource (unchanged meaning);
 * - `local:<root>:<path>` — a path it may write, qualified by the actual
 *   root it writes under (a run's own workspace).
 *
 * A write intent on a create is `drive:create:<folder>:<intent id>`: while it
 * is unresolved it fences every other operation that holds any Drive file
 * or the same folder, since the new file's ID is not known yet.
 *
 * An internal registry cannot keep people or other clients from editing a
 * Drive file; it orders this orchestrator's own writers only.
 */
export type Claim = string;

export const driveFileClaim = (id: string): Claim => "drive:file:" + id;
export const driveFolderClaim = (id: string): Claim => "drive:folder:" + id;
export const resourceClaim = (name: string): Claim => "resource:" + name;
export const createIntentClaim = (folder: string, intent: string): Claim =>
  "drive:create:" + folder + ":" + intent;
/** A local path under one root; the root is encoded so a colon in it cannot split the key. */
export const localClaim = (root: string, path: string): Claim =>
  "local:" + encodeURIComponent(root) + ":" + path;

function local(claim: Claim): { root: string; path: string } | undefined {
  const m = /^local:([^:]*):(.*)$/.exec(claim);
  return m ? { root: decodeURIComponent(m[1]!), path: m[2]! } : undefined;
}
function createIntent(claim: Claim): { folder: string } | undefined {
  const m = /^drive:create:([^:]+):/.exec(claim);
  return m ? { folder: m[1]! } : undefined;
}
/** Whether two relative paths overlap: equal, or one inside the other. */
export function pathsOverlap(a: string, b: string): boolean {
  const clean = (p: string) => p.replace(/\/+$/, "");
  const x = clean(a),
    y = clean(b);
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/") || !x || !y;
}

/**
 * Whether two claims conflict: equal keys; local paths under the same root
 * that overlap; or an unresolved create intent against any Drive file claim
 * or its own folder (the create fence).
 */
export function claimsConflict(a: Claim, b: Claim): boolean {
  if (a === b) return true;
  const la = local(a),
    lb = local(b);
  if (la && lb) return la.root === lb.root && pathsOverlap(la.path, lb.path);
  const fence = (intent: Claim, other: Claim) => {
    const c = createIntent(intent);
    return (
      !!c &&
      (other.startsWith("drive:file:") || other === driveFolderClaim(c.folder))
    );
  };
  return fence(a, b) || fence(b, a);
}

/** The first pair of conflicting claims between two sets, if any. */
export function firstConflict(
  mine: readonly Claim[],
  theirs: readonly Claim[],
): [Claim, Claim] | undefined {
  for (const a of mine)
    for (const b of theirs) if (claimsConflict(a, b)) return [a, b];
  return undefined;
}
