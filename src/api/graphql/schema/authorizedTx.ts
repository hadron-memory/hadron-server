import { Prisma } from '../../../generated/prisma/index.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { type Context, withoutRequestCaches } from './resolvers.helpers.js';

/**
 * Bracket an access-granting write with the authority it depends on. A
 * revoker takes the same anchor exclusively, so it cannot return while this
 * transaction is still about to commit a new grant. The authority anchors
 * are taken BEFORE row locks on both sides. This differs from the separate
 * memory-rulebook lock, whose writers require node/rule rows first.
 *
 * The gate must use txCtx: a gate on the request's ctx.db leaves the original
 * authorize-then-write window open. The transaction context has no request
 * memoized access decisions and reloads platform roles after acquiring the
 * actor's user anchor, so a stale JWT role cannot mint durable authority.
 */
export async function withAuthorizedTx<T>(
  ctx: Context,
  anchors: readonly AuthorityAnchor[] | (() => readonly AuthorityAnchor[]),
  authorize: (txCtx: Context) => Promise<void>,
  write: (tx: Prisma.TransactionClient, txCtx: Context) => Promise<T>,
  options: {
    afterAnchors?: (tx: Prisma.TransactionClient) => Promise<void>;
    afterLock?: (tx: Prisma.TransactionClient) => Promise<void>;
    lockMode?: 'shared' | 'exclusive';
    isolationLevel?: Prisma.TransactionIsolationLevel;
    timeout?: number;
    allowDeletedMemory?: boolean;
    allowDeletedOrg?: boolean;
  } = {},
): Promise<T> {
  return ctx.db.$transaction(async (tx) => {
    const resolvedAnchors = typeof anchors === 'function' ? anchors() : anchors;
    // All participating revokers take this same advisory anchor before row
    // locks. Ordering it first also leaves one SERIALIZABLE protocol: after a
    // wait, a locking gate read can detect a stale snapshot and force retry.
    const rowAnchors = ctx.userId
      ? [...resolvedAnchors, { kind: 'user' as const, id: ctx.userId }]
      : [...resolvedAnchors];
    const rowOrder: Record<AuthorityAnchor['kind'], number> = {
      org: 0, user: 1, app: 2, memory: 3, agent: 4, connection: 5, invitation: 6,
    };
    const uniqueRows = [...new Map(rowAnchors.map((a) => [`${a.kind}:${a.id}`, a])).values()]
      .sort((a, b) => rowOrder[a.kind] - rowOrder[b.kind] || a.id.localeCompare(b.id));
    await lockAuthorityAnchors(tx, rowAnchors, options.lockMode ?? 'shared');
    // Advisory-only locks that must precede EVERY row lock below (#2245): a writer whose own order is
    // "advisory key, then rows" (setAgentBase: graph lock, then child row) would otherwise cycle with
    // the anchor rows taken here. Take no row lock in this hook.
    await options.afterAnchors?.(tx);
    // Owner rows precede child rows, matching rename/transfer cascades. SHARE
    // (rather than KEY SHARE) makes a SERIALIZABLE waiter fail with 40001 if a
    // revoker soft-deleted or re-roled an anchor row before the lock arrived.
    for (const anchor of uniqueRows) {
      switch (anchor.kind) {
        case 'org':
          await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${anchor.id} FOR SHARE`;
          break;
        case 'memory':
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${anchor.id} FOR SHARE`;
          break;
        case 'app':
          await tx.$queryRaw`SELECT id FROM apps WHERE id = ${anchor.id} FOR SHARE`;
          break;
        case 'user':
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${anchor.id} FOR SHARE`;
          break;
        case 'agent':
          await tx.$queryRaw`SELECT id FROM agents WHERE id = ${anchor.id} FOR SHARE`;
          break;
        case 'connection':
        case 'invitation':
          // Connection is a union of provider tables; invitation row locks
          // are caller-specific because acceptance updates its activations.
          break;
      }
    }
    await options.afterLock?.(tx);
    // Re-read liveness after the advisory wait, while the exclusive revoker
    // can no longer pass us.
    for (const anchor of uniqueRows) {
      switch (anchor.kind) {
        case 'org': {
          const row = await tx.organization.findUnique({ where: { id: anchor.id }, select: { deletedAt: true } });
          if (!row || (row.deletedAt && !options.allowDeletedOrg)) throw authorizationDenied();
          break;
        }
        case 'memory': {
          const row = await tx.memory.findUnique({ where: { id: anchor.id }, select: { deletedAt: true } });
          if (!row || (row.deletedAt && !options.allowDeletedMemory)) throw authorizationDenied();
          break;
        }
        case 'app': {
          const row = await tx.app.findUnique({ where: { id: anchor.id }, select: { deletedAt: true, uninstalledAt: true } });
          if (!row || row.deletedAt || row.uninstalledAt) throw authorizationDenied();
          break;
        }
        case 'user': {
          const row = await tx.user.findUnique({ where: { id: anchor.id }, select: { deletedAt: true } });
          if (!row || row.deletedAt) throw authorizationDenied();
          break;
        }
        case 'agent': {
          const row = await tx.agent.findUnique({ where: { id: anchor.id }, select: { deletedAt: true } });
          if (!row || row.deletedAt) throw authorizationDenied();
          break;
        }
        case 'connection':
        case 'invitation':
          break;
      }
    }

    const txCtx = await liveTxContext(ctx, tx);
    await authorize(txCtx);
    return write(tx, txCtx);
  }, {
    isolationLevel: options.isolationLevel,
    timeout: options.timeout ?? 30_000,
  });
}

class AuthorityScopeChanged extends Error {}

/**
 * A Memory can change owning org/user while a caller resolves its anchor set.
 * Lock the observed owner together with the Memory, then verify the owner
 * under a row lock. A transfer that won the race causes a fresh attempt with
 * the new anchors; the gate itself is always run on the transaction client.
 */
export async function withAuthorizedMemoryTx<T>(
  ctx: Context,
  memoryId: string,
  otherAnchors: readonly AuthorityAnchor[],
  authorize: (txCtx: Context) => Promise<void>,
  write: (tx: Prisma.TransactionClient, txCtx: Context) => Promise<T>,
  options: {
    afterAnchors?: (tx: Prisma.TransactionClient) => Promise<void>;
    afterLock?: (tx: Prisma.TransactionClient) => Promise<void>;
    lockMode?: 'shared' | 'exclusive';
    isolationLevel?: Prisma.TransactionIsolationLevel;
    timeout?: number;
    allowDeletedMemory?: boolean;
    allowDeletedOrg?: boolean;
  } = {},
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = await ctx.db.memory.findUnique({
      where: { id: memoryId },
      select: { organizationId: true, ownerUserId: true, userId: true },
    });
    const anchors: AuthorityAnchor[] = [
      { kind: 'memory', id: memoryId },
      ...(owner?.organizationId ? [{ kind: 'org' as const, id: owner.organizationId }] : []),
      ...(owner?.ownerUserId ? [{ kind: 'user' as const, id: owner.ownerUserId }] : []),
      ...(owner?.userId ? [{ kind: 'user' as const, id: owner.userId }] : []),
      ...otherAnchors,
    ];
    try {
      return await withAuthorizedTx(ctx, anchors, authorize, write, {
        ...options,
        afterLock: async (tx) => {
          const rows = await tx.$queryRaw<Array<{ organization_id: string | null; owner_user_id: string | null; user_id: string | null }>>`
            SELECT organization_id, owner_user_id, user_id FROM memories WHERE id = ${memoryId} FOR SHARE`;
          if (rows[0] &&
              (rows[0].organization_id !== owner?.organizationId ||
               rows[0].owner_user_id !== owner?.ownerUserId || rows[0].user_id !== owner?.userId)) {
            throw new AuthorityScopeChanged();
          }
          await options.afterLock?.(tx);
        },
      });
    } catch (error) {
      if (error instanceof AuthorityScopeChanged) continue;
      throw error;
    }
  }
  throw new Error('Memory ownership changed repeatedly; retry the operation');
}

/**
 * The caller's context for a decision taken INSIDE `tx`, after the caller's authority anchors are held:
 * request caches dropped, the db bound to `tx`, platform roles re-read from the user row (a demotion that
 * committed first is seen), and a presented `hdr_user_` key re-validated. Throws `authorizationDenied` for a
 * deleted user or a revoked key. The one place this is decided, for `withAuthorizedTx` and for a transaction
 * that takes its anchors itself (#1708, Riana's demotion P2 on #1859).
 */
export async function liveTxContext(ctx: Context, tx: Prisma.TransactionClient): Promise<Context> {
  return readLiveContext(ctx, tx, true);
}

/**
 * Pure reads in one READ ONLY / REPEATABLE READ snapshot validate credential
 * liveness at that snapshot without row locks. They make no authority-granting
 * write. Refuse other transaction modes so this cannot replace a write gate's
 * credential locks. Drift reconciliation continues to use liveTxContext.
 */
export async function liveReadSnapshotContext(ctx: Context, tx: Prisma.TransactionClient): Promise<Context> {
  const [mode] = await tx.$queryRaw<Array<{ readOnly: string; isolation: string }>>`
    SELECT current_setting('transaction_read_only') AS "readOnly",
      current_setting('transaction_isolation') AS isolation`;
  if (mode?.readOnly !== 'on' || mode.isolation !== 'repeatable read') {
    throw new Error('A read-only repeatable-read snapshot is required');
  }
  return readLiveContext(ctx, tx, false);
}

async function readLiveContext(ctx: Context, tx: Prisma.TransactionClient, lockCredentials: boolean): Promise<Context> {
  const actor = ctx.userId
    ? await tx.user.findUnique({ where: { id: ctx.userId }, select: { roles: true, deletedAt: true } })
    : null;
  if (ctx.userId && (!actor || actor.deletedAt)) throw authorizationDenied();
  // Middleware authenticated this particular hdr_user_ key before the
  // transaction began. Its owner can revoke it while this request waits on
  // the user anchor, so validate the presented credential again here. The
  // locking read also forces a SERIALIZABLE stale snapshot to retry if the
  // key's revoked_at changed during the wait.
  if (ctx.apiKeyId) {
    if (!ctx.userId) throw authorizationDenied();
    const keys = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM user_api_keys
      WHERE id = ${ctx.apiKeyId} AND user_id = ${ctx.userId} AND revoked_at IS NULL
      ${lockCredentials ? Prisma.sql`FOR SHARE` : Prisma.empty}`;
    if (keys.length !== 1) throw authorizationDenied();
  }
  // #1897 / R66: a credential descending from a sign-in dies with it. The share lock orders this
  // against the cancel path's exclusive user anchor, so no decision is taken on an ended root.
  if (ctx.signInId) {
    if (!ctx.userId) throw authorizationDenied();
    const roots = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM sign_ins
      WHERE id = ${ctx.signInId} AND user_id = ${ctx.userId} AND ended_at IS NULL ${lockCredentials ? Prisma.sql`FOR SHARE` : Prisma.empty}`;
    if (roots.length !== 1) throw authorizationDenied();
  }

  return {
    ...withoutRequestCaches(ctx, tx),
    // An impersonation token deliberately has no platform roles, even when
    // its target User row does. The read-only support context must not gain
    // the target's platform authority during a delegated helper call.
    roles: ctx.impersonation ? [] : actor ? actor.roles : ctx.roles,
  };
}
