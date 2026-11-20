/**
 * The unified per-server principal pool (#692). One `Principal` row per root name
 * (a user handle OR an org name), enforcing CROSS-KIND uniqueness by constraint
 * so a URN `<root>` atom resolves to exactly one principal without an `@` sigil.
 *
 * `mintPrincipal` reserves a name; `releasePrincipal` tombstones it (kept forever,
 * never recycled). The atomic guard is the plain unique index on `name`, which
 * `chk_principals_name_lower` (name = lower(name), #4400) makes a guard across
 * case — a concurrent double-mint loses on P2002, which maps to
 * `RootNameTakenError` (the repo's check-then-insert idiom; no serializable txn,
 * mirroring `userHandle.ts`). Callers run these inside their own transaction and
 * keep the entity's denormalized `handle`/`urn` in sync.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { MAX_ATOM_LEN } from '../urn.js';

/** Root names reserved for the platform — cannot be minted by a user or org. */
export const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set<string>([
  'hadron',
  'hadronmemory',
  'hadron-memory',
  'platform',
  'host',
  'server',
  // Not a platform word — an object-store namespace. A storage key
  // begins with the memory URN's root atom, and `buildStagingKey`
  // reserves `staging/` for pre-verification bytes on the stated premise
  // that "no final key can collide with it". A principal named `staging`
  // would falsify that premise. Nothing in #889's orphan reaper depends
  // on this any more (it confirms every key against the database rather
  // than trusting the prefix), but the collision itself is still
  // confusing enough to keep out. Blocks new mints only; an existing
  // principal with this name would be unaffected.
  'staging',
]);

/** The kind of principal a root name belongs to. */
export type PrincipalKind = 'user' | 'org';

/**
 * Thrown when a root name is already claimed in the pool (by an active OR a
 * released/reserved row — tombstones keep their name forever) or is a reserved
 * platform word. Resolvers map it to a BAD_USER_INPUT / conflict.
 */
export class RootNameTakenError extends Error {
  constructor(public readonly rootName: string) {
    super(`Root name "${rootName}" is not available in the principal pool.`);
    this.name = 'RootNameTakenError';
  }
}

/**
 * The #4415 root-name rule, applied to the name AS STORED (post-`toLowerCase()`)
 * — a principal root is 1–64 lower-case ASCII letters, digits, `.`, `_` or `-`,
 * beginning and ending with a letter or digit: urn-lib's atom grammar
 * (`ATOM_RE`, `MAX_ATOM_LEN` = 64) restricted to lower case, spec
 * `hrn:node:hadronmemory.com:specs:cor:urn:010:01`. The pool is the last line
 * of defense: every caller validates first (`normalizeHandle` /
 * `validateOrgRoot`), but a new caller that skips those checks must not be able
 * to store a name the URN grammar cannot express — one whose lower-cased form
 * leaves ASCII (`İ` → `i̇`), where the writer's `toLowerCase()` and Postgres
 * `lower()` (`chk_principals_name_lower`, #4405) could disagree.
 */
const ROOT_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** True iff `name` (its lower-cased form) is a legal principal root name (#4481). */
export function isValidRootName(name: string): boolean {
  return name.length <= MAX_ATOM_LEN && ROOT_NAME_RE.test(name);
}

/**
 * Thrown when a root name is outside the #4415 rule (see `isValidRootName`) —
 * DISTINCT from {@link RootNameTakenError}: an illegal name is refused however
 * free it is, and a legal one is refused however taken. The GraphQL boundary
 * maps it to the `ROOT_NAME_INVALID` typed refusal.
 */
export class RootNameInvalidError extends Error {
  constructor(public readonly rootName: string) {
    super(
      `Root name "${rootName}" is not a legal root name: a root name is 1–64 ` +
        `lower-case ASCII letters, digits, ".", "_" or "-", beginning and ending with a letter or digit.`,
    );
    this.name = 'RootNameInvalidError';
  }
}

type PrincipalDb = Pick<PrismaClient, 'principal'>;

/**
 * The single availability seam (federation hook, D-2026-07-15-003). Today it
 * consults the local pool; a federated server later swaps this for a call to the
 * global name registry (#701) without touching any callsite. Returns true when
 * `name` (lowercased) is free to mint.
 */
export async function checkRootAvailable(db: PrincipalDb, name: string): Promise<boolean> {
  const lower = name.toLowerCase();
  // #4481: a name outside the #4415 rule is not available to mint — the probe
  // and the mint must agree, or an availability check would green-light a mint
  // that then refuses.
  if (!isValidRootName(lower)) return false;
  if (RESERVED_ROOT_NAMES.has(lower)) return false;
  // `name` is a plain @unique and always stored lowercased, so this findUnique
  // is index-backed (no seq scan) and spans every status (a tombstone counts).
  const existing = await db.principal.findUnique({
    where: { name: lower },
    select: { id: true },
  });
  return existing === null;
}

/**
 * Mint a principal for `name` under `kind`, returning the new principal id to
 * wire onto the owning user/org. Throws `RootNameInvalidError` if the name is
 * outside the #4415 root-name rule (see `isValidRootName`), and
 * `RootNameTakenError` if it is taken (reserved word, active, or tombstoned) —
 * the DB unique is the atomic backstop even under a concurrent race. Runs
 * inside the caller's transaction.
 */
export async function mintPrincipal(
  db: PrincipalDb,
  opts: { kind: PrincipalKind; name: string },
): Promise<{ id: string }> {
  const name = opts.name.toLowerCase();
  // #4481 (#4415): refuse a name outside the root-name rule BEFORE the insert
  // — the pool's own backstop, independent of the callers' validation. Checked
  // after lower-casing so the rule governs the name AS STORED (`Example` is
  // fine; `İ` is not, because its stored form leaves ASCII).
  if (!isValidRootName(name)) throw new RootNameInvalidError(name);
  if (RESERVED_ROOT_NAMES.has(name)) throw new RootNameTakenError(name);
  try {
    const principal = await db.principal.create({
      data: { name, kind: opts.kind, status: 'active' },
      select: { id: true },
    });
    return { id: principal.id };
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'P2002') {
      throw new RootNameTakenError(name);
    }
    throw err;
  }
}

/**
 * Tombstone a principal — mark it `released` and detach it from its owner. The
 * row (and its name) stays in the pool forever, so the name is never recycled
 * (indefinite tombstone). Call on rename (the old name) and owner deletion. The
 * caller sets the entity's `principalId` to the new/none value separately.
 */
export async function releasePrincipal(db: PrincipalDb, principalId: string): Promise<void> {
  // Active-only, so releasing twice (a merge retry, an already-tombstoned row) keeps the original `releasedAt`.
  await db.principal.updateMany({
    where: { id: principalId, status: 'active' },
    data: { status: 'released', releasedAt: new Date() },
  });
}

/**
 * Ensure a freshly created/upserted user row has a pool principal (#692) — mint
 * one for its handle and link it when missing. Idempotent (a user that already
 * has a principal, or has no handle yet, is a no-op), so it is safe to call
 * after every user create/upsert. **Run it in the same transaction as the user
 * write** so the mint + link are atomic (no orphan principal). Throws
 * `RootNameTakenError` only on a genuine cross-kind collision — the pool-aware
 * handle probe (`isHandleTaken`) makes that a near-impossible race.
 */
export async function ensureUserPrincipal(
  db: Pick<PrismaClient, 'principal' | 'user'>,
  user: { id: string; handle: string | null; principalId: string | null },
): Promise<void> {
  if (user.principalId || !user.handle) return;
  const principal = await mintPrincipal(db, { kind: 'user', name: user.handle });
  await db.user.update({ where: { id: user.id }, data: { principalId: principal.id } });
}

/**
 * Ensure an org row has a pool principal (#692) — idempotent. Used for orgs
 * created off the main `createOrganization` path (e.g. the personal workspace,
 * whose undotted slug is exempt from the dotted-root rule but still occupies the
 * pool). The DB unique is the backstop; call after the org create.
 */
export async function ensureOrgPrincipal(
  db: Pick<PrismaClient, 'principal' | 'organization'>,
  org: { id: string; urn: string; principalId: string | null },
): Promise<void> {
  if (org.principalId) return;
  const principal = await mintPrincipal(db, { kind: 'org', name: org.urn });
  await db.organization.update({ where: { id: org.id }, data: { principalId: principal.id } });
}
