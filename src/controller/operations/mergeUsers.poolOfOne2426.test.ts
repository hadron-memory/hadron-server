/**
 * #2426: `assertSourceActorRowsFresh` reads on a second pool connection while the merge's `tx` holds one. The
 * bound on that wait is the URL-level `pool_timeout` (#448), not a new timer. With a pool of one the second
 * connection can never be had: Prisma rejects with P2024 after `pool_timeout`. That error matches none of
 * mergeUsers' retry predicates, so it is not retried (never AuthoritySnapshotStale), nothing is merged, and
 * nothing hangs.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { approvedMergeProof } from '../../test/mergeConsent.js';
import { mergeUsers } from './mergeUsers.js';

const POOL_TIMEOUT_SECONDS = 2;

function poolOfOne(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('pool_timeout', String(POOL_TIMEOUT_SECONDS));
  return new PrismaClient({ datasourceUrl: url.toString() });
}

const small = poolOfOne();
afterAll(() => small.$disconnect());

let source: { id: string };
let target: { id: string };
let admin: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  [source, target, admin] = await Promise.all(
    ['src', 'tgt', 'adm'].map((h) => db.user.create({ data: { handle: `${h}-${generateId().slice(-6)}`, ...(h === 'adm' ? { roles: ['ADMIN'] } : {}) } })),
  );
});

describe('a merge on a pool of one', () => {
  it('fails within pool_timeout with P2024, is not retried, and merges nothing', async () => {
    const consentProof = await approvedMergeProof(db, source.id, target.id, admin.id);
    // Each merge attempt opens exactly one transaction, so this counts attempts: a retry would make it 2+.
    const attempts = vi.spyOn(small, '$transaction');
    const started = Date.now();
    const error = await mergeUsers(small, {
      sourceUserId: source.id, targetUserId: target.id, actorUserId: admin.id, consentProof,
    }).then(() => null, (e: unknown) => e as { code?: string; name?: string });
    const elapsed = Date.now() - started;

    expect(error?.code).toBe('P2024');
    expect(error?.name).not.toBe('AuthoritySnapshotStale');
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(POOL_TIMEOUT_SECONDS * 2 * 1000);
    expect((await db.user.findUniqueOrThrow({ where: { id: source.id } })).deletedAt).toBeNull();
  }, 30_000);
});
