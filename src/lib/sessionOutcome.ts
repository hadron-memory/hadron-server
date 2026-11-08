import { Prisma } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.js';
import { requireSessionWriteAccess } from '../api/graphql/schema/resolvers.helpers.js';
import { serializeJson } from '../integrations/db/provider.js';
import { oauthSurfaceRefusal, type OAuthSurfaceRefusal } from '../middleware/auth.js';
import { preserveHeartbeatIfLapsed } from './sessionActivity.js';

/**
 * #2896 — what a session's outcome report answers. The ONE implementation behind both doors: `POST /sessions/:id/outcome`
 * (edge devices and webhooks) and the GraphQL mutation `recordSessionOutcome` (the CLI, cor:api:240:02). Each door maps
 * a result onto its own wire shape; no rule lives in either. A refusal is returned, never thrown, so the REST route keeps
 * its exact status and body, and any other failure (a database fault) still throws and is the caller's to report.
 */
export type SessionOutcomeResult =
  | { kind: 'ok'; sessionId: string }
  | { kind: 'out_of_range' }
  | { kind: 'oauth_surface'; refusal: OAuthSurfaceRefusal }
  | { kind: 'no_credential' }
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

/**
 * Report a session's outcome: validate the number, refuse an OAuth credential limited to the MCP surface, require SOME
 * credential, then take the one shared session-write gate (`requireSessionWriteAccess`, cor:dmo:070:05, strict owner
 * cor:acl:010:02) and write `outcome`, `outcomeRef` and `outcomeMeta`. The order is the route's: a refusal returns before
 * any write, so no outcome, metadata or liveness moves.
 *
 * `resolveCtx` is called only after the range check, because the REST route resolves its credential (database lookups)
 * after it, and a bad number has always answered 400 without touching the credential.
 */
export async function recordSessionOutcome(
  db: Context['db'],
  resolveCtx: () => Promise<Context>,
  input: { sessionId: string; outcome: unknown; outcomeRef?: string | null; outcomeMeta?: unknown },
): Promise<SessionOutcomeResult> {
  const { sessionId, outcome, outcomeRef, outcomeMeta } = input;
  if (typeof outcome !== 'number' || !(outcome >= 0 && outcome <= 1)) return { kind: 'out_of_range' };

  const ctx = await resolveCtx();
  const refusal = oauthSurfaceRefusal(ctx, 'account');
  if (refusal) return { kind: 'oauth_surface', refusal };
  // The principal must still hold SOME credential: an anonymous request is a 401, not a 403.
  if (!ctx.userId && !ctx.appId) return { kind: 'no_credential' };

  const target = await db.session.findUnique({
    where: { id: sessionId },
    select: { appId: true, userId: true, launchOperationId: true, memoryId: true, deletedAt: true },
  });
  if (!target || target.deletedAt) return { kind: 'not_found' };
  try {
    await requireSessionWriteAccess(ctx, target);
  } catch (e) {
    if ((e as { extensions?: { code?: string } })?.extensions?.code !== 'FORBIDDEN') throw e;
    return { kind: 'forbidden' };
  }

  try {
    await db.session.update({
      where: { id: sessionId },
      data: {
        // #1543 — an outcome report is not anyone driving the session.
        ...(await preserveHeartbeatIfLapsed(db as never, sessionId)),
        outcome,
        outcomeRef,
        outcomeMeta: serializeJson(outcomeMeta) as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    // Prisma's record-not-found: the session went away between the read and the write.
    if ((e as { code?: string } | null)?.code === 'P2025') return { kind: 'not_found' };
    throw e;
  }
  return { kind: 'ok', sessionId };
}
