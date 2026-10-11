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

import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { managesApp } from '../auth/appManagement.js';
import { mayStillDriveWorkerApp } from '../teamAttention.js';
import { BROADCAST_MENTION_TOKENS } from '../mentionToken.js';
import { GRANT_SUBSCRIBE_WORKERS } from './bounds.js';

export async function wakeStampsFor(
  ctx: Context,
  app: { id: string; organizationId: string | null; ownerUserId: string | null } | null,
  authorWorkerId: string | null,
  mentions: string[],
): Promise<{ managerPost?: true; broadcastWakes?: true }> {
  if (!app || mentions.length === 0) return {};
  const broadcast = mentions.some((t) => (BROADCAST_MENTION_TOKENS as readonly string[]).includes(t));
  const manager = !authorWorkerId && (await managesApp(ctx, app));
  let granted = false;
  if (broadcast && !manager && authorWorkerId && ctx.userId && !ctx.impersonation && (await mayStillDriveWorkerApp(ctx, app.id))) {
    const grant = await ctx.db.appGrant.findFirst({
      where: { appId: app.id, granteeWorkerId: authorWorkerId, name: GRANT_SUBSCRIBE_WORKERS, revokedAt: null, grantee: { retiredAt: null } },
      select: { id: true },
    });
    granted = !!grant;
  }
  return {
    ...(manager ? { managerPost: true as const } : {}),
    ...(broadcast && (manager || granted) ? { broadcastWakes: true as const } : {}),
  };
}
