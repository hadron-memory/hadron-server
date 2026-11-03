// App key scopes — #1749 (Tickers S3, epic #1659), cor:aut:010:03 and :04.
//
// Granted and revoked ONLY by whoever manages the App (cor:dmo:050:05, :12): a
// holder, a plain member, an App key and an impersonating caller are all refused.
// Both writes take the App's authority anchor EXCLUSIVELY, the same anchor an App
// key's reads hold shared, so a revocation either committed before a read or
// waits for it, and the key's next call is refused. A new key holds none, and a
// rotated key (`regenerateAppKey`) is a new key, so it starts with none.
//
// #1709: `host:operate` is granted FOR ONE HOST (cor:agt:070:04): the grant names
// the host, the row keeps it, and every host surface takes the host from it. A
// key operates as one host at a time: granting it for a second host is refused
// until the first is revoked. No other scope takes a host.

import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { actorManagesApp, inTaskWriteTx, loadApp, requireWritable, resolveTaskActor, taskError } from './resolvers.agentTask.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { requirePersonOnlyAct, type PersonOnlyAct } from '../../../lib/auth/personAsThemselves.js';
import { APP_KEY_SCOPES, isAppKeyScope, type AppKeyScopeName } from '../../../lib/appKeyScopes/scopes.js';
import { generateId } from '../../../lib/id.js';
import { HOST_ID_PATTERN } from '../../../lib/agentTasks/hosts.js';
import { appKeyHostUses } from './resolvers.hostOperation.js';
import { requireInstructedAct, type ActAdmission, type ActInstruction } from '../../../lib/auth/instructedAct.js';
import { readActInstruction, callerIsWorkerSession, lockCallerSession } from './resolvers.instruction.js';
import { appendCredentialInstructionEvent } from '../../../lib/agentTasks/events.js';

const keyNotFound = (id: string) => taskError('APP_KEY_NOT_FOUND', 'App key not found.', { id });
const scopeForbidden = () => taskError('FORBIDDEN', 'Only whoever manages this App can change what its keys may do.');

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
  /** Resolves to true when the call changed a row (a revoke of a scope the key does not hold changes nothing). */
  apply: (tx: Prisma.TransactionClient, keyId: string, scope: AppKeyScopeName, userId: string) => Promise<void | boolean>,
  hostId?: string | null,
  /** #3277: `grant.give` for grantAppKeyScope (person-only, cor:dmo:050:12). */
  personOnly?: PersonOnlyAct,
  /** #3311: revoking a scope is allowed on a holder's instruction (S6); only the revoke passes this. */
  revoke?: { instruction?: ActInstruction | null },
) {
  // A worker session never learns whether a key exists, so a malformed scope answers as a missing key does.
  if (revoke && !isAppKeyScope(scope) && await callerIsWorkerSession(ctx)) throw scopeForbidden();
  let resolved: Awaited<ReturnType<typeof resolveKey>>;
  try {
    resolved = await resolveKey(ctx, id);
  } catch (e) {
    // A worker session never learns whether a key exists: a missing key and one it may not act on answer alike.
    if (revoke && await callerIsWorkerSession(ctx)) throw scopeForbidden();
    throw e;
  }
  const { key, app, actor } = resolved;
  requireWritable(ctx, app);
  if (!isAppKeyScope(scope)) {
    throw new GraphQLError(`Unknown scope "${scope}". The scopes are: ${APP_KEY_SCOPES.join(', ')}.`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (hostId !== undefined) checkHostArg(scope, hostId);
  await inTaskWriteTx(ctx, app, actor, () => keyNotFound(id), async (tx, txCtx, fresh) => {
    let admission: ActAdmission | null = null;
    if (revoke) {
      // #3311: a person as themselves, or their held worker on a validated instruction; judged on the holder.
      // The session row is fenced before the judgement, so a session end cannot commit between it and the write.
      await lockCallerSession(tx, txCtx.sessionId);
      admission = await requireInstructedAct(txCtx, fresh.id, revoke.instruction, () => managesApp(txCtx, fresh), readActInstruction, scopeForbidden);
    } else
    // Whoever manages the App, as a person: not a worker's session, not a key, not an impersonation.
    if (!(await actorManagesApp(txCtx, fresh, actor)) || actor.kind !== 'user') throw scopeForbidden();
    // #3277: giving a scope is giving a grant, person-only (hrn:node:hadronmemory.com:specs:cor:dmo:050:12, ruling
    // 0099 A): the one person gate also refuses a worker session found on the session row, an ambiguous actor and a
    // run principal, which the actor check above does not see. Same refusal.
    if (personOnly) await requirePersonOnlyAct(txCtx, personOnly, scopeForbidden);
    const live = await tx.appKey.findFirst({ where: { id: key.id, appId: fresh.id, revokedAt: null }, select: { id: true } });
    if (!live) throw keyNotFound(id);
    const changed = await apply(tx, key.id, scope, (txCtx.userId ?? actor.userId)!);
    if (revoke && admission && changed) await appendCredentialInstructionEvent(tx, { appId: fresh.id, admission, act: 'app-key.scope-revoke' });
  }, { lockMode: 'exclusive', ...(actor.kind === 'worker' ? { lockWorkerIds: [actor.workerId] } : {}) });
  return ctx.db.appKey.findUniqueOrThrow({ where: { id: key.id } });
}

export const appKeyScopeMutations = {
  grantAppKeyScope: (_: unknown, a: { id: string; scope: string; hostId?: string | null }, ctx: Context) =>
    changeScope(ctx, a.id, a.scope, async (tx, keyId, scope, userId) => {
      const hostId = scope === 'host:operate' ? a.hostId!.trim() : null;
      // One live row per key and scope: granting again changes nothing, and keeps the first grant's record.
      const have = await tx.appKeyScope.findFirst({ where: { appKeyId: keyId, scope, revokedAt: null }, select: { id: true, hostId: true } });
      if (have && have.hostId !== hostId) {
        throw taskError(
          'APP_KEY_SCOPE_HOST_CONFLICT',
          `This key already operates as host ${have.hostId}. A host key reaches one host: revoke host:operate first, or use another key.`,
        );
      }
      if (!have) await tx.appKeyScope.create({ data: { id: generateId(), appKeyId: keyId, scope, grantedByUserId: userId, hostId } });
    }, a.hostId ?? null, 'grant.give'),
  revokeAppKeyScope: (_: unknown, a: { id: string; scope: string; instruction?: ActInstruction | null }, ctx: Context) =>
    changeScope(ctx, a.id, a.scope, async (tx, keyId, scope, userId) => {
      const ended = await tx.appKeyScope.updateMany({
        where: { appKeyId: keyId, scope, revokedAt: null },
        data: { revokedAt: new Date(), revokedByUserId: userId },
      });
      return ended.count > 0;
    }, undefined, undefined, { instruction: a.instruction }),
};

/** #1709: host:operate names exactly one host (cor:agt:070:04); no other scope takes one. */
function checkHostArg(scope: AppKeyScopeName, hostId: string | null): void {
  if (scope === 'host:operate') {
    if (!hostId || !HOST_ID_PATTERN.test(hostId.trim())) {
      throw new GraphQLError('host:operate is granted for one host: name it with hostId (a host token).', { extensions: { code: 'BAD_USER_INPUT' } });
    }
  } else if (hostId != null) {
    throw new GraphQLError(`${scope} is not granted for a host; send no hostId.`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
}

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
    /** #1709 — what the key did as a host (cor:agt:070:07). Gated the same way, for the same reason. */
    hostUses: (key: { id: string; appId: string }, a: { first?: number | null }, ctx: Context) => appKeyHostUses(key, a, ctx),
  },
  AppKeyScope: {
    grantedBy: (s: { grantedByUserId: string }) => s.grantedByUserId,
  },
};
