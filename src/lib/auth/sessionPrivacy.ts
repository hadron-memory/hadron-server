import type { Prisma } from '../../generated/prisma/index.js';
import { isStrictOwner, type StrictOwnerPrincipal } from './strictOwner.js';

/** #1645 / DT: binding a conversation never grants admin access to its owner's memory. */
export function strictSessionMemoryFilter(
  principal: StrictOwnerPrincipal,
): Prisma.MemoryWhereInput {
  const ownerClause: Prisma.MemoryWhereInput[] = isStrictOwner(
    principal,
    principal.userId,
  )
    ? [{ userId: principal.userId!, class: { in: ['personal', 'private'] } }]
    : [];
  return {
    OR: [{ class: { notIn: ['personal', 'private'] } }, ...ownerClause],
  };
}

/** Preserve unbound sessions; apply the strict-owner boundary to bound conversations. */
export function boundSessionPrivacyFilter(
  principal: StrictOwnerPrincipal,
): Prisma.SessionWhereInput {
  return {
    OR: [
      { memoryId: null },
      { memory: { is: strictSessionMemoryFilter(principal) } },
    ],
  };
}
