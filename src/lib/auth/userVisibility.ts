import type { PrismaClient } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

/**
 * Field-level user-visibility rules — hadron-server#384.
 * Spec: cor:acl:070:01 (field-visibility matrix), cor:acl:070:02 (discovery).
 *
 * What fields of a *target* user a *viewer* may see depends on their
 * relationship:
 *
 *   | Field           | any auth user | co-member | co-member + viewer ADMIN/OWNER of shared org |
 *   |-----------------|:-------------:|:---------:|:--------------------------------------------:|
 *   | id/handle/urn   |       ✓       |     ✓     |                      ✓                       |
 *   | name / email    |       –       |     ✓     |                      ✓                       |
 *   | role (in org)   |       –       |     –     |                      ✓                       |
 *
 * `id`, `handle`, and the derived `urn` (and thus the client-derived
 * profile link) are always visible. The viewer always sees their own
 * full record; a platform ADMIN/OWNER sees everyone's. Suppressed
 * fields are returned as `null`, never an error.
 *
 * This module is the single source of truth applied by every `User`
 * projection — the `User.name` / `User.email` field resolvers,
 * `OrgMember.role`, and the global-search user adapter — so the rule
 * is enforced server-side for every consumer (portal, MCP, future
 * clients) instead of per-endpoint.
 */

/**
 * The viewer side of a visibility check. Both the GraphQL resolver
 * `Context` and small ad-hoc objects (e.g. the global-search adapter)
 * satisfy this. The object identity also keys a per-request memo, so
 * pass the *same* object across a request to share cached lookups.
 */
export interface UserVisibilityCtx {
  db: PrismaClient;
  userId?: string;
  roles?: readonly string[];
  // Admin impersonation: when set, the viewer is a read-only impersonated
  // session scoped to ONE org — visibility derives only from co-membership in
  // that org (the GraphQL Context carries the full ImpersonationContext and
  // satisfies this structurally; ad-hoc adapter objects must copy it over).
  impersonation?: { orgId: string };
}

const ELEVATED = new Set(['ADMIN', 'OWNER']);

function isPlatformAdmin(ctx: UserVisibilityCtx): boolean {
  return !!ctx.roles?.some((r) => ELEVATED.has(r));
}

// Per-request memo keyed by the viewer object (Apollo passes one
// `contextValue` per request, so a `searchUsers` page sharing 40
// name/email resolver calls collapses to a single membership query
// per distinct target). GC'd with the ctx object.
interface Memo {
  viewerOrgIds?: Promise<string[]>;
  shares: Map<string, Promise<boolean>>;
  roleInOrg: Map<string, Promise<string | null>>;
}
const memos = new WeakMap<object, Memo>();
function memoFor(ctx: UserVisibilityCtx): Memo {
  let m = memos.get(ctx);
  if (!m) {
    m = { shares: new Map(), roleInOrg: new Map() };
    memos.set(ctx, m);
  }
  return m;
}

function viewerOrgIds(ctx: UserVisibilityCtx, viewerId: string): Promise<string[]> {
  const memo = memoFor(ctx);
  if (!memo.viewerOrgIds) {
    memo.viewerOrgIds = ctx.db.orgMember
      .findMany({
        where: {
          userId: viewerId,
          ...LIVE_ORG_MEMBERSHIP,
          // Impersonation: co-membership counts only within the shared org.
          ...(ctx.impersonation ? { organizationId: ctx.impersonation.orgId } : {}),
        },
        select: { organizationId: true },
      })
      .then((rows) => rows.map((r) => r.organizationId));
  }
  return memo.viewerOrgIds;
}

/**
 * Which of `targetUserIds` share a live org with the viewer, in ONE membership
 * query for the ids the request has not already asked about (#2223). Results
 * land in the same per-target memo `sharesOrgWith` reads, so the single-target
 * and bulk paths can never disagree and a request asks each target once.
 */
function sharesOrgWithMany(ctx: UserVisibilityCtx, viewerId: string, targetUserIds: readonly string[]): Promise<Map<string, boolean>> {
  const memo = memoFor(ctx);
  const missing = [...new Set(targetUserIds)].filter((id) => !memo.shares.has(id));
  if (missing.length > 0) {
    const members = (async () => {
      const orgIds = await viewerOrgIds(ctx, viewerId);
      if (orgIds.length === 0) return new Set<string>();
      const rows = await ctx.db.orgMember.findMany({
        where: { userId: { in: missing }, organizationId: { in: orgIds }, ...LIVE_ORG_MEMBERSHIP },
        select: { userId: true },
      });
      return new Set(rows.map((r) => r.userId));
    })();
    for (const id of missing) memo.shares.set(id, members.then((set) => set.has(id)));
  }
  return Promise.all(targetUserIds.map(async (id) => [id, await memo.shares.get(id)!] as const)).then((e) => new Map(e));
}

async function sharesOrgWith(ctx: UserVisibilityCtx, viewerId: string, targetUserId: string): Promise<boolean> {
  return (await sharesOrgWithMany(ctx, viewerId, [targetUserId])).get(targetUserId)!;
}

function viewerRoleInOrg(ctx: UserVisibilityCtx, viewerId: string, orgId: string): Promise<string | null> {
  // Impersonation: the viewer has no role anywhere outside the shared org.
  if (ctx.impersonation && orgId !== ctx.impersonation.orgId) return Promise.resolve(null);
  const memo = memoFor(ctx);
  let p = memo.roleInOrg.get(orgId);
  if (!p) {
    p = ctx.db.orgMember
      .findFirst({
        where: { userId: viewerId, organizationId: orgId, ...LIVE_ORG_MEMBERSHIP },
        select: { role: true },
      })
      .then((r) => r?.role ?? null);
    memo.roleInOrg.set(orgId, p);
  }
  return p;
}

/**
 * Whether `ctx`'s viewer may see the target user's `name` and `email`.
 * Visible to: the user themselves, platform admins, and any viewer who
 * shares an organization with the target. Otherwise `false`.
 */
export async function canSeeUserPersonalFields(
  ctx: UserVisibilityCtx,
  targetUserId: string | null | undefined,
): Promise<boolean> {
  if (!targetUserId) return false;
  return (await canSeeUserPersonalFieldsMany(ctx, [targetUserId])).has(targetUserId);
}

/**
 * {@link canSeeUserPersonalFields} for many targets at once (#2223): the set of
 * targets whose `name` and `email` the viewer may see. The rule has ONE
 * definition — the single-target form delegates here — and the membership
 * lookup is one query however many targets there are. A falsy id is never
 * visible.
 */
export async function canSeeUserPersonalFieldsMany(
  ctx: UserVisibilityCtx,
  targetUserIds: ReadonlyArray<string | null | undefined>,
): Promise<Set<string>> {
  const ids = [...new Set(targetUserIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Set();
  if (isPlatformAdmin(ctx)) return new Set(ids);
  const visible = new Set<string>();
  if (ctx.userId) {
    if (ids.includes(ctx.userId)) visible.add(ctx.userId); // self
  } else {
    return visible; // unauthenticated / App-Key caller
  }
  const others = ids.filter((id) => id !== ctx.userId);
  if (others.length === 0) return visible;
  for (const [id, shares] of await sharesOrgWithMany(ctx, ctx.userId, others)) if (shares) visible.add(id);
  return visible;
}

/**
 * Whether `ctx`'s viewer may see the target member's role *within the
 * given org*. Visible to: the member themselves, platform admins, and
 * co-members whose own role in that org is ADMIN or OWNER.
 */
export async function canSeeOrgMemberRole(
  ctx: UserVisibilityCtx,
  member: { userId: string; organizationId: string },
): Promise<boolean> {
  if (ctx.userId && ctx.userId === member.userId) return true; // own role
  if (isPlatformAdmin(ctx)) return true;
  if (!ctx.userId) return false;
  const role = await viewerRoleInOrg(ctx, ctx.userId, member.organizationId);
  return role != null && ELEVATED.has(role);
}
