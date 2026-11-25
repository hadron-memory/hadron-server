/**
 * #5183 / #5218 (cor:dmo:060:20): the two judgements `createMemoryInApp` makes for a personal or private memory,
 * shared so a read of "which classes may I still create" (#5218) runs the door's own check, never a copy.
 */
import type { Prisma, PrismaClient } from '../../../generated/prisma/index.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import type { Context } from './resolvers.helpers.js';

/** S12 "Person only": true when the caller is NOT the signed-in member acting as themselves. Needs a user id too. */
export function refusedAppUserMemoryPrincipal(ctx: Context): boolean {
  return !ctx.userId || !!(ctx.appKeyId || ctx.sessionId || ctx.sessionBindingRefused || ctx.impersonation || isRunPrincipal(ctx));
}

/** The classes in which the user already holds a live marked memory in the App (the limit's count; no id, no URN). */
export async function heldAppUserMemoryClasses(
  db: PrismaClient | Prisma.TransactionClient,
  appId: string,
  userId: string,
): Promise<Array<'personal' | 'private'>> {
  const rows = await db.memory.findMany({
    where: { appId, userId, appUserMemory: true, deletedAt: null, class: { in: ['personal', 'private'] } },
    select: { class: true },
    distinct: ['class'],
  });
  return rows.map((r) => r.class as 'personal' | 'private');
}
