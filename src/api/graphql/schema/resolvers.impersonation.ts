/**
 * Admin impersonation — start/stop mutations, audit queries, and type
 * resolvers (see src/lib/auth/impersonation.ts for the contract summary).
 *
 * Authorization (Holger, 2026-08-04):
 *   - start: a live org ADMIN/OWNER of the named org (platform ADMIN/OWNER
 *     counts as OWNER-equivalent and needs no membership), impersonating
 *     another live member of that org, PEER-OR-BELOW — an org ADMIN may not
 *     impersonate an org OWNER. Never self, never nested.
 *   - stop: the session's admin, an org ADMIN/OWNER of its org, a platform
 *     admin — or the impersonated context itself (the ONE mutation the
 *     read-only plugin allowlists). Idempotent on an already-ended session.
 *   - audit list: platform admin unscoped; org ADMIN/OWNER for their org
 *     (the callerCanAudit shape from effectiveAccess).
 *
 * Naming: start/stop rather than create/delete — stopping writes `endedAt`
 * and never deletes the audit row (the startSession/endSession precedent).
 */

import { GraphQLError } from 'graphql';
import { withAuthorizedTx } from './authorizedTx.js';
import { signJwt } from '../../../auth/jwt.js';
import { canImpersonate, impersonationTtlSeconds } from '../../../lib/auth/impersonation.js';
import { USER_API_KEY_LABEL_MAX_LEN } from '../../../middleware/auth.js';
import {
  type Context,
  clampListTake,
  isPlatformAdmin,
  resolveOrgRefArg,
  resolveUserRefArg,
} from './resolvers.helpers.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';

const forbidden = () =>
  new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * #1416 (R204): end a session as `endedBy`, a User.id that becomes the ender of record. The ender is a
 * participant in the merge protocol even when it is not a participant of the session: a merge rewrites an
 * existing `ended_by = source` to the survivor, so a stop that a merged-away account lands afterwards would
 * stamp a deleted account. The stop therefore takes the ender's shared authority anchor (the one a merge holds
 * exclusively) and re-reads the ender as live under it, at READ COMMITTED so the read after the wait sees the
 * merge. `endedBy` null (a key-authenticated platform admin) writes the session's own admin, which takes the same anchor and live check.
 * The anchor is defence in depth: the live-row `FOR SHARE` would meet the merge's `FOR UPDATE` anyway, and the
 * merge's fresh-row comparison catches a commit made during its wait.
 * Idempotent: only a still-open session is written.
 */
async function endSessionAs(ctx: Context, sessionId: string, endedBy: string | null): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    // A key-authenticated platform admin records the session's own admin, so that User.id is the ender and takes
    // the same anchor. One read is enough: the only writer of `admin_user_id` is the merge, which soft-deletes the
    // source in the same transaction, so a changed admin is already refused by the live check below.
    const ender = endedBy ?? (await tx.impersonationSession.findUnique({ where: { id: sessionId }, select: { adminUserId: true } }))?.adminUserId ?? null;
    if (!ender) return; // no such session: nothing to end
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: ender }], 'shared');
    const live = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${ender} AND deleted_at IS NULL FOR SHARE`;
    if (live.length === 0) throw forbidden();
    await tx.impersonationSession.updateMany({
      where: { id: sessionId, endedAt: null },
      data: { endedAt: new Date(), endedBy: ender },
    });
  });
}

/** A session is live iff not explicitly ended and not TTL-lapsed. */
const isActive = (s: { endedAt: Date | null; expiresAt: Date }): boolean =>
  s.endedAt === null && s.expiresAt > new Date();

/**
 * May `ctx` administer `session` (stop it / read it as an audit record)?
 * The session's admin actor, an org ADMIN/OWNER of its org, or a platform
 * admin. Mirrors callerCanAudit's org-admin shape.
 */
async function canAdministerSession(
  ctx: Context,
  session: { adminUserId: string; organizationId: string },
): Promise<boolean> {
  // #876 class sweep: the audit surface is administrative, not part of the
  // impersonated (read-only, shared-org) view. Both the self branch below
  // (`adminUserId === ctx.userId`) and the inline membership query bypass the
  // narrowed requireOrgRole, so an impersonated session could have read this
  // org's audit trail — and, if the target administers another org, that
  // org's too. Deny the whole surface to impersonated callers.
  if (ctx.impersonation) return false;
  if (isPlatformAdmin(ctx)) return true;
  if (!ctx.userId) return false;
  if (session.adminUserId === ctx.userId) return true;
  const member = await ctx.db.orgMember.findFirst({
    where: {
      organizationId: session.organizationId,
      userId: ctx.userId,
      ...LIVE_ORG_MEMBERSHIP,
      role: { in: ['ADMIN', 'OWNER'] },
    },
    select: { userId: true },
  });
  return !!member;
}

export const impersonationMutations = {
  /**
   * Start impersonating `userRef` within `orgRef`. Returns the audit row and
   * the short-TTL impersonation JWT — the token is returned exactly once
   * (UserApiKey rawKey precedent) and every request re-validates the row.
   */
  startImpersonation: async (
    _: unknown,
    { orgRef, userRef, reason }: { orgRef: string; userRef: string; reason?: string | null },
    ctx: Context,
  ) => {
    // No nesting: an impersonated context cannot start another session.
    // (The read-only plugin already blocks this mutation wholesale; this is
    // the clearer error for direct-resolver callers/tests.)
    if (ctx.impersonation) throw forbidden();
    if (!ctx.userId) throw forbidden();

    const orgId = await resolveOrgRefArg(ctx.db, { ref: orgRef });
    const targetId = await resolveUserRefArg(ctx.db, { ref: userRef });
    if (targetId === ctx.userId) throw badInput('You cannot impersonate yourself.');

    // Caller authority: platform ADMIN/OWNER is OWNER-equivalent; otherwise a
    // live ADMIN/OWNER membership in the named org is required.
    const platformAdmin = isPlatformAdmin(ctx);
    const callerMembership = await ctx.db.orgMember.findFirst({
      where: { organizationId: orgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
      select: { role: true },
    });
    const callerOrgRole = callerMembership?.role ?? null;
    if (!platformAdmin && callerOrgRole !== 'ADMIN' && callerOrgRole !== 'OWNER') {
      throw forbidden();
    }

    // Target: a live user AND a live member of the org. The caller is an org
    // admin (or platform admin), entitled to see the member list — a precise
    // error is fine here, no enumeration concern.
    const target = await ctx.db.user.findFirst({
      where: { id: targetId, deletedAt: null },
      select: { id: true },
    });
    const targetMembership = target
      ? await ctx.db.orgMember.findFirst({
          where: { organizationId: orgId, userId: targetId, deletedAt: null },
          select: { role: true },
        })
      : null;
    if (!target || !targetMembership) {
      throw badInput('The target user is not an active member of the organization.');
    }

    // Peer-or-below, via the SHARED predicate that `resolveJwt` re-applies on
    // every request — one rule, two enforcement points, no drift.
    if (
      !canImpersonate({
        actorIsPlatformAdmin: platformAdmin,
        actorOrgRole: callerOrgRole,
        targetOrgRole: targetMembership.role,
      })
    ) {
      throw forbidden();
    }

    const ttlSeconds = impersonationTtlSeconds();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const session = await withAuthorizedTx(
      ctx,
      [{ kind: 'org', id: orgId }, { kind: 'user', id: targetId }],
      async (txCtx) => {
        if (txCtx.impersonation || !txCtx.userId) throw forbidden();
        const currentActor = await txCtx.db.orgMember.findFirst({
          where: { organizationId: orgId, userId: txCtx.userId, ...LIVE_ORG_MEMBERSHIP },
          select: { role: true },
        });
        const currentTarget = await txCtx.db.orgMember.findFirst({
          where: { organizationId: orgId, userId: targetId, ...LIVE_ORG_MEMBERSHIP },
          select: { role: true },
        });
        const targetUser = await txCtx.db.user.findFirst({
          where: { id: targetId, deletedAt: null }, select: { id: true },
        });
        if (!currentTarget || !targetUser) {
          throw badInput('The target user is not an active member of the organization.');
        }
        if (!canImpersonate({
          actorIsPlatformAdmin: isPlatformAdmin(txCtx),
          actorOrgRole: currentActor?.role ?? null,
          targetOrgRole: currentTarget.role,
        })) throw forbidden();
      },
      (tx) => tx.impersonationSession.create({
        data: {
          adminUserId: ctx.userId!, targetUserId: targetId, organizationId: orgId,
          reason: reason ? reason.slice(0, USER_API_KEY_LABEL_MAX_LEN) : null,
          expiresAt,
        },
      }),
    );

    // `sub` = target; `roles: []` — the impersonated context never inherits
    // platform roles (resolveImpersonationJwt re-asserts this server-side).
    const token = await signJwt(
      {
        sub: targetId,
        roles: [],
        imp: { sid: session.id, act: ctx.userId, org: orgId },
      },
      { expiresIn: `${ttlSeconds}s` },
    );

    return { session, token };
  },

  /**
   * Stop an impersonation session (writes endedAt/endedBy; never deletes).
   * Under an impersonation token, `id` may be omitted (self-stop — the one
   * mutation the read-only plugin allows); a normal token must name the
   * session and be its admin, an org ADMIN/OWNER, or a platform admin.
   * Idempotent: stopping an already-ended session returns it unchanged.
   */
  stopImpersonation: async (
    _: unknown,
    { id }: { id?: string | null },
    ctx: Context,
  ) => {
    if (ctx.impersonation) {
      // Self-stop: the impersonated context may end exactly ITS OWN session.
      if (id && id !== ctx.impersonation.sessionId) throw forbidden();
      const endedBy = ctx.impersonation.actorUserId; // the admin, never the target
      // Atomic conditional update so a concurrent stop stays idempotent.
      await endSessionAs(ctx, ctx.impersonation.sessionId, endedBy);
      return ctx.db.impersonationSession.findUnique({
        where: { id: ctx.impersonation.sessionId },
      });
    }

    if (!ctx.userId && !isPlatformAdmin(ctx)) throw forbidden();
    if (!id) throw badInput('A session id is required.');
    const session = await ctx.db.impersonationSession.findUnique({ where: { id } });
    if (!session) {
      throw new GraphQLError('Impersonation session not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    if (!(await canAdministerSession(ctx, session))) throw forbidden();
    if (session.endedAt) return session; // idempotent
    await endSessionAs(ctx, id, ctx.userId ?? null);
    return ctx.db.impersonationSession.findUnique({ where: { id } });
  },
};

export const impersonationQueries = {
  /**
   * Single audit record by id. Denied and missing are indistinguishable
   * (null) so a non-privileged caller can't probe session existence.
   */
  impersonationSession: async (
    _: unknown,
    { ref }: { ref: string },
    ctx: Context,
  ) => {
    const session = await ctx.db.impersonationSession.findUnique({ where: { id: ref } });
    if (!session) return null;
    if (!(await canAdministerSession(ctx, session))) return null;
    return session;
  },

  /**
   * Uniform audit list (cor:api:120): `{ items, total }`, createdAt-desc.
   * Platform admins may omit `orgId` (unscoped); everyone else must name an
   * org they are a live ADMIN/OWNER of.
   */
  impersonationSessions: async (
    _: unknown,
    {
      orgId,
      filter,
      limit,
      offset,
    }: {
      orgId?: string | null;
      filter?: { activeOnly?: boolean | null } | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ) => {
    // #876: administrative surface — never reachable from an impersonated
    // session (see canAdministerSession).
    if (ctx.impersonation) throw forbidden();
    const platformAdmin = isPlatformAdmin(ctx);
    let scopedOrgId: string | null = null;
    if (orgId != null) {
      scopedOrgId = await resolveOrgRefArg(ctx.db, { ref: orgId });
    } else if (!platformAdmin) {
      throw badInput('orgId is required (platform admins may omit it).');
    }
    if (!platformAdmin) {
      if (!ctx.userId) throw forbidden();
      const member = await ctx.db.orgMember.findFirst({
        where: {
          organizationId: scopedOrgId!,
          userId: ctx.userId,
          ...LIVE_ORG_MEMBERSHIP,
          role: { in: ['ADMIN', 'OWNER'] },
        },
        select: { userId: true },
      });
      if (!member) throw forbidden();
    }
    const where = {
      ...(scopedOrgId ? { organizationId: scopedOrgId } : {}),
      ...(filter?.activeOnly ? { endedAt: null, expiresAt: { gt: new Date() } } : {}),
    };
    const [items, total] = await Promise.all([
      ctx.db.impersonationSession.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: clampListTake(limit),
        skip: Math.max(0, offset ?? 0),
      }),
      ctx.db.impersonationSession.count({ where }),
    ]);
    return { items, total };
  },
};

export const impersonationTypeResolvers = {
  ImpersonationSession: {
    adminUser: (s: { adminUserId: string }, _: unknown, ctx: Context) =>
      ctx.db.user.findUnique({ where: { id: s.adminUserId } }),
    targetUser: (s: { targetUserId: string }, _: unknown, ctx: Context) =>
      ctx.db.user.findUnique({ where: { id: s.targetUserId } }),
    organization: (s: { organizationId: string }, _: unknown, ctx: Context) =>
      ctx.db.organization.findUnique({ where: { id: s.organizationId } }),
    isActive: (s: { endedAt: Date | null; expiresAt: Date }) => isActive(s),
  },
  ImpersonationInfo: {
    // The admin behind the curtain — a co-member of the shared org, so the
    // User field resolvers' visibility rules render name/email correctly.
    actorUser: (src: { actorUserId: string }, _: unknown, ctx: Context) =>
      ctx.db.user.findUnique({ where: { id: src.actorUserId } }),
  },
};
