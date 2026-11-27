/** #5333; cor:sec:070:02 (Edge Case, Decided 2026-11-26; `stale` Proposed): an ended request's record is deleted 30 days after it ended. Real database. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import {
  drainEndedSecretChanges, SECRET_CHANGE_RETENTION_DAYS, SECRET_CHANGE_RETENTION_STATES,
  SECRET_CHANGE_SWEEP_BATCH, SECRET_CHANGE_SWEEP_MAX_BATCHES,
} from '../lib/secrets/changeRequests.js';
import { startSecretChangeSweepLoop } from './sweepSecretChanges.js';

// Seeding and draining 10,050 rows in 500-row transactions outruns the 5 s default on a shared runner.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type State = 'open' | 'completed' | 'declined' | 'expired' | 'withdrawn' | 'stale';
const ENDED: State[] = ['completed', 'declined', 'expired', 'withdrawn', 'stale'];
let appId: string, userId: string;

/** `n` non-STORE rows in `state`; an ended row's `ended_at` is `ended` (a SQL interval before the DB clock). created_at and expires_at are long past. */
async function seed(n: number, state: State, ended: string, prefix: string) {
  await db.$executeRawUnsafe(`INSERT INTO secret_change_requests
    (id,app_id,secret_name,secret_kind,metadata,operation,requester_id,state,snapshot,write_version,created_at,expires_at,ended_at)
    SELECT $1 || g, $2, 'n' || g, 'generic', '{"k":"v"}'::jsonb, 'DELETE', $3, $4, 'snap', false,
      (clock_timestamp() AT TIME ZONE 'UTC') - interval '90 days',
      (clock_timestamp() AT TIME ZONE 'UTC') - interval '89 days' - g * interval '1 millisecond',
      CASE WHEN $4 = 'open' THEN NULL ELSE (clock_timestamp() AT TIME ZONE 'UTC') - interval '${ended}' - g * interval '1 millisecond' END
    FROM generate_series(1, ${n}) g`, prefix, appId, userId, state);
}
const count = (prefix: string) => db.secretChangeRequest.count({ where: { id: { startsWith: prefix } } });
const TX_MS = 100_000;
const roomy = { $transaction: (f: never) => (db.$transaction as any)(f, { timeout: TX_MS, maxWait: TX_MS }) };
const OLD = '30 days 1 hour', YOUNG = '29 days 23 hours';

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@sweep5333.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'retention', urn: `${generateId().toLowerCase()}:retention` } })).id;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('#5333 ended-request retention', () => {
  for (const s of ENDED.filter(x => x !== 'stale')) {
    it(`P1: a ${s} request ended 30 d + 1 h ago is deleted by one run`, async () => {
      await seed(1, s, OLD, 'p1');
      expect(await drainEndedSecretChanges(roomy as never)).toBe(1);
      expect(await count('p1')).toBe(0);
    });
  }
  it('P1s: a STALE request follows the same rule (Proposed in cor:sec:070:02; dropping stale is a one-line change)', async () => {
    await seed(1, 'stale', OLD, 'p1s');
    expect(await drainEndedSecretChanges(roomy as never)).toBe(1);
    expect(await count('p1s')).toBe(0);
  });
  for (const s of ENDED) {
    it(`P2: a ${s} request ended 30 d - 1 h ago is kept`, async () => {
      await seed(1, s, YOUNG, 'p2');
      expect(await drainEndedSecretChanges(roomy as never)).toBe(0);
      expect(await count('p2')).toBe(1);
    });
  }

  it('P3: an open request is never deleted, however old, and an open STORE keeps its ciphertext', async () => {
    await seed(3, 'open', '0 days', 'p3');
    await db.$executeRaw`INSERT INTO secret_change_requests (id,app_id,secret_name,secret_kind,metadata,operation,requester_id,state,snapshot,staged_value_encrypted,key_version,size_bytes,write_version,created_at,expires_at)
      VALUES ('p3store',${appId},'s','generic','{}'::jsonb,'STORE',${userId},'open','snap','CIPHERTEXT',1,7,true,(clock_timestamp() AT TIME ZONE 'UTC') - interval '90 days',(clock_timestamp() AT TIME ZONE 'UTC') - interval '89 days')`;
    expect(await drainEndedSecretChanges(roomy as never)).toBe(0);
    expect(await count('p3')).toBe(4);
    const [row] = await db.$queryRaw<Array<{ c: string }>>`SELECT staged_value_encrypted AS c FROM secret_change_requests WHERE id='p3store'`;
    expect(row.c).toBe('CIPHERTEXT');
  });

  it('P4: the batch is 500 and each batch commits alone (a later failure keeps the earlier ones)', async () => {
    await seed(1200, 'completed', OLD, 'p4');
    let calls = 0;
    const flaky = { $transaction: (f: never) => { if (++calls === 2) return Promise.reject(new Error('batch 2 failed')); return (roomy.$transaction as any)(f); } };
    await expect(drainEndedSecretChanges(flaky as never)).rejects.toThrow('batch 2 failed');
    expect(await count('p4')).toBe(700);
  });
  it('P4b: a run stops at the per-run bound (20 x 500); the rest waits for the next run', async () => {
    await seed(10_050, 'completed', OLD, 'p4b');
    expect(await drainEndedSecretChanges(roomy as never)).toBe(10_000);
    expect(await count('p4b')).toBe(50);
    expect(await drainEndedSecretChanges(roomy as never)).toBe(50);
  });
  it('P4c: shouldStop stops between batches', async () => {
    await seed(1200, 'completed', OLD, 'p4c');
    expect(await drainEndedSecretChanges(roomy as never, { shouldStop: () => true })).toBe(500);
    expect(await count('p4c')).toBe(700);
  });

  it('P5: two overlapping runs delete each row once', async () => {
    await seed(1500, 'declined', OLD, 'p5');
    const [a, b] = await Promise.all([drainEndedSecretChanges(roomy as never), drainEndedSecretChanges(roomy as never)]);
    expect(a + b).toBe(1500);
    expect(await count('p5')).toBe(0);
  });
  it('P5b: a candidate row locked by another connection is skipped, not waited for', async () => {
    await seed(5, 'completed', OLD, 'p5b');
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>(r => { locked = r; });
    const holder = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM secret_change_requests WHERE id='p5b1' FOR UPDATE`;
      locked();
      await held;
    }, { timeout: TX_MS, maxWait: TX_MS });
    await lockedP;
    try {
      const r = await Promise.race([drainEndedSecretChanges(roomy as never), new Promise<'waited'>(res => setTimeout(() => res('waited'), 2000))]);
      expect(r).toBe(4);
    } finally { release(); await holder; }
    expect(await db.secretChangeRequest.count({ where: { id: 'p5b1' } })).toBe(1);
    expect(await count('p5b')).toBe(1);
  });

  it('P6: an ended row can never hold a value (the schema clears it), and the run never changes a surviving row', async () => {
    await db.$executeRaw`INSERT INTO secret_change_requests (id,app_id,secret_name,secret_kind,metadata,operation,requester_id,state,snapshot,staged_value_encrypted,key_version,size_bytes,write_version,expires_at,ended_at)
      VALUES ('p6bad',${appId},'s','generic','{}'::jsonb,'STORE',${userId},'completed','snap','CIPHERTEXT',1,7,true,(clock_timestamp() AT TIME ZONE 'UTC'),(clock_timestamp() AT TIME ZONE 'UTC'))`;
    expect((await db.$queryRaw<Array<{ c: string | null }>>`SELECT staged_value_encrypted AS c FROM secret_change_requests WHERE id='p6bad'`)[0].c).toBeNull();
    await seed(2, 'completed', OLD, 'p6old');
    await seed(2, 'completed', YOUNG, 'p6new');
    await seed(2, 'open', '0 days', 'p6open');
    const snap = () => db.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM secret_change_requests WHERE id LIKE 'p6new%' OR id LIKE 'p6open%' ORDER BY id`;
    const before = await snap();
    expect(await drainEndedSecretChanges(roomy as never)).toBe(2);
    expect(await snap()).toEqual(before);
  });

  it('P7: nothing references secret_change_requests (no foreign key, no other change_request column)', async () => {
    const fks = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_constraint WHERE contype='f' AND confrelid='public.secret_change_requests'::regclass`;
    expect(Number(fks[0].n)).toBe(0);
    const cols = await db.$queryRaw<Array<{ t: string; c: string }>>`SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema='public' AND column_name LIKE '%change_request%'`;
    expect(cols).toEqual([]);
  });

  it('P8: the retention is a 30-day constant over exactly the five ended states, with the drain batch shape', () => {
    expect(SECRET_CHANGE_RETENTION_DAYS).toBe(30);
    expect([...SECRET_CHANGE_RETENTION_STATES].sort()).toEqual([...ENDED].sort());
    expect([SECRET_CHANGE_SWEEP_BATCH, SECRET_CHANGE_SWEEP_MAX_BATCHES]).toEqual([500, 20]);
  });

  it('P9: a tick runs the expiry drain then the retention phase (also with DISABLE_SECRET_SWEEP), and a drain rejection still runs retention', async () => {
    vi.useFakeTimers(); vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('DISABLE_SECRET_SWEEP', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql: string[] = [];
    let n = 0;
    const execute = vi.fn((s: TemplateStringsArray) => { sql.push(s.join('?')); return ++n === 1 ? Promise.reject(new Error('secret-detail')) : Promise.resolve(0); });
    const loop = startSecretChangeSweepLoop({ $transaction: async (f: Function) => f({ $executeRaw: execute }) } as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sql[0]).toMatch(/UPDATE secret_change_requests/);
    expect(sql[1]).toMatch(/DELETE FROM secret_change_requests/);
    expect(warn.mock.calls).toEqual([['secret.change_sweep.failed']]);
    await loop!.stop();
    warn.mockRestore();
  });
});
