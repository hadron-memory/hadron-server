/**
 * #3668 S1a — ONE definition of live (cor:acl:140:03): a TypeScript function and the matching SQL fragment for locked
 * reads, both on the database clock. Pending, revoked, expired, not-yet-started and spent rows allow nothing.
 */
import { Prisma } from '../../generated/prisma/index.js';
import { Client } from 'pg';
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from './grantFixtures3668.js';
import { grantLiveSql, isGrantLive, readGrantForUpdate, type GrantLiveFields } from './live.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

// Fixed instants, so the boundary cases are exact on both sides.
const NOW = new Date('2026-06-15T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const iso = (d: Date) => d.toISOString().replace('Z', '');
const active = at(-86_400_000);

type Case = { name: string; live: boolean; row: Partial<GrantLiveFields> };
const CASES: Case[] = [
  { name: 'active, no bounds', live: true, row: { activatedAt: active } },
  { name: 'pending (never activated) allows nothing', live: false, row: { activatedAt: null } },
  { name: 'revoked allows nothing', live: false, row: { activatedAt: active, revokedAt: at(-1000) } },
  { name: 'expired one ms ago', live: false, row: { activatedAt: active, expiresAt: at(-1) } },
  { name: 'expires exactly now: not live (the end is exclusive)', live: false, row: { activatedAt: active, expiresAt: at(0) } },
  { name: 'expires one ms from now', live: true, row: { activatedAt: active, expiresAt: at(1) } },
  { name: 'starts one ms from now: before start allows nothing', live: false, row: { activatedAt: active, startsAt: at(1) } },
  { name: 'starts exactly now: live (the start is inclusive)', live: true, row: { activatedAt: active, startsAt: at(0) } },
  { name: 'started an hour ago', live: true, row: { activatedAt: active, startsAt: at(-3_600_000) } },
  { name: 'spent: use_count equals max_uses', live: false, row: { activatedAt: active, maxUses: 3, useCount: 3 } },
  { name: 'over-spent', live: false, row: { activatedAt: active, maxUses: 3, useCount: 4 } },
  { name: 'one use left', live: true, row: { activatedAt: active, maxUses: 3, useCount: 2 } },
  { name: 'no cap: use_count is irrelevant', live: true, row: { activatedAt: active, maxUses: null, useCount: 99 } },
  { name: 'pending AND expired AND revoked', live: false, row: { activatedAt: null, expiresAt: at(-1), revokedAt: at(-1) } },
];
const full = (row: Partial<GrantLiveFields>): GrantLiveFields => ({ activatedAt: null, revokedAt: null, startsAt: null, expiresAt: null, maxUses: null, useCount: 0, ...row });

describe('isGrantLive (the function)', () => {
  for (const c of CASES) it(c.name, () => expect(isGrantLive(full(c.row), NOW), c.name).toBe(c.live));
});

describe('grantLiveSql (the fragment) agrees with the function on every row, at the same instant', () => {
  it('differential over real rows', async () => {
    const ids = new Map<string, Case>();
    for (const c of CASES) {
      const r = full(c.row);
      const id = await insertGrantUnguarded(w, {
        activated_at: r.activatedAt ? raw(`'${iso(r.activatedAt)}'::timestamp`) : null,
        revoked_at: r.revokedAt ? raw(`'${iso(r.revokedAt)}'::timestamp`) : null,
        revoked_by: r.revokedAt ? w.userId : null,
        starts_at: r.startsAt ? raw(`'${iso(r.startsAt)}'::timestamp`) : null,
        expires_at: r.expiresAt ? raw(`'${iso(r.expiresAt)}'::timestamp`) : null,
        max_uses: r.maxUses, use_count: r.useCount,
      });
      ids.set(id, c);
    }
    const rows = await db.$queryRaw<Array<{ id: string; live: boolean }>>(
      Prisma.sql`SELECT g.id, (${grantLiveSql('g', Prisma.sql`${iso(NOW)}::timestamp`)}) AS live FROM grants g`);
    expect(rows).toHaveLength(CASES.length);
    for (const r of rows) expect(r.live, ids.get(r.id)!.name).toBe(ids.get(r.id)!.live);
  });

  it('the default instant is the DATABASE clock (clock_timestamp), not the transaction start: a row that expires mid-transaction is not live', async () => {
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      const id = 'g-mid-txn';
      await tx.$executeRawUnsafe(
        `INSERT INTO grants (id, app_id, user_id, action, action_values, reason, activated_at, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'test.s1a.act', '{}'::jsonb, 'r', (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour',
                 (clock_timestamp() AT TIME ZONE 'UTC') + interval '300 milliseconds', (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`, id, w.appId, w.userId);
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
      await tx.$executeRawUnsafe('SELECT pg_sleep(0.7)');
      // The scenario discriminates: against the transaction-start clock the row would still read live.
      const [txStart] = await tx.$queryRaw<Array<{ live: boolean }>>`SELECT expires_at > (now() AT TIME ZONE 'UTC') AS live FROM grants WHERE id = ${id}`;
      const [frag] = await tx.$queryRaw<Array<{ live: boolean }>>(Prisma.sql`SELECT (${grantLiveSql('g')}) AS live FROM grants g WHERE g.id = ${id}`);
      return { txStartSaysLive: txStart.live, fragmentSaysLive: frag.live };
    });
    expect(result).toEqual({ txStartSaysLive: true, fragmentSaysLive: false });
  });
});

describe('readGrantForUpdate: lock first, then judge', () => {
  it('returns the row and its verdict from one locked read', async () => {
    const id = await insertGrantUnguarded(w, { activated_at: raw(`${'(clock_timestamp() AT TIME ZONE \'UTC\')'} - interval '1 hour'`) });
    const pending = await insertGrantUnguarded(w, {});
    const out = await db.$transaction(async (tx) => ({ a: await readGrantForUpdate(tx, id), b: await readGrantForUpdate(tx, pending), c: await readGrantForUpdate(tx, 'nope') }));
    expect(out.a).toMatchObject({ live: true, row: { id } });
    expect(out.b).toMatchObject({ live: false, row: { id: pending } });
    expect(out.c).toBeNull();
  });
});

describe('readGrantForUpdate across a real lock wait (a second connection holds the row without changing it)', () => {
  // A grant that expires WHILE the read waits for the row lock must read not live: the verdict is judged after the lock is held.
  async function waitedVerdict(expiresIn: string): Promise<boolean> {
    const id = await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '1 hour'`), expires_at: raw(`${DB_NOW} + interval '${expiresIn}'`) });
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    // A separate autocommit connection observes the wait: each of its statements reads a fresh activity snapshot (cleared explicitly too).
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
    try {
      const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM grants WHERE id = $1 FOR UPDATE', [id]);
      // The reader reports its own backend PID from inside its transaction before it reads, so the wait is attributed to it and no other waiter.
      let reportPid!: (pid: number) => void;
      const readerPidP = new Promise<number>((res) => { reportPid = res; });
      const read = db.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        reportPid(pid);
        return readGrantForUpdate(tx, id);
      });
      const readerPid = await Promise.race([readerPidP, read.then(() => { throw new Error('the read finished before it could block'); })]);
      // Observe the wait for real: exactly the reader backend is blocked on exactly the holder's lock.
      const deadline = Date.now() + 5000;
      for (;;) {
        await observer.query('SELECT pg_stat_clear_snapshot()');
        const r = await observer.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $2 AND wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`, [holderPid, readerPid]);
        if (r.rows[0].n > 0) break;
        if (Date.now() > deadline) throw new Error('the read never blocked on the row lock');
        await new Promise((res) => setTimeout(res, 25));
      }
      await new Promise((res) => setTimeout(res, 1600));
      await holder.query('COMMIT');
      return (await read)!.live;
    } finally {
      await observer.end();
      await holder.end();
    }
  }
  it('expires during the wait: not live', async () => { expect(await waitedVerdict('1 second')).toBe(false); }, 20_000);
  it('control: still valid after the same wait: live', async () => { expect(await waitedVerdict('1 hour')).toBe(true); }, 20_000);
});
