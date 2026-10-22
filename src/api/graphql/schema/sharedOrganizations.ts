import { Prisma } from '../../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { clampListTake, type Context } from './resolvers.helpers.js';

type OrganizationSummary = { id: string; name: string; urn: string };
type SharedOrganizationsPage = { items: OrganizationSummary[]; total: number };
type Result = SharedOrganizationsPage | null;
type Pending = { resolve: (r: Result) => void; reject: (e: unknown) => void };
type Batch = { pending: Map<string, Pending>; cache: Map<string, Promise<Result>> };

// Context objects belong to one request. Neither parent User objects nor process-global target ids carry results.
const requests = new WeakMap<Context, Map<string, Batch>>();

/** A human's live intersection, never the full Organization resolver surface. */
export function sharedOrganizations(
  targetId: string,
  args: { limit?: number | null; offset?: number | null },
  ctx: Context,
): Promise<Result> {
  // Refuse unsupported viewers before any identity/membership query, even a run with on-behalf-of userId.
  if (!ctx.userId || ctx.appKeyId || isRunPrincipal(ctx) || ctx.sessionBindingRefused) return Promise.resolve(null);
  // The current corpus supersedes the older attach's default 50 (cor:api:120:04, 2026-10-21).
  const take = clampListTake(args.limit ?? 20);
  const skip = Math.max(0, args.offset ?? 0);
  const viewerId = ctx.userId;
  const orgId = ctx.impersonation?.orgId;
  const key = JSON.stringify([viewerId, ctx.clientId, ctx.appKeyId, ctx.sessionId, ctx.sessionBindingRefused,
    ctx.impersonation?.sessionId, orgId, take, skip]);
  let batches = requests.get(ctx);
  if (!batches) requests.set(ctx, batches = new Map());
  let batch = batches.get(key);
  if (!batch) batches.set(key, batch = { pending: new Map(), cache: new Map() });
  const cached = batch.cache.get(targetId);
  if (cached) return cached;
  const selectedBatch = batch;
  const promise = new Promise<Result>((resolve, reject) => {
    const schedule = selectedBatch.pending.size === 0;
    selectedBatch.pending.set(targetId, { resolve, reject });
    if (schedule) queueMicrotask(async () => {
      const pending = new Map(selectedBatch.pending);
      selectedBatch.pending.clear();
      try {
        const results = await loadBatch(ctx, viewerId, orgId, [...pending.keys()], take, skip);
        for (const [id, item] of pending) item.resolve(results.get(id) ?? null);
      } catch (e) { for (const item of pending.values()) item.reject(e); }
    });
  });
  batch.cache.set(targetId, promise);
  return promise;
}

async function loadBatch(ctx: Context, viewerId: string, orgId: string | undefined, targetIds: string[], take: number, skip: number) {
  return ctx.db.$transaction(async (tx) => {
    const users = await tx.user.findMany({ where: { id: { in: [viewerId, ...targetIds] }, deletedAt: null }, select: { id: true } });
    const live = new Set(users.map((u) => u.id));
    const results = new Map<string, Result>(targetIds.map((id) => [id, live.has(viewerId) && live.has(id) ? { items: [], total: 0 } : null]));
    if (!live.has(viewerId)) return results;
    const ids = targetIds.filter((id) => live.has(id));
    if (!ids.length) return results;
    const memberships = await tx.orgMember.findMany({
      where: { userId: viewerId, ...LIVE_ORG_MEMBERSHIP, ...(orgId ? { organizationId: orgId } : {}) },
      select: { organizationId: true },
    });
    const organizationIds = memberships.map((m) => m.organizationId);
    if (!organizationIds.length) return results;
    // Both memberships and organization liveness apply before either count or page, with no administrator arm.
    const counts = await tx.orgMember.groupBy({
      by: ['userId'], where: { userId: { in: ids }, organizationId: { in: organizationIds }, ...LIVE_ORG_MEMBERSHIP },
      _count: { _all: true },
    });
    for (const c of counts) results.get(c.userId)!.total = c._count._all;
    if (!take) return results;
    const rows = await tx.$queryRaw<Array<OrganizationSummary & { userId: string }>>`
      WITH ranked AS (
        SELECT m.user_id AS "userId", o.id, o.name, o.urn,
          row_number() OVER (PARTITION BY m.user_id ORDER BY o.id ASC) AS rn
        FROM org_members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id IN (${Prisma.join(ids)}) AND m.organization_id IN (${Prisma.join(organizationIds)})
          AND m.deleted_at IS NULL AND o.deleted_at IS NULL
      )
      SELECT "userId", id, name, urn FROM ranked
      WHERE rn > ${skip}::bigint AND rn <= (${skip}::bigint + ${take}::bigint)
      ORDER BY "userId", id ASC
    `;
    for (const { userId, ...item } of rows) results.get(userId)!.items.push(item);
    return results;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
