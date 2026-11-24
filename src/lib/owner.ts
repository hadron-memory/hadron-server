/**
 * "An organization or a person": the one owner value the limit, ledger and billing code passes (#5006). Never a nullable
 * organization id. An App, Agent or Memory stores the same choice as `organizationId` XOR `ownerUserId`.
 */
export type OwnerRef = { organizationId: string } | { userId: string };
export type OwnerType = 'organization' | 'user';

export const ownerType = (owner: OwnerRef): OwnerType => ('organizationId' in owner ? 'organization' : 'user');
export const ownerId = (owner: OwnerRef): string => ('organizationId' in owner ? owner.organizationId : owner.userId);
