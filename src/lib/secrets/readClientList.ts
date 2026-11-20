/** #3998: client metadata is grant-derived; sealed attribution never authorizes a current person. */
import { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { pageArgs, pageEnvelope } from '../../api/graphql/schema/resolvers.helpers.js';
import { boundWorkerId } from '../bootPrompt.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { grantLiveSql, GRANT_DB_NOW } from '../grants/live.js';
import { deadGrantState } from './readClientReveal.js';

type Args = { limit?: number | null; offset?: number | null; activeOnly?: boolean };

/** A user id in an authenticated context does not turn an App key or an erased account into a person. */
async function currentPerson(ctx: Context): Promise<string | null> {
  if (!ctx.userId || ctx.appKeyId || ctx.impersonation || isRunPrincipal(ctx)) return null;
  return (await ctx.db.user.findFirst({ where: { id: ctx.userId, deletedAt: null }, select: { id: true } }))?.id ?? null;
}

/**
 * The state of a client that has no stored end: null while live, else the grant's own cause (revoked, pending, spent, expired,
 * not started), the same order the reveal door answers in. ISSUER_GONE names only a grant nothing else has ended.
 */
function endStateOf(r: Parameters<typeof deadGrantState>[0] & { live: boolean; now: Date; issuerUserId: string | null }): string | null {
  if (r.live) return null;
  const state = deadGrantState(r, r.now);
  return state === 'ENDED' && r.issuerUserId === null ? 'ISSUER_GONE' : state;
}

/** Page on SQL audience and liveness predicates before projecting; limit zero is count-only. */
async function list(ctx: Context, args: Args, audience: Prisma.Sql, fullId: Prisma.Sql) {
  const { take, skip } = pageArgs(args);
  const live = Prisma.sql`(c.ended_at IS NULL AND g.issuer_user_id IS NOT NULL AND ${grantLiveSql('g')})`;
  const where = Prisma.sql`g.id = c.grant_id AND a.id = c.app_id AND g.app_id = c.app_id
    AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL
    AND (a.organization_id IS NULL OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = a.organization_id AND o.deleted_at IS NULL))
    AND ${audience} AND (${!args.activeOnly} OR ${live})`;
  const [{ total }] = await ctx.db.$queryRaw<Array<{ total: number }>>(Prisma.sql`
    SELECT count(*)::int AS total FROM secret_read_clients c, grants g, apps a WHERE ${where}`);
  if (!take) return pageEnvelope([], total, skip);
  const rows = await ctx.db.$queryRaw<Array<{
    id: string; fullId: boolean; grantId: string; secretId: string; secretName: string; selfIssued: boolean; issuedToOwnWorker: boolean | null;
    endReason: string | null; createdAt: Date; startsAt: Date | null; expiresAt: Date | null; maxUses: number | null;
    useCount: number; activatedAt: Date | null; revokedAt: Date | null; holderDepartedAt: Date | null;
    issuerUserId: string | null; destroyOnEnd: boolean; live: boolean; now: Date;
  }>>(Prisma.sql`SELECT c.id, ${fullId} AS "fullId", c.grant_id AS "grantId", c.secret_id AS "secretId",
    c.secret_name AS "secretName", c.self_issued AS "selfIssued", c.issued_to_own_worker AS "issuedToOwnWorker", c.end_reason AS "endReason", c.created_at AS "createdAt",
    g.starts_at AS "startsAt", g.expires_at AS "expiresAt", g.max_uses AS "maxUses", g.use_count AS "useCount",
    g.activated_at AS "activatedAt", g.revoked_at AS "revokedAt", g.holder_departed_at AS "holderDepartedAt",
    (CASE WHEN g.activated_at IS NULL THEN g.requested_by_user_id ELSE g.issuer_user_id END) AS "issuerUserId", (g.action_values->>'auto-delete' = 'delete') AS "destroyOnEnd",
    ${live} AS live, ${GRANT_DB_NOW} AS now
    FROM secret_read_clients c, grants g, apps a WHERE ${where}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ${take} OFFSET ${skip}`);
  return pageEnvelope(rows.map(r => ({
    clientId: r.fullId ? r.id : null, clientPrefix: r.id.slice(0, 8), grantId: r.grantId, secretId: r.secretId,
    secretName: r.secretName, selfIssued: r.selfIssued, issuedToOwnWorker:r.issuedToOwnWorker, createdAt: r.createdAt,
    startsAt: r.startsAt, expiresAt: r.expiresAt, maxReads: r.maxUses, readCount: r.useCount, destroyOnEnd: !!r.destroyOnEnd,
    endReason: r.endReason ?? endStateOf(r),
  })), total, skip);
}

/** A bound worker sees its own holder rows; an unbound person sees current issuer or person-holder rows. */
export async function myReadClients(ctx: Context, args: Args) {
  const userId = await currentPerson(ctx);
  if (!userId) return [];
  const workerId = boundWorkerId();
  const audience = workerId ? Prisma.sql`g.worker_id = ${workerId}` : Prisma.sql`((CASE WHEN g.activated_at IS NULL THEN g.requested_by_user_id ELSE g.issuer_user_id END) = ${userId} OR g.user_id = ${userId})`;
  return (await list(ctx, args, audience, Prisma.sql`true`)).items;
}

/** Secret.readClients: issuers see their rows; managers see all, with full ids only for current issuer/holder. */
export async function readClientPage(ctx: Context, secretId: string, args: Args, manager: boolean) {
  const userId = await currentPerson(ctx);
  if (!userId) return pageEnvelope([], 0, 0);
  const workerId = boundWorkerId();
  const fullId = workerId ? Prisma.sql`(g.worker_id = ${workerId})` : Prisma.sql`((CASE WHEN g.activated_at IS NULL THEN g.requested_by_user_id ELSE g.issuer_user_id END) = ${userId} OR g.user_id = ${userId})`;
  return list(ctx, args, Prisma.sql`(c.secret_id = ${secretId} AND (${manager} OR (CASE WHEN g.activated_at IS NULL THEN g.requested_by_user_id ELSE g.issuer_user_id END) = ${userId}))`, fullId);
}
