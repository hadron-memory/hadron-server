/** #1739: unrelated real PostgreSQL waiters must not release a race barrier. */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { db } from '../integrations/db/client.js';
import { generateId } from '../lib/id.js';
import { advisoryWaiterPresent, type AdvisoryWaiter } from './advisoryWaiter.js';

const clients: Client[] = [];
const blocked: Promise<unknown>[] = [];
afterEach(async () => {
  // Releasing the holders first lets every blocked query settle before close.
  for (const client of clients.filter((_, i) => i % 2 === 0)) await client.query('ROLLBACK');
  await Promise.allSettled(blocked);
  for (const client of clients) { await client.query('ROLLBACK'); await client.end(); }
  clients.length = 0; blocked.length = 0;
});
async function pair(foreign = false): Promise<[Client, Client, number]> {
  const url = new URL(process.env.DATABASE_URL!);
  if (foreign) url.pathname = '/postgres';
  const holder = new Client({ connectionString: url.toString() });
  const waiter = new Client({ connectionString: url.toString() });
  clients.push(holder, waiter);
  await holder.connect(); await waiter.connect();
  await holder.query('BEGIN'); await waiter.query('BEGIN');
  const { rows } = await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return [holder, waiter, rows[0].pid];
}
/** Independently prove the named fixture backend is blocked, not a guessed delay. */
async function staged(pid: number) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT wait_event_type = 'Lock' AND wait_event = 'advisory' AS waiting
      FROM pg_stat_activity WHERE pid = ${pid}`;
    if (rows[0]?.waiting) return;
    if (Date.now() > deadline) throw new Error('fixture backend never blocked on its advisory key');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function intWait(foreign = false, wrongForm = false) {
  const first = generateId(); const second = 'decisions';
  const [holder, waiter, pid] = await pair(foreign);
  const sql = wrongForm
    ? 'SELECT pg_advisory_xact_lock(((hashtext($1)::bigint & 4294967295) << 32) | (hashtext($2)::bigint & 4294967295))'
    : 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))';
  await holder.query(sql, [first, second]);
  const pending = waiter.query(sql, [first, second]);
  blocked.push(pending); void pending.catch(() => {});
  await staged(pid);
  return { pid, key: { form: 'int-pair', first, second } } satisfies AdvisoryWaiter;
}
describe('#1739 advisory barrier identity', () => {
  it('rejects another backend even when database and both key ids match', async () => {
    const scope = await intWait();
    const { rows } = await clients[0].query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(await advisoryWaiterPresent(db, { ...scope, pid: rows[0].pid }), '#1739 another backend released the barrier').toBe(false);
    expect(await advisoryWaiterPresent(db, scope)).toBe(true);
  });
  it('rejects another key on the intended backend in the same database', async () => {
    const scope = await intWait();
    expect(await advisoryWaiterPresent(db, { ...scope, key: { ...scope.key, second: 'different-key' } }), '#1739 unrelated key released the barrier').toBe(false);
    expect(await advisoryWaiterPresent(db, { ...scope, key: { ...scope.key, first: 'different-memory' } })).toBe(false);
    expect(await advisoryWaiterPresent(db, scope)).toBe(true);
  });
  it('rejects the same backend/key in another database', async () => {
    const scope = await intWait(true);
    expect(await advisoryWaiterPresent(db, scope), '#1739 another database released the barrier').toBe(false);
  });
  it('distinguishes bigint and two-int locks with identical classid and objid', async () => {
    const scope = await intWait(false, true);
    expect(await advisoryWaiterPresent(db, scope), '#1739 wrong lock function form released the barrier').toBe(false);
  });
  it('recognizes the reportsTo hashed-bigint form on the intended backend', async () => {
    const [holder, waiter, pid] = await pair();
    const value = `worker-reports-to:${generateId()}`;
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [value]);
    const pending = waiter.query('SELECT pg_advisory_xact_lock(hashtext($1))', [value]);
    blocked.push(pending); void pending.catch(() => {});
    await staged(pid);
    expect(await advisoryWaiterPresent(db, { pid, key: { form: 'hashed-bigint', value: 'other' } })).toBe(false);
    expect(await advisoryWaiterPresent(db, { pid, key: { form: 'hashed-bigint', value } })).toBe(true);
  });
});
