/**
 * #1709 (Task Management T6) — the `host:operate` App-key scope, bound to one
 * host (cor:agt:070:04), and the record of every use of it (cor:agt:070:07).
 *
 * THE HOST'S IDENTITY COMES FROM THE KEY, NEVER FROM THE REQUEST: the host id is
 * the one on the key's live `host:operate` scope row, read from the database at
 * every call (like every scope, src/lib/appKeyScopes/scopes.ts), so a revoked
 * scope or key is refused from its next call. No host surface accepts a host id
 * from its caller.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** An App key operating as one host of its App. */
export type HostKey = { appKeyId: string; appId: string; hostId: string };

/** What a host key did, for the use record (cor:agt:070:07). */
export type HostKeyAction = 'register' | 'collect' | 'report' | 'availability' | 'read' | 'session' | 'issue' | 'deliver' | 'stop';

/**
 * The host this key operates as RIGHT NOW: the host id on its live
 * `host:operate` scope, on an unrevoked key of this App, whose App is
 * installed. Null when it holds none. Callers that must not race a revocation
 * run this inside a transaction holding the App's authority anchor shared; the
 * revokers of a scope, of the key and of the App take it exclusively.
 */
export async function keyHostId(db: Db, key: { appKeyId: string; appId: string }): Promise<string | null> {
  const row = await db.appKeyScope.findFirst({
    where: {
      appKeyId: key.appKeyId,
      scope: 'host:operate',
      revokedAt: null,
      appKey: { revokedAt: null, appId: key.appId, app: { deletedAt: null, uninstalledAt: null } },
    },
    select: { hostId: true },
  });
  return row?.hostId ?? null;
}

/**
 * Has this App key EVER been granted `host:operate`, live or revoked? Such a key is a host key for every refusal that
 * must not reopen when the scope is revoked (cor:agt:070:04): the App-wide host-operations listing (#1919) and every
 * session write (#1934). Revoking the scope never restores what it took away; a key that needs ordinary access is
 * replaced with a new key (Holger's ruling via Vera, team chat #11544). Scope rows are revoked, never deleted, so the
 * row's existence is the whole answer.
 */
export async function keyEverHeldHostOperate(db: Db, appKeyId: string): Promise<boolean> {
  const row = await db.appKeyScope.findFirst({ where: { appKeyId, scope: 'host:operate' }, select: { id: true } });
  return row !== null;
}

/** Record one use of a host key, in the caller's transaction, so it commits exactly when the use does. */
export async function recordHostKeyUse(
  tx: Prisma.TransactionClient,
  key: HostKey,
  action: HostKeyAction,
  detail: { operationId?: string; count?: number } = {},
): Promise<void> {
  await tx.hostKeyUse.create({
    data: {
      id: generateId(),
      appKeyId: key.appKeyId,
      appId: key.appId,
      hostId: key.hostId,
      action,
      operationId: detail.operationId ?? null,
      count: detail.count ?? null,
    },
  });
}

/**
 * #1881 (cor:agt:070:07, Holger #10849) — the host a key is recorded under when its use is not a live host's write: its
 * live `host:operate` scope's host, else the host of its latest grant (revoked). Null for a key never granted the
 * scope, which is not a host key and has no host to record a use under.
 */
export async function hostOfKeyForRecord(db: Db, key: { appKeyId: string; appId: string }): Promise<string | null> {
  const live = await keyHostId(db, key);
  if (live) return live;
  const latest = await db.appKeyScope.findFirst({
    where: { appKeyId: key.appKeyId, scope: 'host:operate' },
    orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
    select: { hostId: true },
  });
  return latest?.hostId ?? null;
}

/**
 * Record a host key's use in ITS OWN write, apart from any transaction of the call: a read, or a refused call, whose
 * rollback must not erase the record (Holger #10849). Never throws: a failed record is logged, and the call's own
 * answer (or refusal) stands.
 */
export async function recordHostKeyUseApart(
  db: PrismaClient,
  key: { appKeyId: string; appId: string },
  action: HostKeyAction,
  detail: { operationId?: string | null; count?: number; refusedCode?: string | null } = {},
): Promise<void> {
  try {
    const hostId = await hostOfKeyForRecord(db, key);
    if (!hostId) return;
    await db.hostKeyUse.create({
      data: {
        id: generateId(),
        appKeyId: key.appKeyId,
        appId: key.appId,
        hostId,
        action,
        operationId: detail.operationId ?? null,
        count: detail.count ?? null,
        refusedCode: detail.refusedCode ?? null,
      },
    });
  } catch (err) {
    console.error('[host-key] recording a use failed:', action, err);
  }
}
