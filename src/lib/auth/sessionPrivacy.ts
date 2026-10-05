import type { Prisma } from '../../generated/prisma/index.js';
import { isStrictOwner, type StrictOwnerPrincipal } from './strictOwner.js';

export interface SessionReadPrincipal extends StrictOwnerPrincipal {
  appId?: string | null;
  sessionId?: string | null;
}

/** Only a pure App credential can use its validated conversation binding. */
export function hasBoundAppSession(principal: SessionReadPrincipal): boolean {
  return (
    !principal.userId &&
    !principal.impersonation &&
    typeof principal.appId === 'string' &&
    principal.appId.length > 0 &&
    typeof principal.sessionId === 'string' &&
    principal.sessionId.length > 0
  );
}

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
  principal: SessionReadPrincipal,
): Prisma.SessionWhereInput {
  const boundAppClause: Prisma.SessionWhereInput[] = hasBoundAppSession(
    principal,
  )
    ? [{ id: principal.sessionId!, appId: principal.appId! }]
    : [];
  return {
    OR: [
      { memoryId: null },
      { memory: { is: strictSessionMemoryFilter(principal) } },
      ...boundAppClause,
    ],
  };
}
