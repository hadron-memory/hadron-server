// Post-time wake stamps — #1748, cor:agt:080:14/:15 (plan §4.2a, Rook's N3, #8096).
//
// Whether a message may wake everyone at once, and whether it is exempt from the
// daily wake budget, is decided WHEN IT IS POSTED and written into the
// server-built envelope; `dueWakes` reads only the stamp. Nothing re-evaluates
// the author later: a revoked grant changes nothing about a message already
// posted, and a message with no stamp is ordinary unread for the next tick.
// Clients cannot set envelope fields — the envelope is assembled here.
//
//   managerPost     the RECORDED author is a person who manages the App
//                   (`managesApp`: never an App key, never under impersonation).
//                   A post made through a worker's session is the worker's, so a
//                   manager driving a worker does not qualify.
//   broadcastWakes  the message mentions @all/@team AND the author is a manager,
//                   or is the worker holding the ticker.subscribe-workers grant
//                   with a person behind the posting session (N2). A bare App key
//                   bound to that session never qualifies (#8091).

import type { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { managesApp } from '../auth/appManagement.js';
import { mayStillDriveWorkerApp } from '../teamAttention.js';
import { BROADCAST_MENTION_TOKENS } from '../mentionToken.js';
import { GRANT_SUBSCRIBE_WORKERS } from './bounds.js';
import { liveCaller } from './liveCaller.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';

/**
 * Decided INSIDE the append transaction (Diego P2-6): a stamp is permanent and
 * authorizes a fleet-wide wake or a budget exemption, so it is decided on live
 * platform roles and on the grant row as it stands, with those rows held so a
 * demotion or revocation either commits first (and no stamp is written) or waits
 * behind this post. A message committed while authorized keeps its stamp after a
 * later revocation, as before.
 */
export type StampAuthority = { app: { id: string; organizationId: string | null; ownerUserId: string | null }; live: Context };

/**
 * PHASE 1, before anything that takes a Worker row lock in the append (a lapsed session's resume takes it FOR UPDATE):
 * the authority anchors, the App re-read under them, and the caller's user, membership and live roles. Nothing here
 * touches a Worker row, so the order is anchors → caller rows → [resume: App, Worker] → phase 2 (Worker, grant), the
 * direction every revoker takes (Diego cycle 3, P2-3). Null when the App is gone, uninstalled or the caller deleted.
 */
export async function lockStampAuthority(
  ctx: Context,
  tx: Prisma.TransactionClient,
  app: { id: string; organizationId: string | null; ownerUserId: string | null } | null,
  beforeCallerRows?: () => Promise<void>,
): Promise<StampAuthority | null> {
  if (!app) return null;
  // The authority anchors first (the established protocol: anchors before row locks), then the App as it stands NOW:
  // the object the caller passed was read before the append, and an ownership change, uninstall or transfer may
  // have landed since. Revokers of that authority take the same anchors exclusively.
  await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }], 'shared');
  const now = await tx.app.findUnique({ where: { id: app.id }, select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true } });
  if (!now || now.deletedAt || now.uninstalledAt) return null;
  await lockAuthorityAnchors(
    tx,
    [
      { kind: 'app', id: now.id },
      ...(now.organizationId ? [{ kind: 'org' as const, id: now.organizationId }] : []),
      ...(now.ownerUserId ? [{ kind: 'user' as const, id: now.ownerUserId }] : []),
      ...(ctx.userId ? [{ kind: 'user' as const, id: ctx.userId }] : []),
    ],
    'shared',
  );
  if (beforeCallerRows) await beforeCallerRows();
  if (ctx.userId && !ctx.impersonation) {
    // Held before the roles and memberships are read, so a change to them orders against this post.
    await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${ctx.userId} FOR SHARE`;
    await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${now.id} AND user_id = ${ctx.userId} FOR SHARE`;
    if (now.organizationId) {
      await tx.$queryRaw`SELECT 1 FROM org_members WHERE organization_id = ${now.organizationId} AND user_id = ${ctx.userId} FOR SHARE`;
    }
  }
  const live = await liveCaller(ctx, tx);
  return live ? { app: now, live } : null;
}

/** PHASE 2 (and, with no `held`, both phases): the stamps, on the authority phase 1 holds. */
export async function wakeStampsFor(
  ctx: Context,
  tx: Prisma.TransactionClient,
  app: { id: string; organizationId: string | null; ownerUserId: string | null } | null,
  authorWorkerId: string | null,
  mentions: string[],
  held?: { authority: StampAuthority | null },
): Promise<{ managerPost?: true; broadcastWakes?: true }> {
  if (!app || mentions.length === 0) return {};
  const broadcast = mentions.some((t) => (BROADCAST_MENTION_TOKENS as readonly string[]).includes(t));
  const authority = held ? held.authority : await lockStampAuthority(ctx, tx, app);
  if (!authority) return {};
  const { live } = authority;
  const manager = !authorWorkerId && (await managesApp(live, authority.app));
  let granted = false;
  if (broadcast && !manager && authorWorkerId && live.userId && !live.impersonation && (await mayStillDriveWorkerApp(live, authority.app.id))) {
    // The Worker row first, then the grant (the order revocation and release take): FOR SHARE, so a release or
    // retirement orders against this post. When the post resumed a lapsed session it already holds the row FOR UPDATE.
    const w = await tx.$queryRaw<Array<{ retired_at: Date | null; held_by_user_id: string | null }>>`
      SELECT retired_at, held_by_user_id FROM workers WHERE id = ${authorWorkerId} FOR SHARE`;
    const grants = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM app_grants
      WHERE app_id = ${authority.app.id} AND grantee_worker_id = ${authorWorkerId} AND name = ${GRANT_SUBSCRIBE_WORKERS} AND revoked_at IS NULL
      FOR SHARE`;
    // Spent on a holder's behalf: the grantee must be live and held by the person behind the post (as on subscribe).
    granted = grants.length > 0 && w.length === 1 && !w[0]!.retired_at && w[0]!.held_by_user_id === live.userId;
  }
  return {
    ...(manager ? { managerPost: true as const } : {}),
    ...(broadcast && (manager || granted) ? { broadcastWakes: true as const } : {}),
  };
}
