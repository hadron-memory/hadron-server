/**
 * The account a credit ledger belongs to (subscription-billing-plan section 7, "One owner type"): an organization
 * today, and a person once Billing A6 (#5014) gives a person a ledger. Callers name the owner with this type so A6 can
 * widen every ledger function in one place. Compare owners explicitly by kind, never by a nullable column, so a person
 * owner can never read as "no organization" (finding org-xor-owner-null-comparison-bypass).
 */
export type OwnerRef = { organizationId: string } | { userId: string };

/** A person owner reached a ledger function that only knows organizations: a programming error, never a refusal. */
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
