/**
 * #3748 items 2 and 3: the shared lock observer and deadline used by the #3737 lock-order pins (`./lockObserver.ts`).
 *
 * - Item 2 (one joined deadline): a participant that never settles fails with the named message from the ONE deadline,
 *   not with vitest's generic test timeout.
 * - Item 3 (observer scope): an unrelated backend left waiting on a lock in the same database, started here, never
 *   satisfies `waitBlocked`, whether its statement differs or it is blocked by someone other than the expected holder.
 *   Only the expected statement, blocked by the expected pid, does. Removing either half of the scope fails a pin here.
 */
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { backendPid, deadline, waitBlocked, within } from './lockObserver.js';

describe('#3748 item 2: one joined deadline', () => {
  it('a participant that never settles fails with the named message, inside the deadline', async () => {
    const started = Date.now();
    const hang = new Promise<never>(() => undefined);
    await expect(within(deadline(300), 'proof/completion', Promise.all([Promise.resolve('done'), hang])))
      .rejects.toThrow('proof/completion did not settle within 300 ms');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a join that settles in time returns its value', async () => {
    await expect(within(deadline(2_000), 'proof/completion', Promise.all([Promise.resolve(1), Promise.resolve(2)])))
      .resolves.toEqual([1, 2]);
  });
});

describe('#3748 item 3: the lock observer matches only the expected waiter', () => {
  const clients: Client[] = [];
  const connect = async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query(`SET statement_timeout = '20s'`);
    clients.push(c);
    return c;
  };
  /** Bounded poll until `pid` is itself waiting on a lock (a staged decoy really is a waiter). */
  const untilWaiting = async (observer: Client, pid: number) => {
    const until = Date.now() + 8_000;
    for (;;) {
      await observer.query('SELECT pg_stat_clear_snapshot()');
      const r = await observer.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`, [pid]);
      if (r.rowCount) return;
      if (Date.now() > until) throw new Error(`backend ${pid} never started waiting`);
      await new Promise((res) => setTimeout(res, 25));
    }
  };
  let observer: Client;
  let gate: Client;
  let gatePid: number;

  beforeEach(async () => {
    await cleanDb(db);
    observer = await connect();
    gate = await connect();
    gatePid = await backendPid(gate);
    await gate.query('BEGIN');
    await gate.query(`SELECT pg_advisory_xact_lock(3748, 1)`);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end().catch(() => undefined);
    }
  });

  it('a waiter on another statement does not satisfy it, even when the expected holder is what blocks it', async () => {
    // The decoy waits on a row the GATE holds, so only the statement half of the scope can reject it.
    const user = await db.user.create({ data: { handle: 'lo3748-row', roles: [] } });
    const decoy = await connect();
    await gate.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    const decoyPid = await backendPid(decoy);
    const parked = decoy.query('BEGIN').then(() => decoy.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id])).catch(() => undefined);
    await untilWaiting(observer, decoyPid);
    await expect(waitBlocked(observer, deadline(600), { query: /pg_advisory_xact_lock/, blockedBy: [gatePid] }))
      .rejects.toThrow(/no backend matching .* blocked by \[\d+\] within 600 ms/);
    await gate.query('COMMIT');
    await parked;
  });

  it('a waiter on the same statement but behind another holder does not satisfy it', async () => {
    const holder = await connect();
    const decoy = await connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(3748, 2)`);
    const decoyPid = await backendPid(decoy);
    const parked = decoy.query('BEGIN').then(() => decoy.query(`SELECT pg_advisory_xact_lock(3748, 2)`)).catch(() => undefined);
    await untilWaiting(observer, decoyPid);
    await expect(waitBlocked(observer, deadline(600), { query: /pg_advisory_xact_lock/, blockedBy: [gatePid] }))
      .rejects.toThrow(/within 600 ms/);
    await holder.query('COMMIT');
    await parked;
  });

  it('the expected statement, blocked by the expected holder, is found even while a decoy waits', async () => {
    const holder = await connect();
    const decoy = await connect();
    const waiter = await connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(3748, 2)`);
    const decoyPid = await backendPid(decoy);
    const parkedDecoy = decoy.query('BEGIN').then(() => decoy.query(`SELECT pg_advisory_xact_lock(3748, 2)`)).catch(() => undefined);
    await untilWaiting(observer, decoyPid);
    const waiterPid = await backendPid(waiter);
    const parked = waiter.query('BEGIN').then(() => waiter.query(`SELECT pg_advisory_xact_lock(3748, 1)`)).catch(() => undefined);
    const hit = await waitBlocked(observer, deadline(8_000), { query: /pg_advisory_xact_lock/, blockedBy: [gatePid] });
    expect(hit.pid).toBe(waiterPid);
    expect(hit.blockers).toEqual([gatePid]);
    await gate.query('COMMIT');
    await holder.query('COMMIT');
    await Promise.all([parked, parkedDecoy]);
  });
});
