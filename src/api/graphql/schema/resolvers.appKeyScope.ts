// App key scopes — #1749 (Tickers S3, epic #1659), cor:aut:010:03 and :04.
//
// Granted and revoked ONLY by whoever manages the App (cor:dmo:050:05, :12): a
// holder, a plain member, an App key and an impersonating caller are all refused.
// Both writes take the App's authority anchor EXCLUSIVELY, the same anchor an App
// key's reads hold shared, so a revocation either committed before a read or
// waits for it, and the key's next call is refused. A new key holds none, and a
// rotated key (`regenerateAppKey`) is a new key, so it starts with none.

import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { actorManagesApp, inTaskWriteTx, loadApp, requireWritable, resolveTaskActor, taskError } from './resolvers.agentTask.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { APP_KEY_SCOPES, isAppKeyScope, type AppKeyScopeName } from '../../../lib/appKeyScopes/scopes.js';
import { generateId } from '../../../lib/id.js';

const keyNotFound = (id: string) => taskError('APP_KEY_NOT_FOUND', 'App key not found.', { id });

/** The key and its App as the caller may see them: a key of an App they do not participate in does not exist. */
async function resolveKey(ctx: Context, id: string) {
  const key = typeof id === 'string' ? await ctx.db.appKey.findUnique({ where: { id } }) : null;
  const app = key ? await loadApp(ctx, key.appId) : null;
  const actor = app ? await resolveTaskActor(ctx, app) : null;
  if (!key || !app || !actor) throw keyNotFound(id);
  return { key, app, actor };
}

async function changeScope(
  ctx: Context,
  id: string,
  scope: string,
  apply: (tx: Prisma.TransactionClient, keyId: string, scope: AppKeyScopeName, userId: string) => Promise<void>,
) {
  const { key, app, actor } = await resolveKey(ctx, id);
  requireWritable(ctx, app);
  if (!isAppKeyScope(scope)) {
    throw new GraphQLError(`Unknown scope "${scope}". The scopes are: ${APP_KEY_SCOPES.join(', ')}.`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  await inTaskWriteTx(ctx, app, actor, () => keyNotFound(id), async (tx, txCtx, fresh) => {
    // Whoever manages the App, as a person: not a worker's session, not a key, not an impersonation.
    if (!(await actorManagesApp(txCtx, fresh, actor)) || actor.kind !== 'user') {
      throw taskError('FORBIDDEN', 'Only whoever manages this App can change what its keys may do.');
    }
    const live = await tx.appKey.findFirst({ where: { id: key.id, appId: fresh.id, revokedAt: null }, select: { id: true } });
    if (!live) throw keyNotFound(id);
    await apply(tx, key.id, scope, actor.userId);
  }, { lockMode: 'exclusive' });
  return ctx.db.appKey.findUniqueOrThrow({ where: { id: key.id } });
}

export const appKeyScopeMutations = {
  grantAppKeyScope: (_: unknown, a: { id: string; scope: string }, ctx: Context) =>
    changeScope(ctx, a.id, a.scope, async (tx, keyId, scope, userId) => {
      // One live row per key and scope: granting again changes nothing, and keeps the first grant's record.
      const have = await tx.appKeyScope.findFirst({ where: { appKeyId: keyId, scope, revokedAt: null }, select: { id: true } });
      if (!have) await tx.appKeyScope.create({ data: { id: generateId(), appKeyId: keyId, scope, grantedByUserId: userId } });
    }),
  revokeAppKeyScope: (_: unknown, a: { id: string; scope: string }, ctx: Context) =>
    changeScope(ctx, a.id, a.scope, async (tx, keyId, scope, userId) => {
      await tx.appKeyScope.updateMany({
        where: { appKeyId: keyId, scope, revokedAt: null },
        data: { revokedAt: new Date(), revokedByUserId: userId },
      });
    }),
};

export const appKeyScopeFieldResolvers = {
  AppKey: {
    /**
     * The live scopes, for whoever manages the key's App. The key list is gated on managing, but an `AppKey` also reaches
     * callers through other fields (App.keys), which do not re-check: so this field does.
     */
    scopes: async (key: { id: string; appId: string }, _a: unknown, ctx: Context) => {
      const app = await ctx.db.app.findUnique({ where: { id: key.appId }, select: { id: true, organizationId: true, ownerUserId: true } });
      if (!app || !(await managesApp(ctx, app))) {
        throw taskError('FORBIDDEN', 'Only whoever manages this App can see what its keys may do.');
      }
      return ctx.db.appKeyScope.findMany({ where: { appKeyId: key.id, revokedAt: null }, orderBy: { grantedAt: 'asc' } });
    },
  },
  AppKeyScope: {
    grantedBy: (s: { grantedByUserId: string }) => s.grantedByUserId,
  },
};
