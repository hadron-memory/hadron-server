/**
 * leaveApp — spec 023-app-shape US2 (T028).
 *
 * Self-service AppMember delete for the currently-logged-in user.
 * Idempotent — succeeds whether or not the row exists.
 *
 * **Memory persistence (spec 008 FR-015):** the user's personal-class
 * Memory at (appId, userId) is NOT cascade-deleted. The Memory row is
 * retained as an orphan; if the user later re-joins the same App, it
 * re-attaches automatically. Memory cleanup is a separate lifecycle
 * concern, not a side-effect of leaving.
 *
 * **App lifecycle is intentionally NOT checked here.** Unlike joinApp
 * (which rejects writes into soft-deleted or soft-uninstalled Apps),
 * leaveApp is pure cleanup of the user-side state. A user can leave
 * an uninstalled or soft-deleted App without ceremony — denying that
 * would strand the user as a member of a dead App with no recourse.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export async function leaveApp(
  db: PrismaClient,
  args: { appId: string; userId: string },
): Promise<{ appId: string; userId: string }> {
  // `deleteMany` is idempotent: returns `{ count: 0 }` when no row
  // matches, no exception.
  await db.appMember.deleteMany({
    where: { appId: args.appId, userId: args.userId },
  });
  return { appId: args.appId, userId: args.userId };
}
