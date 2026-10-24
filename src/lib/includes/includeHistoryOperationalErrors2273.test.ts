import { describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../id.js';
import { includeHistoryClient, withIncludeHistoryTransaction, type IncludeHistoryTransaction } from './includeHistoryFence.js';
const fakeDb = (transaction: unknown) => ({ $transaction: transaction }) as Pick<PrismaClient, '$transaction'>;
const rawError = (code: string) => new Prisma.PrismaClientKnownRequestError('private SQL details', { code: 'P2010', clientVersion: 'test', meta: { code } });
describe('#2273 settled operational failure classification', () => {
 it.each([rawError('55P03'), Object.assign(new Error('private detail'), { code: '55P03' })])('sanitizes recognized lock contention only after transaction rejection settles', async error => {
  let settled = false;
  const transaction = vi.fn(async () => { try { throw error; } finally { settled = true; } });
  let result: unknown;
  try { await withIncludeHistoryTransaction(fakeDb(transaction), async () => undefined); } catch (e) { result = e; }
  expect(settled).toBe(true); expect(transaction).toHaveBeenCalledTimes(1);
  expect(result).toBeInstanceOf(GraphQLError);
  expect(result).toMatchObject({ extensions: { code: 'INCLUDE_HISTORY_BUSY', retryable: true } });
  expect((result as Error).message).not.toContain('private');
  expect((result as Error).cause).toBeUndefined();
 });
 it.each([rawError('40P01'), Object.assign(new Error('driver expiry'), { code: 'P2028' }), Object.assign(new Error('pool'), { code: 'P2024' }), new GraphQLError('domain', { extensions: { code: 'FORBIDDEN' } })])('preserves unrelated failure identity', async error => {
  await expect(withIncludeHistoryTransaction(fakeDb(async () => { throw error; }), async () => undefined)).rejects.toBe(error);
 });
 it('distinguishes an active callback deadline from a returned proof', async () => {
  let now = 0; let escaped!: IncludeHistoryTransaction;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const tx = { $executeRaw: vi.fn(async () => 1) };
  try {
   const transaction = async (work: (tx: unknown) => unknown) => work(tx);
   await expect(withIncludeHistoryTransaction(fakeDb(transaction), async context => {
    escaped = context; now = 101; includeHistoryClient(context);
   }, { timeoutMs: 100 })).rejects.toMatchObject({ extensions: { code: 'INCLUDE_HISTORY_EXPIRED', retryable: true } });
   expect(() => includeHistoryClient(escaped)).toThrow('A live prepared include-history transaction is required');
  } finally { clock.mockRestore(); }
 });
 it('rolls back staged writes on a later row-lock timeout, using neutral contention wording', async () => {
  const target = generateId(); const staged = generateId(); let release!: () => void; let held!: () => void;
  const holding = new Promise<void>(r => { held = r; }); const unblock = new Promise<void>(r => { release = r; });
  await db.user.create({ data: { id: target, email: `${target}@example.test` } });
  const holder = db.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM users WHERE id = ${target} FOR UPDATE`; held(); await unblock; });
  await holding; let escaped!: IncludeHistoryTransaction;
  try {
   await expect(withIncludeHistoryTransaction(db, async context => {
    escaped = context; const tx = includeHistoryClient(context);
    await tx.user.create({ data: { id: staged, email: `${staged}@example.test` } });
    await tx.$executeRaw`SELECT set_config('lock_timeout', '80ms', true)`;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${target} FOR UPDATE`;
   }, { timeoutMs: 3000 })).rejects.toMatchObject({ extensions: { code: 'INCLUDE_HISTORY_BUSY', retryable: true } });
   expect(await db.user.findUnique({ where: { id: staged } })).toBeNull();
   expect(() => includeHistoryClient(escaped)).toThrow(/prepared include-history/);
  } finally { release(); await holder; await db.user.deleteMany({ where: { id: { in: [target, staged] } } }); }
  await expect(withIncludeHistoryTransaction(db, async () => 'released')).resolves.toBe('released');
 });
 it('restores connection-local lock_timeout after both commit and rollback', async () => {
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('connection_limit', '1');
  const one = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const setting = async () => (await one.$queryRaw<Array<{ value: string }>>`SELECT current_setting('lock_timeout') AS value`)[0].value;
  try {
   const before = await setting();
   await withIncludeHistoryTransaction(one, async context => {
    expect((await includeHistoryClient(context).$queryRaw<Array<{ value: string }>>`SELECT current_setting('lock_timeout') AS value`)[0].value).toBe('2s');
   }, { timeoutMs: 2000 });
   expect(await setting()).toBe(before);
   const domain = new Error('domain refusal');
   await expect(withIncludeHistoryTransaction(one, async () => { throw domain; }, { timeoutMs: 2000 })).rejects.toBe(domain);
   expect(await setting()).toBe(before);
  } finally { await one.$disconnect(); }
 });
 it('observes a real held-fence waiter and preserves the documented P2028 race limit', async () => {
  let release!: () => void; let held!: () => void;
  const holding = new Promise<void>(r => { held = r; }); const unblock = new Promise<void>(r => { release = r; });
  const holder = withIncludeHistoryTransaction(db, async () => { held(); await unblock; });
  await holding; const callback = vi.fn(async () => 'entered');
  const waiter = withIncludeHistoryTransaction(db, callback, { timeoutMs: 1500 });
  const result = waiter.then(() => null, (e: unknown) => e);
  let observed = false;
  try {
   const until = Date.now() + 1000;
   while (Date.now() < until) {
    const [{ count }] = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND classid=2063 AND objid=1772 AND objsubid=2 AND NOT granted`;
    if (count === 1) { observed = true; break; }
    await new Promise(r => setTimeout(r, 10));
   }
   expect(observed).toBe(true);
   const failure = await result;
   expect(callback).not.toHaveBeenCalled();
   // Only recognized 55P03 gets BUSY; actual Prisma expiry has no safe
   // structured discriminator and is deliberately preserved unclassified.
   expect(failure).toBeInstanceOf(Error);
   const e = failure as { code?: string; extensions?: { code?: string } };
   expect(e.extensions?.code === 'INCLUDE_HISTORY_BUSY' || e.code === 'P2028').toBe(true);
  } finally { release(); await Promise.allSettled([holder, waiter]); }
  await expect(withIncludeHistoryTransaction(db, async () => 'admitted')).resolves.toBe('admitted');
 });

});
