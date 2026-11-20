import { evaluatePolicyChain } from '@hadron-memory/access-control';
import { parseRunPolicySnapshot } from '../runner/runPolicy.js';
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
import { isAppParticipant } from '../auth/appParticipantRead.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
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

export interface RevealResult { value: string; secretName: string; readsLeft: number | null }

/** The GraphQL door: a bound worker only. A person, an App key, a run and an impersonation get the uniform answer. */
export async function revealWithReadClient(ctx: Context, clientId: string): Promise<RevealResult> {
  const workerId = boundWorkerId();
  if (!workerId || !ctx.userId || ctx.appKeyId || ctx.impersonation || isRunPrincipal(ctx)) throw notFound();
  return revealAs(ctx, clientId, { kind: 'worker', workerId });
}

/**
 * The passkey page's door (cor:sec:060, ruling R5): a PERSON holder, as themselves, after a passkey assertion the caller has
 * already verified for `userId`. Never reachable from an API token; `ctx` is built by the page from the proven person alone.
 */
export async function revealForPersonHolder(ctx: Context, clientId: string): Promise<RevealResult> {
  if (!ctx.userId || ctx.impersonation || boundWorkerId()) throw notFound();
  return revealAs(ctx, clientId, { kind: 'person', userId: ctx.userId });
}

type Holder = { kind: 'worker'; workerId: string } | { kind: 'person'; userId: string };

async function revealAs(ctx: Context, clientId: string, holder: Holder): Promise<RevealResult> {
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
  // A refused read on a KNOWN client is recorded (cor:sec:060:02, cor:sec:010:05), a wrong holder's included: the answer to the caller
  // stays the one uniform not-found, but the secret's owner sees that someone presented a real client id. An unknown id names no
  // secret, so it leaves nothing. The refusal rolls its transaction back, so the record is written afterwards in its own.
  let known: { ownerId: string; secretId: string; secretName: string } | null = null;
  try {
  return await withAuthorizedTx(ctx, anchors, async () => undefined, async (tx, txCtx) => {
    // Lock order: secret row, then grant row (the same as issuing and deleting).
    const secretLocked = await lockSecretRow(tx, pre.secretId);
    const client = await tx.secretReadClient.findUnique({ where: { id: clientId } });
    if (!client) throw notFound();
    const grant = await tx.grant.findUnique({ where: { id: client.grantId }, select: { workerId: true, userId: true, agentId: true, action: true, appId: true, issuerUserId: true } });
    if (!grant || grant.action !== 'secret.reveal' || grant.appId !== client.appId) throw notFound();
    const heldBy = holder.kind === 'worker'
      ? grant.workerId === holder.workerId
      : grant.userId === holder.userId && grant.workerId === null && grant.agentId === null;
    // From here the client is a real one in this App for this action: every refusal below, a wrong holder's too, is recorded.
    known = { ownerId: client.appId, secretId: client.secretId, secretName: client.secretName };
    if (!heldBy) throw notFound();
    // A person holder must still be an App participant at every read (R5).
    if (holder.kind === 'person' && !(await isAppParticipant({ ...txCtx, db: tx } as Context, app))) throw notFound();
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
    await tx.grantEvent.create({ data: { grantId: client.grantId, appId: client.appId, action: 'USE', ...(holder.kind === 'worker' ? { workerId: holder.workerId } : { actorUserId: holder.userId }) } });
    const newest = await tx.secretVersion.findFirst({ where: { secretId: secret.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
    await recordSecretEvent(tx, { ownerId: secret.ownerId, secretId: secret.id, secretName: secret.name, kind: 'REVEAL', versionNo: newest?.versionNo ?? null, actor });
    const value = await currentAppSecretValue(tx, { id: secret.id, ownerId: secret.ownerId });
    const after = await tx.grant.findUniqueOrThrow({ where: { id: client.grantId }, select: { maxUses: true, useCount: true } });
    return { value: JSON.stringify(value), secretName: secret.name, readsLeft: after.maxUses === null ? null : after.maxUses - after.useCount };
  });
  } catch (e) {
    const code = e instanceof GraphQLError ? String(e.extensions?.code ?? '') : '';
    const k = known as { ownerId: string; secretId: string; secretName: string } | null;
    if (k && code) {
      // The caller still gets the uniform refusal, but a lost audit row is an operational fault the owner cannot see: log it (ids and a
      // recognized error code only: never the message or arguments, which a database error can fill with values) so it is not silent.
      await recordSecretEvent(ctx.db as never, { ...k, kind: 'REVEAL', outcome: code, actor }).catch((auditError: unknown) => {
        console.error('[revealSecret] audit write failed', { secretId: k.secretId, ownerId: k.ownerId, outcome: code, errorCode: auditErrorCode(auditError) });
      });
    }
    throw e;
  }
}

/** The only part of a failed audit write that is logged: a short allowlisted code (a Prisma `P####` or a Postgres SQLSTATE), else a fixed word. */
function auditErrorCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z0-9]{5}$/.test(c) ? c : 'UNKNOWN';
}

/**
 * Prepare one App-secret use for a run (#4000). The transaction checks the named client and the signed terms,
 * consumes one ticket and one grant use, and commits its audit rows before returning the credential to core.
 * The caller must not put the returned auth into a model-visible value or make an outbound call until it can
 * enforce the no-redirect contract. This is an internal primitive, not a GraphQL/MCP reveal door.
 */
export async function prepareSecretUse(
  tool: import('../runner/tools/types.js').RunToolContext,
  clientId: string,
  rawUrl: string,
  headers: Record<string, string>,
): Promise<{ url: string; auth: import('../webfetchClient.js').WebFetchAuth }> {
  const { assertSecretUseBinding, assertSecretUseHeader } = await import('../runner/secrets.js');
  const { isWebFetchAuth } = await import('../secrets.js');
  const { chargeGrantUse } = await import('../grants/live.js');
  const { lockAppManagerMemberships } = await import('../auth/appManagement.js');
  const run = tool.run;
  const agentId = run.agentId;
  if (!agentId || tool.principal.clientId !== `run:${run.id}` || tool.principal.appId !== run.appId) throw notFound();
  const pre = await tool.db.secretReadClient.findUnique({ where: { id: clientId }, select: { appId: true, secretId: true, grantId: true } });
  if (!pre || pre.appId !== run.appId) throw notFound();
  const app = await tool.db.app.findUnique({ where: { id: run.appId }, select: { id: true, organizationId: true, ownerUserId: true } });
  const initial = await tool.db.grant.findUnique({ where: { id: pre.grantId }, select: { issuerUserId: true } });
  if (!app || app.organizationId !== run.organizationId || !initial?.issuerUserId) throw notFound();
  const issuer = initial.issuerUserId;
  const anchors = [{ kind: 'app' as const, id: app.id }, { kind: 'org' as const, id: run.organizationId },
    { kind: 'user' as const, id: issuer }, { kind: 'agent' as const, id: agentId }];
  const internal = { ...tool.principal, userId: undefined, db: tool.db } as Context;
  return withAuthorizedTx(internal, anchors, async () => undefined, async (tx, txCtx) => {
    // Lock the run before judging its policy and budget; cancellation and budget edits serialize with this spend.
    await tx.$queryRaw`SELECT id FROM app_runs WHERE id = ${run.id} FOR UPDATE`;
    const actual = await tx.appRun.findUnique({ where: { id: run.id }, select: { appId: true, agentId: true, organizationId: true, status: true, policy: true, budgetTokens: true, budgetActions: true } });
    if (!actual || actual.appId !== run.appId || actual.agentId !== agentId || actual.organizationId !== run.organizationId || actual.status !== 'RUNNING') throw notFound();
    if (!evaluatePolicyChain('tool.web_request', parseRunPolicySnapshot(actual.policy)) ||
        (actual.budgetTokens !== null && actual.budgetTokens <= 0) || actual.budgetActions === null || actual.budgetActions < 1) {
      throw refusal('TOOL_DENIED', 'The web request is denied.');
    }
    if (!(await lockSecretRow(tx, pre.secretId))) throw notFound();
    const client = await tx.secretReadClient.findUnique({ where: { id: clientId } });
    if (!client || client.endedAt || client.appId !== run.appId || client.grantId !== pre.grantId || client.secretId !== pre.secretId) throw notFound();
    const locked = await readGrantForUpdate(tx, client.grantId);
    const grant = await tx.grant.findUnique({ where: { id: client.grantId } });
    if (!locked || !grant || grant.action !== 'secret.use' || grant.appId !== run.appId || grant.issuerUserId !== issuer ||
        !((grant.granteeAppId === run.appId && grant.agentId === null) || (grant.agentId === agentId && grant.granteeAppId === null)) ||
        grant.userId !== null || grant.workerId !== null) throw notFound();
    if (!locked.live) {
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
      const state = deadGrantState(grant, now);
      throw refusal(`SECRET_READ_CLIENT_${state}`, 'This read client is not live.');
    }
    const terms = grant.values as Record<string, unknown> | null;
    if (!terms || terms.secret !== client.secretId || terms['auto-delete'] !== 'keep' ||
        typeof terms['binding-prefix'] !== 'string' || typeof terms['binding-header'] !== 'string') throw notFound();
    const secret = await tx.secret.findUnique({ where: { id: client.secretId }, select: { id: true, name: true, kind: true, ownerId: true, ownerType: true, metadata: true } });
    if (!secret || secret.ownerType !== 'app' || secret.ownerId !== run.appId || secret.kind !== 'webfetch-auth') throw notFound();
    await judgeSecretReadClientIssuer(txCtx, issuer, secret.id);
    const metadata = secret.metadata as Record<string, unknown> | null;
    if (!metadata || typeof metadata.urlPrefix !== 'string') throw notFound();
    const url = assertSecretUseBinding(rawUrl, terms['binding-prefix'], metadata.urlPrefix);
    let auth: unknown;
    try { auth = await currentAppSecretValue(tx, { id: secret.id, ownerId: secret.ownerId }); }
    catch { throw refusal('SECRET_USE_UNAVAILABLE', 'The secret cannot be used.'); }
    if (!isWebFetchAuth(auth) || metadata.type !== auth.type) throw notFound();
    assertSecretUseHeader(terms['binding-header'], auth, headers);
    const tickets = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM action_tickets
      WHERE organization_id = ${run.organizationId} AND action = 'secret.use' AND consumed_at IS NULL
        AND (app_id = ${run.appId} OR app_id IS NULL) AND (expires_at IS NULL OR expires_at > (clock_timestamp() AT TIME ZONE 'UTC'))
      ORDER BY (app_id IS NOT NULL) DESC, created_at ASC, id ASC FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!tickets[0]) throw refusal('ACTION_TICKET_REQUIRED', 'No secret-use ticket is available.');
    const budget = await tx.appRun.updateMany({ where: { id: run.id, status: 'RUNNING', budgetActions: { gte: 1 } },
      data: { budgetActions: { decrement: 1 }, actionsSpent: { increment: 1 } } });
    if (budget.count !== 1) throw refusal('TOOL_DENIED', 'The web request is denied.');
    await tx.actionTicket.update({ where: { id: tickets[0].id }, data: { consumedAt: new Date(), consumedByRunId: run.id } });
    if (!(await chargeGrantUse(tx, grant.id, run.appId))) throw refusal('SECRET_READ_CLIENT_SPENT', 'This read client is not live.');
    await tx.grantEvent.create({ data: { grantId: grant.id, appId: run.appId, action: 'USE', runId: run.id } });
    const latest = await tx.secretVersion.findFirst({ where: { secretId: secret.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
    await tx.secretEvent.create({ data: { ownerType: 'app', ownerId: run.appId, secretId: secret.id, secretName: secret.name,
      clientId: client.id, versionNo: latest?.versionNo ?? null, kind: 'USE', outcome: 'OK', runId: run.id } });
    return { url, auth };
  }, { afterLock: (tx) => lockAppManagerMemberships(tx, issuer, app) });
}
