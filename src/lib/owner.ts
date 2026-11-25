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
 * The rule (finding org-xor-owner-null-comparison-bypass; the person ledger of #5014, A6, implements the comparison):
 * compare owners explicitly by KIND, never by a nullable column, so a person owner can never read as "no organization" and
 * two persons' null organization columns are never "the same owner". This file states it; it adds no comparison code.
 * A function that only knows organizations refuses a person with the error below instead of treating it as an absent one.
 *
 * A person owner reached a ledger function that only knows organizations: a programming error, never a refusal.
 */
export class PersonLedgerNotSupportedError extends Error {
  constructor() {
    super('A person ledger is not supported yet (Billing A6, #5014).');
    this.name = 'PersonLedgerNotSupportedError';
  }
}

/** The organization id of an organization owner; throws for a person owner until A6. */
export function ownerOrganizationId(owner: OwnerRef): string {
  if ('organizationId' in owner && typeof owner.organizationId === 'string' && owner.organizationId !== '') {
    return owner.organizationId;
  }
  throw new PersonLedgerNotSupportedError();
}
