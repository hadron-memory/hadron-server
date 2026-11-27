/**
 * #5348; cor:sec:070:02 (Decided S6: an expired request's staged value is cleared by the sweep; Proposed sweep-backlog line: bounded
 * batches, each its own bounded transaction). The production drain must make progress when a batch is slower than Prisma's
 * interactive-transaction default (5 s): it runs each batch under an explicit time bound, and a batch that overruns it is retried
 * smaller in the same run. Real database; a test-only row trigger makes each UPDATE row slow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import {
  drainExpiredSecretChanges,
  SECRET_CHANGE_SWEEP_STATEMENT_TIMEOUT_MS,
  SECRET_CHANGE_SWEEP_TX_MAX_WAIT_MS,
  SECRET_CHANGE_SWEEP_TX_TIMEOUT_MS,
} from '../lib/secrets/changeRequests.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let appId: string, userId: string;

async function seed(n: number, prefix: string) {
  await db.$executeRawUnsafe(`INSERT INTO secret_change_requests
    (id,app_id,secret_name,secret_kind,metadata,operation,requester_id,state,snapshot,write_version,expires_at)
    SELECT $1 || g, $2, 'n' || g, 'generic', '{}'::jsonb, 'DELETE', $3, 'open', 'snap', false,
      (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour' - g * interval '1 millisecond'
    FROM generate_series(1, ${n}) g`, prefix, appId, userId);
}
const count = (state: string, prefix: string) => db.secretChangeRequest.count({ where: { state, id: { startsWith: prefix } } });

/** Every updated row sleeps `seconds` (a BEFORE UPDATE row trigger, dropped after each test). */
async function slowRows(seconds: number) {
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_slow_row_5348() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN PERFORM pg_sleep(${Number(seconds)}); RETURN NEW; END $f$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER test_slow_row_5348 BEFORE UPDATE ON secret_change_requests FOR EACH ROW EXECUTE FUNCTION test_slow_row_5348()`);
}

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@sweep5348.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'sweep drain 5348', urn: `${generateId().toLowerCase()}:drain5348` } })).id;
});
afterEach(async () => {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_slow_row_5348 ON secret_change_requests');
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_slow_row_5348()');
});

describe('#5348 the expiry drain makes progress when a batch is slower than the 5 s default', () => {
  it('R1: the production bounds are explicit (statement 25 s inside a 30 s transaction, 10 s to start)', async () => {
    expect([SECRET_CHANGE_SWEEP_STATEMENT_TIMEOUT_MS, SECRET_CHANGE_SWEEP_TX_TIMEOUT_MS, SECRET_CHANGE_SWEEP_TX_MAX_WAIT_MS]).toEqual([25_000, 30_000, 10_000]);
    const seen: unknown[] = [];
    const spy = { $transaction: (f: never, opts: unknown) => { seen.push(opts); return (db.$transaction as any)(f, opts); } };
    await seed(1, 'opt');
    expect(await drainExpiredSecretChanges(spy as never)).toBe(1);
    expect(seen).toEqual([{ timeout: 30_000, maxWait: 10_000 }]);
  });

  it('R2: a 500-row batch slower than 5 s completes with the real client and production bounds', async () => {
    await seed(500, 'slow');
    await slowRows(0.015); // 500 x 15 ms = 7.5 s: past Prisma's 5 s default, inside the 25 s statement bound
    expect(await drainExpiredSecretChanges(db)).toBe(500);
    expect(await count('expired', 'slow')).toBe(500);
  });

  it('R3: a batch that overruns its bound is retried smaller in the same run, and the run clears everything', async () => {
    await seed(300, 'shrink');
    await slowRows(0.02); // 20 ms a row against a 1 s bound: limits 500, 250, 125 and 62 overrun, 31 rows (0.62 s) fit
    expect(await drainExpiredSecretChanges(db, { statementTimeoutMs: 1_000 })).toBe(300);
    expect(await count('expired', 'shrink')).toBe(300);
    expect(await count('open', 'shrink')).toBe(0);
  });

  it('R4: an overrun keeps the batches already committed in that run (oldest first) and spends a batch slot', async () => {
    await seed(40, 'keep');
    await slowRows(0.02);
    // 7 slots against a 250 ms bound: limits 500, 250, 125, 62, 31 (all 40 or 31 rows) and 15 (0.3 s) overrun; 7 rows (0.14 s)
    // commit in the last slot, and the run ends there with the rest left for the next run.
    expect(await drainExpiredSecretChanges(db, { statementTimeoutMs: 250, maxBatches: 7 })).toBe(7);
    // the oldest seven (largest g: earliest expires_at) are the ones cleared
    const cleared = await db.secretChangeRequest.findMany({ where: { state: 'expired', id: { startsWith: 'keep' } }, select: { id: true } });
    expect(cleared.map(r => Number(r.id.slice(4))).sort((a, b) => a - b)).toEqual([34, 35, 36, 37, 38, 39, 40]);
    expect(await count('open', 'keep')).toBe(33);
  });

  it('R5: a single row that still overruns is a failure of the run, not a loop', async () => {
    await seed(1, 'one');
    await slowRows(0.5);
    await expect(drainExpiredSecretChanges(db, { statementTimeoutMs: 100 })).rejects.toThrow(/statement timeout|57014/);
    expect(await count('open', 'one')).toBe(1);
  });

  it('R6: a transaction that could not START (pool wait) is not shrunk: it fails the run at once', async () => {
    let calls = 0;
    const busy = { $transaction: () => { calls++; return Promise.reject(new Prisma.PrismaClientKnownRequestError(
      'Transaction API error: Unable to start a transaction in the given time.', { code: 'P2028', clientVersion: 'test' })); } };
    await expect(drainExpiredSecretChanges(busy as never)).rejects.toThrow(/Unable to start/);
    expect(calls).toBe(1);
  });

  it('R7: an expired interactive transaction (P2028, not the start arm) is shrunk like a statement timeout', async () => {
    let calls = 0;
    const sizes: number[] = [];
    const expiring = { $transaction: (f: (tx: unknown) => Promise<number>, opts: unknown) => {
      calls++;
      if (calls === 1) return Promise.reject(new Prisma.PrismaClientKnownRequestError(
        'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 30000 ms.',
        { code: 'P2028', clientVersion: 'test' }));
      return (db.$transaction as any)(async (tx: any) => {
        const real = tx.$executeRaw.bind(tx);
        return f(new Proxy(tx, { get: (t, k) => k === '$executeRaw' ? (s: TemplateStringsArray, ...v: unknown[]) => {
          const lim = v.find(x => typeof x === 'number'); if (typeof lim === 'number') sizes.push(lim); return real(s, ...v); } : t[k] }));
      }, opts);
    } };
    await seed(3, 'exp');
    expect(await drainExpiredSecretChanges(expiring as never)).toBe(3);
    expect(sizes).toEqual([250]);
  });
});
