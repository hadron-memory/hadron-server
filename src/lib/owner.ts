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
 * columns (an organization's entry and a person's entry both have one) are never "the same owner" (finding
 * org-xor-owner-null-comparison-bypass): comparing both columns with `===` would call a person's entry the same as another
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
