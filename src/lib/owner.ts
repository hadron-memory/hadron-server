/**
 * "An organization or a person": the one owner value the limit, ledger and billing code passes (#5006). Never a nullable
 * organization id. An App, Agent or Memory stores the same choice as `organizationId` XOR `ownerUserId`.
 */
export type OwnerRef = { organizationId: string } | { userId: string };
export type OwnerType = 'organization' | 'user';

export const ownerType = (owner: OwnerRef): OwnerType => ('organizationId' in owner ? 'organization' : 'user');
export const ownerId = (owner: OwnerRef): string => ('organizationId' in owner ? owner.organizationId : owner.userId);

/** The two owner columns of an App, Agent or Memory row. */
export type OwnedRow = { organizationId: string | null; ownerUserId: string | null };

/**
 * #5075: the owner a row names. Branches on `ownerUserId` first, as `requireOwnerOrOrgRole` does, and answers null for a
 * row with neither column set: two ownerless rows are never "the same owner".
 */
export function ownerRefOf(row: OwnedRow | null | undefined): OwnerRef | null {
  if (!row) return null;
  if (row.ownerUserId != null) return { userId: row.ownerUserId };
  if (row.organizationId != null) return { organizationId: row.organizationId };
  return null;
}

/**
 * cor:dmo:170:05 (the owner of the work is the owner of the App the work ran in): the App's owner when there is an App,
 * else the Agent's. An App row with no owner at all answers null rather than falling through to the Agent.
 */
export function ownerOfWork(app: OwnedRow | null | undefined, agent: OwnedRow | null | undefined): OwnerRef | null {
  return app ? ownerRefOf(app) : ownerRefOf(agent);
}

/**
 * #5014 (billing A6): the two owner columns an OwnerRef names, exactly one set. A value naming neither, or both, is a
 * programming error and is refused before any write: a ledger entry always has one owner, and a typed refusal here is what
 * keeps an `{}` cast or a spread of two owners from reaching the CHECK as an opaque 23514.
 */
export function ownerColumns(owner: OwnerRef): { organizationId: string | null; ownerUserId: string | null } {
  const org = 'organizationId' in owner ? (owner as { organizationId?: unknown }).organizationId : undefined;
  const user = 'userId' in owner ? (owner as { userId?: unknown }).userId : undefined;
  const hasOrg = typeof org === 'string' && org.length > 0;
  const hasUser = typeof user === 'string' && user.length > 0;
  if (hasOrg === hasUser) throw new Error('An owner names exactly one of an organization and a person.');
  return hasUser ? { organizationId: null, ownerUserId: user as string } : { organizationId: org as string, ownerUserId: null };
}

/**
 * #5014: is a stored row owned by `owner`? Branches on the OWNER'S class first, then compares that one column, so two NULL
 * columns (an organization's entry and a person's entry both have one) are never "the same owner" (Hadron finding
 * hrn:node:hadronmemory.com:hadron-server:findings:org-xor-owner-null-comparison-bypass): comparing both columns with `===` would call a person's entry the same as another
 * person's whenever both organization columns are null.
 */
export function sameOwner(row: OwnedRow, owner: OwnerRef): boolean {
  const cols = ownerColumns(owner);
  return cols.ownerUserId != null ? row.ownerUserId === cols.ownerUserId : row.organizationId === cols.organizationId;
}
/** #5014: the Prisma `where` that selects an owner's rows by the ONE column it sets (never both: a cleared link must not hide a row). */
export function ownerWhere(owner: OwnerRef): { organizationId: string } | { ownerUserId: string } {
  const cols = ownerColumns(owner);
  return cols.ownerUserId != null ? { ownerUserId: cols.ownerUserId } : { organizationId: cols.organizationId as string };

}

/**
 * #5077 (Billing F3a; finding hrn:node:hadronmemory.com:hadron-server:findings:org-xor-owner-null-comparison-bypass):
 * the run path's tenant. Unlike {@link ownerRefOf}, a row that names no owner, or both, THROWS: a malformed run or App
 * fails closed (the run fails, the launch refuses) and never becomes a null that widens a filter or passes a `null !==
 * null` comparison.
 */
export function requireOwnerRefOf(row: OwnedRow): OwnerRef {
  const hasOrg = typeof row.organizationId === 'string' && row.organizationId.length > 0;
  const hasUser = typeof row.ownerUserId === 'string' && row.ownerUserId.length > 0;
  if (hasOrg === hasUser) throw new Error('A run-path row names exactly one owner: an organization or a person.');
  return hasUser ? { userId: row.ownerUserId as string } : { organizationId: row.organizationId as string };
}

/**
 * #5077: the Prisma filter for "rows this owner owns" that ALWAYS states both columns, so an organization's filter also
 * says `ownerUserId: null` and a person's says `organizationId: null`. Never `{ organizationId: null }` alone, which is
 * `IS NULL` and would match every person's row.
 */
export function ownedBy(owner: OwnerRef): { organizationId: string | null; ownerUserId: string | null } {
  return ownerColumns(owner);
}

/**
 * #5077: true only when the row has exactly one owner and it is `owner`. Two nulls never match, and a row naming both
 * owners matches nobody.
 */
export function isOwnedBy(row: OwnedRow, owner: OwnerRef): boolean {
  const cols = ownerColumns(owner);
  return cols.ownerUserId != null
    ? row.organizationId == null && row.ownerUserId === cols.ownerUserId
    : row.ownerUserId == null && row.organizationId === cols.organizationId;
}

/** #5077: the organization id of an owner, or null for a person. For a feature only an organization has: refuse on null before any query. */
export function orgIdOf(owner: OwnerRef): string | null {
  return 'organizationId' in owner ? owner.organizationId : null;
}

/** #5077: are two owner values the same owner? Never true across kinds. */
export function sameOwnerRef(a: OwnerRef, b: OwnerRef): boolean {
  const ca = ownerColumns(a);
  const cb = ownerColumns(b);
  return ca.ownerUserId != null ? ca.ownerUserId === cb.ownerUserId : ca.organizationId === cb.organizationId && cb.ownerUserId == null;
}

/**
 * #5077 (decision a): the deploy-window switch for runs of an App a person owns. Only the exact value `true`, read per
 * call. Off: the manual gate answers as before and mint refuses a person as owner with APP_NOT_FOUND.
 */
export function personalAppRunsEnabled(): boolean {
  return process.env.PERSONAL_APP_RUNS_ENABLED === 'true';
}
