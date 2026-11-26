/** #5244; cor:sec:070:02 (Proposed sweep-backlog line): the expiry sweep drains in bounded batches, each its own transaction. Real database. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { drainExpiredSecretChanges, SECRET_CHANGE_SWEEP_BATCH, SECRET_CHANGE_SWEEP_MAX_BATCHES } from '../lib/secrets/changeRequests.js';

let appId: string, userId: string;

/** `n` rows in `state` (non-STORE, so no ciphertext is needed); `expires` is a SQL interval relative to now (negative = past). */
async function seed(n: number, state: 'open' | 'completed' | 'declined' | 'expired' | 'withdrawn' | 'stale', expires: string, prefix: string) {
  await db.$executeRawUnsafe(`INSERT INTO secret_change_requests
    (id,app_id,secret_name,secret_kind,metadata,operation,requester_id,state,snapshot,write_version,expires_at,ended_at)
    SELECT $1 || g, $2, 'n' || g, 'generic', '{"k":"v"}'::jsonb, 'DELETE', $3, $4, 'snap', false,
      (clock_timestamp() AT TIME ZONE 'UTC') + interval '${expires}' - g * interval '1 millisecond',
      CASE WHEN $4 = 'open' THEN NULL ELSE (clock_timestamp() AT TIME ZONE 'UTC') END
    FROM generate_series(1, ${n}) g`, prefix, appId, userId, state);
}
/** Rows still holding ciphertext (read raw: the client may not return the column). */
const cipherCount = async () => Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM secret_change_requests WHERE staged_value_encrypted IS NOT NULL`)[0].n);
const count = (state: string) => db.secretChangeRequest.count({ where: { state } });

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@sweep5244.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'sweep drain', urn: `${generateId().toLowerCase()}:drain` } })).id;
});

describe('#5244 the expiry sweep drains in bounded batches', () => {
  it('the engineering bounds are 500 x 20', () => {
    expect([SECRET_CHANGE_SWEEP_BATCH, SECRET_CHANGE_SWEEP_MAX_BATCHES]).toEqual([500, 20]);
  });

  it('P1: one run clears more than 100 expired requests (1200)', async () => {
    await seed(1200, 'open', '-1 hour', 'a');
    expect(await drainExpiredSecretChanges(db)).toBe(1200);
    expect(await count('expired')).toBe(1200);
    expect(await count('open')).toBe(0);
  });

  it('P2: one run stops at the per-run bound (20 x 500) and the rest waits for the next run', async () => {
    await seed(10_050, 'open', '-1 hour', 'b');
    expect(await drainExpiredSecretChanges(db)).toBe(10_000);
    expect(await count('expired')).toBe(10_000);
    expect(await count('open')).toBe(50);
    expect(await drainExpiredSecretChanges(db)).toBe(50);
    expect(await count('open')).toBe(0);
  });

  it('P3: the batch is 500 rows, and each batch commits on its own (a later failure keeps the earlier batches)', async () => {
    await seed(1200, 'open', '-1 hour', 'c');
    let calls = 0;
    const flaky = { $transaction: (f: never) => { if (++calls === 2) return Promise.reject(new Error('batch 2 failed')); return (db.$transaction as any)(f); } };
    await expect(drainExpiredSecretChanges(flaky as never)).rejects.toThrow('batch 2 failed');
    expect(calls).toBe(2);
    expect(await count('expired')).toBe(500);
    expect(await count('open')).toBe(700);
  });

  it('P4: a live request and every terminal state are untouched; an expired one keeps its metadata and loses its ciphertext', async () => {
    await seed(3, 'open', '-1 hour', 'dead');
    await seed(2, 'open', '+1 hour', 'live');
    for (const s of ['completed', 'declined', 'withdrawn', 'stale'] as const) await seed(2, s, '-1 hour', s);
    const before = await db.secretChangeRequest.findMany({ where: { OR: [{ id: { startsWith: 'live' } }, { state: { not: 'open' } }] }, orderBy: { id: 'asc' } });
    expect(await drainExpiredSecretChanges(db)).toBe(3);
    const after = await db.secretChangeRequest.findMany({ where: { OR: [{ id: { startsWith: 'live' } }, { state: { not: 'open' }, id: { not: { startsWith: 'dead' } } }] }, orderBy: { id: 'asc' } });
    expect(after).toEqual(before);
    const swept = await db.secretChangeRequest.findMany({ where: { id: { startsWith: 'dead' } } });
    expect(swept).toHaveLength(3);
    for (const r of swept) expect(r).toMatchObject({ state: 'expired', metadata: { k: 'v' }, secretKind: 'generic' }), expect(r.endedAt).not.toBeNull();
  });

  it('P4b: an expired STORE request loses its ciphertext and keeps its size and key version', async () => {
    await db.$executeRaw`INSERT INTO secret_change_requests (id,app_id,secret_name,secret_kind,metadata,operation,requester_id,state,snapshot,staged_value_encrypted,key_version,size_bytes,write_version,expires_at)
      VALUES ('store1',${appId},'s','generic','{}'::jsonb,'STORE',${userId},'open','snap','CIPHERTEXT',1,7,true,(clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour')`;
    await db.$executeRaw`INSERT INTO secret_change_requests (id,app_id,secret_name,secret_kind,metadata,operation,requester_id,state,snapshot,staged_value_encrypted,key_version,size_bytes,write_version,expires_at)
      VALUES ('store-live',${appId},'s2','generic','{}'::jsonb,'STORE',${userId},'open','snap','CIPHERTEXT',1,7,true,(clock_timestamp() AT TIME ZONE 'UTC') + interval '1 hour')`;
    expect(await cipherCount()).toBe(2);
    expect(await drainExpiredSecretChanges(db)).toBe(1);
    expect(await db.secretChangeRequest.findUnique({ where: { id: 'store1' } })).toMatchObject({ state: 'expired', keyVersion: 1, sizeBytes: 7 });
    expect(await cipherCount()).toBe(1); // only the live request keeps its ciphertext
  });

  it('P5: two overlapping runs clear each row once (counts sum to the total, neither errors)', async () => {
    await seed(1500, 'open', '-1 hour', 'e');
    const [a, b] = await Promise.all([drainExpiredSecretChanges(db), drainExpiredSecretChanges(db)]);
    expect(a + b).toBe(1500);
    expect(await count('expired')).toBe(1500);
  });

  it('stops between batches when asked', async () => {
    await seed(1200, 'open', '-1 hour', 'f');
    expect(await drainExpiredSecretChanges(db, { shouldStop: () => true })).toBe(500);
    expect(await count('open')).toBe(700);
  });
});
