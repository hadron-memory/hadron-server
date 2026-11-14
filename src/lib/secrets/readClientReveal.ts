/**
 * #3998 (S3 of #3991, cor:sec:060): the reveal. A WORKER bound to the request, holding an active, live `secret.reveal` grant,
 * reads the value of the App secret the grant names, once per call, spending exactly one use. A person holder reveals only on the
 * server-hosted passkey page (a later slice): this door is never open to a person, an App key, a run or an impersonation.
 *
 * Everything is judged under the secret row's lock and the grant row's lock, on the database clock, and the use and the audit
 * event commit before the value leaves this function. A client id that is unknown, belongs to another holder or another App is
 * the one uniform SECRET_READ_CLIENT_NOT_FOUND, so a client id is no existence oracle. Past that, the refusal names the state.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { withAuthorizedTx } from '../../api/graphql/schema/authorizedTx.js';
import { boundWorkerId } from '../bootPrompt.js';
import { readGrantForUpdate } from '../grants/live.js';
import { isModelReadableKind } from '../secrets.js';
import { currentAppSecretValue, lockSecretRow, recordSecretEvent, secretActorOf } from './appSecrets.js';
import { judgeSecretReadClientIssuer, SECRET_READ_CLIENT_SUPERSEDED } from './readClientIssuer.js';
import { authorizationDenied } from '../auth/authorizationDenied.js';

export const SECRET_READ_CLIENT_NOT_FOUND = 'SECRET_READ_CLIENT_NOT_FOUND';

export type ReadClientState = 'PENDING' | 'NOT_STARTED' | 'EXPIRED' | 'SPENT' | 'REVOKED' | 'SECRET_DELETED' | 'ISSUER_GONE' | 'ENDED';

function refusal(code: string, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}
const notFound = () => refusal(SECRET_READ_CLIENT_NOT_FOUND, 'No such read client.');

/** The state of a grant row that is not live, by the cause that applies first. Pure: the caller read the row under its lock. */
export function deadGrantState(r: {
  activatedAt: Date | null; revokedAt: Date | null; holderDepartedAt: Date | null; startsAt: Date | null; expiresAt: Date | null;
  maxUses: number | null; useCount: number;
}, now: Date): ReadClientState {
  if (r.revokedAt || r.holderDepartedAt) return 'REVOKED';
  if (!r.activatedAt) return 'PENDING';
  if (r.maxUses !== null && r.useCount >= r.maxUses) return 'SPENT';
  if (r.expiresAt && r.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (r.startsAt && r.startsAt.getTime() > now.getTime()) return 'NOT_STARTED';
  return 'ENDED';
}

export async function revealWithReadClient(ctx: Context, clientId: string): Promise<{ value: string; secretName: string; readsLeft: number | null }> {
  const workerId = boundWorkerId();
  // A bound worker only. A person, an App key, a run and an impersonation get the uniform answer.
  if (!workerId || !ctx.userId || ctx.impersonation) throw notFound();
  const pre = await ctx.db.secretReadClient.findUnique({ where: { id: clientId }, select: { appId: true, secretId: true, grantId: true } });
  if (!pre) throw notFound();
  const app = await ctx.db.app.findUnique({ where: { id: pre.appId }, select: { id: true, organizationId: true, ownerUserId: true } });
  if (!app) throw notFound();
  const anchors = [
    { kind: 'app' as const, id: app.id },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
  ];
  const actor = secretActorOf(ctx);
  // A refused read on the holder's own client is recorded (cor:sec:060:02, cor:sec:010:05). The refusal rolls its transaction back,
  // so the record is written afterwards in its own, and only once the holder check has passed: a stranger leaves no trace.
  let known: { ownerId: string; secretId: string; secretName: string } | null = null;
  try {
  return await withAuthorizedTx(ctx, anchors, async () => undefined, async (tx, txCtx) => {
    // Lock order: secret row, then grant row (the same as issuing and deleting).
    const secretLocked = await lockSecretRow(tx, pre.secretId);
    const client = await tx.secretReadClient.findUnique({ where: { id: clientId } });
    if (!client) throw notFound();
    const grant = await tx.grant.findUnique({ where: { id: client.grantId }, select: { workerId: true, action: true, appId: true, issuerUserId: true } });
    if (!grant || grant.action !== 'secret.reveal' || grant.workerId !== workerId || grant.appId !== client.appId) throw notFound();
    known = { ownerId: client.appId, secretId: client.secretId, secretName: client.secretName };
    if (!secretLocked || client.endedAt) throw refusal('SECRET_DELETED', 'The secret this client read has been deleted.');
    const secret = await tx.secret.findUnique({ where: { id: client.secretId }, select: { id: true, name: true, kind: true, ownerId: true, ownerType: true } });
    if (!secret || secret.ownerType !== 'app' || secret.ownerId !== client.appId) throw refusal('SECRET_DELETED', 'The secret this client read has been deleted.');
    if (!isModelReadableKind(secret.kind)) throw authorizationDenied();
    const locked = await readGrantForUpdate(tx, client.grantId);
    if (!locked) throw notFound();
    if (!locked.live) {
      const g = await tx.grant.findUniqueOrThrow({
        where: { id: client.grantId },
        select: { activatedAt: true, revokedAt: true, holderDepartedAt: true, startsAt: true, expiresAt: true, maxUses: true, useCount: true },
      });
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`);
      const state = deadGrantState(g, now);
      throw refusal(`SECRET_READ_CLIENT_${state}`, `This read client cannot read: ${state}.`);
    }
    // An erased issuer stops the reads; a demoted, departed or superseded one too (the issuer rule is judged again).
    // The grant's own issuer link is the CURRENT one: it follows an account merge and is nulled by erasure. The client row's copy is sealed history.
    const issuerUserId = grant.issuerUserId;
    if (!issuerUserId) throw refusal('SECRET_READ_CLIENT_ISSUER_GONE', 'This read client has no issuer.');
    try {
      await judgeSecretReadClientIssuer({ ...txCtx, db: tx } as Context, issuerUserId, secret.id);
    } catch (e) {
      if (e instanceof GraphQLError && e.extensions?.code === SECRET_READ_CLIENT_SUPERSEDED) throw e;
      throw refusal('SECRET_READ_CLIENT_ISSUER_GONE', 'The issuer of this read client may no longer issue it.');
    }
    // One use, guarded by the grant row itself (exactly +1 on a live row), and its USE event.
    const spent = await tx.$executeRaw`UPDATE grants SET use_count = use_count + 1, updated_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = ${client.grantId}`;
    if (spent !== 1) throw notFound();
    await tx.grantEvent.create({ data: { grantId: client.grantId, appId: client.appId, action: 'USE', workerId } });
    const newest = await tx.secretVersion.findFirst({ where: { secretId: secret.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
    await recordSecretEvent(tx, { ownerId: secret.ownerId, secretId: secret.id, secretName: secret.name, kind: 'REVEAL', versionNo: newest?.versionNo ?? null, actor });
    const value = await currentAppSecretValue(tx, { id: secret.id, ownerId: secret.ownerId });
    const after = await tx.grant.findUniqueOrThrow({ where: { id: client.grantId }, select: { maxUses: true, useCount: true } });
    return { value: JSON.stringify(value), secretName: secret.name, readsLeft: after.maxUses === null ? null : after.maxUses - after.useCount };
  });
  } catch (e) {
    const code = e instanceof GraphQLError ? String(e.extensions?.code ?? '') : '';
    const k = known as { ownerId: string; secretId: string; secretName: string } | null;
    if (k && code && code !== SECRET_READ_CLIENT_NOT_FOUND) {
      await recordSecretEvent(ctx.db as never, { ...k, kind: 'REVEAL', outcome: code, actor }).catch(() => undefined);
    }
    throw e;
  }
}
