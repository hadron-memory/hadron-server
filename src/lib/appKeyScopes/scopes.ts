// App key scopes — #1749 (Tickers S3, epic #1659), cor:aut:010:03 and :04.
//
// A scope is a closed-list permission an App key holds in the database. It is
// enforced at the surfaces it names and nowhere else: no code asks whether a key
// has "any scope" (default deny). It is READ FROM THE DATABASE at every call that
// needs it, never copied into the auth context, because an MCP transport keeps
// the context it opened with (findings:mcp-auth-context-outlives-role-claims) and
// a revocation must hold from the key's next call.

import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';

/** The closed list. T6 (#1709) adds `host:operate`. */
export const APP_KEY_SCOPES = ['attention:deliver'] as const;
export type AppKeyScopeName = (typeof APP_KEY_SCOPES)[number];

export const isAppKeyScope = (v: unknown): v is AppKeyScopeName =>
  typeof v === 'string' && (APP_KEY_SCOPES as readonly string[]).includes(v);

type Db = PrismaClient | Prisma.TransactionClient;

/** The calling App key, or null for anyone else. Pure: a person's active-App selection sets `appId` too, so `appKeyId` decides. */
export function appKeyCaller(ctx: { appKeyId?: string; appId?: string; userId?: string }): { appKeyId: string; appId: string } | null {
  return ctx.appKeyId && ctx.appId && !ctx.userId ? { appKeyId: ctx.appKeyId, appId: ctx.appId } : null;
}

const refuse = (code: string, message: string): never => {
  throw new GraphQLError(message, { extensions: { code } });
};

/**
 * A key bound to a session (or naming one that failed to bind) is refused where the session would otherwise narrow
 * or widen what it reads: never narrowed, never treated as unbound (Holger #8097, Rook N5).
 */
export function refuseSessionBound(ctx: { sessionId?: string; sessionBindingRefused?: boolean }): void {
  if (ctx.sessionId || ctx.sessionBindingRefused) {
    refuse(
      'APP_KEY_SESSION_BOUND',
      'This App key carries a session. A team router uses its key without a session; send no X-Hadron-Session.',
    );
  }
}

/**
 * Does the key hold the scope RIGHT NOW? True only for a live (unrevoked) scope row on an unrevoked key of this App,
 * whose App is installed. Callers that must not race a revocation run this inside a transaction that holds the App's
 * authority anchor shared: the revokers of a scope, of the key and of the App take it exclusively.
 */
export async function keyHoldsScope(db: Db, key: { appKeyId: string; appId: string }, scope: AppKeyScopeName): Promise<boolean> {
  const row = await db.appKeyScope.findFirst({
    where: {
      appKeyId: key.appKeyId,
      scope,
      revokedAt: null,
      appKey: { revokedAt: null, appId: key.appId, app: { deletedAt: null, uninstalledAt: null } },
    },
    select: { id: true },
  });
  return row !== null;
}

/** Refuse `APP_KEY_SCOPE_REQUIRED` unless the key holds the scope now. */
export async function requireKeyScope(db: Db, key: { appKeyId: string; appId: string }, scope: AppKeyScopeName): Promise<void> {
  if (!(await keyHoldsScope(db, key, scope))) {
    refuse('APP_KEY_SCOPE_REQUIRED', `This App key does not hold the ${scope} scope. Whoever manages the App can grant it.`);
  }
}
