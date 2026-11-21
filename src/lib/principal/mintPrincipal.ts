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
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
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

/**
 * True iff `name` is a legal principal root name AS STORED (#4481). A pure grammar test: it does NOT lower-case, so
 * `isValidStoredRootName('Example')` is false. Callers judge the stored form; the mint and the probe lower-case
 * first (#4516 F4).
 */
export function isValidStoredRootName(name: string): boolean {
  return name.length <= MAX_ATOM_LEN && ROOT_NAME_RE.test(name);
}

/** The #4415 rule in words, its bound derived from `MAX_ATOM_LEN` so the text cannot drift from the lib (#4516 F7). */
export const ROOT_NAME_RULE_TEXT =
  `a root name is 1–${MAX_ATOM_LEN} lower-case ASCII letters, digits, ".", "_" or "-", ` +
  'beginning and ending with a letter or digit.';

/** The longest refused name echoed back in a message; the rest is elided (#4516 F7). */
const MAX_ECHOED_NAME_LEN = 80;

/** A refused name as it may appear in a message: bounded, then quoted and escaped. */
export function echoRootName(name: string): string {
  const shown = name.length > MAX_ECHOED_NAME_LEN ? `${name.slice(0, MAX_ECHOED_NAME_LEN)}…` : name;
  return JSON.stringify(shown);
}

/**
 * Thrown when a root name is outside the #4415 rule (see `isValidStoredRootName`) —
 * DISTINCT from {@link RootNameTakenError}: an illegal name is refused however
 * free it is, and a legal one is refused however taken. The GraphQL boundary
 * maps it to the `ROOT_NAME_INVALID` typed refusal.
 */
export class RootNameInvalidError extends Error {
  constructor(public readonly rootName: string, options?: { cause?: unknown }) {
    super(`Root name ${echoRootName(rootName)} is not a legal root name: ${ROOT_NAME_RULE_TEXT}`, options);
    this.name = 'RootNameInvalidError';
  }
}

type PrincipalDb = Pick<PrismaClient, 'principal'>;

/**
 * The #4400 CHECK that keeps every stored root name lower case (`name = lower(name)`), matched by its quoted name in
 * the constraint position of the primary message (#4547 BLIND P2, #4641 BLIND P2).
 *
 * No structured field is available to match instead: a model write's `PostgresError` carries code, message,
 * severity, detail, column and hint (no constraint name), and a P2010's `meta` carries only `code` and `message`.
 * So the message text is read, and only its positions are relied on.
 *
 * Evidence. The msgid is `new row for relation "%s" violates check constraint "%s"`. The server's own
 * `postgres-17.mo` catalogs (de es fr id it ja ka ko pl pt_BR ru sv tr uk zh_CN zh_TW) translate it with the relation
 * first and the constraint second in every one, so the constraint is the LAST quoted identifier. What varies is the
 * quote character (de » «; es, fr and id « »; the rest ASCII), spaces inside the quotes (fr, id), words between the
 * identifiers (ko, tr) and after the constraint (ja, ko, tr, ...). Spanish also quotes the literal word «check»
 * before the constraint. The pattern therefore accepts either quote family around the name, optionally with
 * spaces, then anything that holds no further quote. A different CHECK on a relation literally named like this one
 * quotes the name earlier, as the relation, and so does not match. Every catalog message is pinned in
 * `principalNameLower4411.test.ts`. A server the catalogs do not cover, or a quote style they do not use, falls
 * closed to the raw error.
 *
 * The quotes may be backslash-escaped: the engine renders a model write's Postgres error with inner ASCII quotes
 * as `\"`; a raw statement's `meta.message` is plain.
 */
const NAME_LOWER_CHECK_RE = /\\?["«»]\s*chk_principals_name_lower\s*\\?["«»][^"«»]*$/;

/**
 * The PRIMARY fields of the Postgres error inside a model write's message, as the query engine renders it:
 * `PostgresError { code: "23514", message: "…", severity: …, detail: Some("…"), … }`. Only these two fields are
 * judged (#4547 BLIND re-rate P2): the detail echoes the failing row's values and the rest of the rendering is free
 * text, so a name or a code found anywhere else proves nothing about which constraint refused.
 */
const ENGINE_PRIMARY_ERROR_RE = /PostgresError \{ code: "([0-9A-Z]{5})", message: "((?:[^"\\]|\\.)*)"/;

/**
 * #4411: true iff `err` is Postgres refusing a principal row under `chk_principals_name_lower` (SQLSTATE 23514),
 * in either shape Prisma reports it: a model write raises `PrismaClientUnknownRequestError` carrying the engine's
 * rendering of the Postgres error (Prisma 6 has no known code for a CHECK); a raw statement raises P2010 with the
 * SQLSTATE and the server's text (primary message first) in `meta`. `mintPrincipal` writes through `principal.create`, so only the first
 * shape reaches it today; the P2010 arm covers a caller-supplied client whose create runs raw SQL. Narrow on
 * purpose: it needs the check-violation SQLSTATE AND this constraint's name, both from the primary error, so any
 * other database error stays untyped. A rendering it cannot parse is not matched (fails closed to the raw error).
 */
function isNameLowerCheckViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    const primary = ENGINE_PRIMARY_ERROR_RE.exec(err.message);
    return primary !== null && primary[1] === '23514' && NAME_LOWER_CHECK_RE.test(primary[2]);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
    const meta = err.meta as { code?: unknown; message?: unknown } | undefined;
    // `meta.message` is the server's text: the primary message on its first line, then `DETAIL:` (the failing
    // row's values) and any `HINT:` on later lines. Only the first line is judged, as above.
    return meta?.code === '23514' && typeof meta.message === 'string'
      && NAME_LOWER_CHECK_RE.test(meta.message.split('\n', 1)[0]);
  }
  return false;
}

/** Why a probe answered as it did: free to mint, outside the #4415 rule, or claimed (reserved word or any row). */
export type RootAvailability = 'free' | 'invalid' | 'taken';

/**
 * The single availability seam (federation hook, D-2026-07-15-003). Today it
 * consults the local pool; a federated server later swaps this for a call to the
 * global name registry (#701) without touching any callsite. Returns true when
 * `name` (lowercased) is free to mint, with the reason otherwise (#4516 F5): `'invalid'` for a name the rule
 * refuses (however free), `'taken'` for a reserved word or a claimed row.
 */
export async function checkRootAvailable(db: PrincipalDb, name: string): Promise<RootAvailability> {
  const lower = name.toLowerCase();
  // #4481: a name outside the #4415 rule is not available to mint — the probe
  // and the mint must agree, or an availability check would green-light a mint
  // that then refuses.
  if (!isValidStoredRootName(lower)) return 'invalid';
  if (RESERVED_ROOT_NAMES.has(lower)) return 'taken';
  // `name` is a plain @unique and always stored lowercased, so this findUnique
  // is index-backed (no seq scan) and spans every status (a tombstone counts).
  const existing = await db.principal.findUnique({
    where: { name: lower },
    select: { id: true },
  });
  return existing === null ? 'free' : 'taken';
}

/**
 * Mint a principal for `name` under `kind`, returning the new principal id to
 * wire onto the owning user/org. Throws `RootNameInvalidError` if the name is
 * outside the #4415 root-name rule (see `isValidStoredRootName`) or the database's
 * `chk_principals_name_lower` refuses it (#4411), and
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
  if (!isValidStoredRootName(name)) throw new RootNameInvalidError(name);
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
    // #4411: the database refused the name as not lower case. Unreachable while the writer lower-cases and
    // `isValidStoredRootName` admits only lower-case ASCII (both above); it is the backstop for a name on which
    // JavaScript `toLowerCase()` and Postgres `lower()` disagree, surfaced as the same typed refusal as the rule
    // (one code for one cause, cor:urn:010:01) instead of a raw database error.
    // The database error is kept as `cause`: reaching this line means the writer and the CHECK disagree, a
    // platform bug rather than bad input, so whoever logs the refusal can see what Postgres said.
    if (isNameLowerCheckViolation(err)) throw new RootNameInvalidError(name, { cause: err });
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
