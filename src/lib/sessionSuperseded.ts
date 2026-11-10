import { GraphQLError } from 'graphql';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';

/** #3818 V24/V25: use the session read predicate, never possession of an old session id, for successor disclosure. */
async function readableSession(ctx: Context, id: string) {
  // Lazy import keeps auth's shared binding gate independent of resolver-module initialization.
  const { sessionScopeFilter } = await import('../api/graphql/schema/resolvers.helpers.js');
  return ctx.db.session.findFirst({
    where: { AND: [{ id }, await sessionScopeFilter(ctx)] },
    select: { id: true, startedAt: true },
  });
}

/** Stored immediate successor is historical evidence, not a capability to read another session. */
export async function readableSupersedingSessionId(
  parent: { id: string }, _: unknown, ctx: Context,
): Promise<string | null> {
  const old = await ctx.db.session.findUnique({ where: { id: parent.id }, select: { supersededBySessionId: true } });
  if (!old?.supersededBySessionId) return null;
  return (await readableSession(ctx, old.supersededBySessionId))?.id ?? null;
}

/** Refuse an execution binding to a superseded session; current open session details require their own read gate. */
export async function refuseSupersededSession(ctx: Context, sessionId: string): Promise<void> {
  const old = await ctx.db.session.findUnique({
    where: { id: sessionId }, select: { endedAt: true, endReason: true, workerId: true },
  });
  if (!old?.endedAt || old.endReason !== 'superseded') return;
  const current = old.workerId ? await ctx.db.session.findFirst({
    where: { workerId: old.workerId, endedAt: null, deletedAt: null },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], select: { id: true },
  }) : null;
  const readable = current ? await readableSession(ctx, current.id) : null;
  throw new GraphQLError('Session superseded.', { extensions: {
    code: 'SESSION_SUPERSEDED',
    ...(readable ? { sessionId: readable.id, startedAt: readable.startedAt.toISOString() } : {}),
  } });
}
