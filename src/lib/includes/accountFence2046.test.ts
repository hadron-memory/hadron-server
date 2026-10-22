/**
 * #2046 S9-3: a SERIALIZABLE account transaction takes the include-history fence and proves its snapshot with the epoch
 * UPDATE, on one backend. A fence holder that committed after the snapshot (it queued ahead of the account on the
 * fence) makes the account's epoch UPDATE fail with 40001 BEFORE any work; a rolled-back holder does not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '../../generated/prisma/index.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../id.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import {
  accountFenceClient, includeHistoryClient, isSerializationConflict, withAccountFenceTransaction, withIncludeHistoryTransaction,
} from './includeHistoryFence.js';
import { retryAccountFence } from './accountFenceRetry.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const epoch = async () => Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT n FROM include_history_epoch WHERE id = 1`)[0].n);
const orgCount = (urn: string) => db.organization.count({ where: { urn } });

/** Hold the fence on one connection until released; the holder then ROLLS BACK, so it leaves no epoch bump. */
async function holdFence() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  const done = withIncludeHistoryTransaction(db, async () => { entered(); await held; throw new Error('blocker rolls back'); });
  done.catch(() => {});
  await inside;
  return { release, done: done.then(() => undefined, () => undefined) };
}

/** An account transaction whose only effect is one organization row. */
const accountOp = (urn: string, attempts?: { n: number }) => () => withAccountFenceTransaction(db, async (f) => {
  if (attempts) attempts.n++;
  await accountFenceClient(f).organization.create({ data: { id: generateId(), name: urn, urn } });
});

beforeEach(async () => { await cleanDb(db); });

/**
 * Stage: the fence is held by X; `predecessor` queues first; the account op queues second (its snapshot is taken as
 * its fence statement starts); X releases, so the predecessor commits (or aborts) before the account gets the fence.
 */
async function stage(predecessor: () => Promise<unknown>, account: () => Promise<unknown>) {
  const x = await holdFence();
  const pred = predecessor();
  pred.catch(() => {});
  await waitForLockWaitersOfType(db, 'advisory', 1, 5_000);
  const acct = account();
  acct.catch(() => {});
  await waitForLockWaitersOfType(db, 'advisory', 2, 5_000);
  x.release();
  await x.done;
  return { pred, acct };
}

describe('#2046 S9-3 account fence: stale-after-wait is detected', () => {
  it('a committed generic holder ahead of the account makes its epoch UPDATE fail 40001 with no effect; a fresh attempt succeeds once', async () => {
    const attempts = { n: 0 };
    const before = await epoch();
    const { pred, acct } = await stage(
      () => withIncludeHistoryTransaction(db, async () => {}),
      accountOp('acct-stale', attempts),
    );
    await pred;
    const error = await acct.then(() => null, (e) => e);
    expect(isSerializationConflict(error)).toBe(true);
    expect(error).toMatchObject({ code: 'P2010', meta: { code: '40001' } });
    expect(await orgCount('acct-stale')).toBe(0); // no work ran on the stale snapshot
    expect(attempts.n).toBe(0);
    expect(await epoch()).toBe(before + 1); // the predecessor only; the account bumped nothing
    // The whole-attempt retry takes a fresh snapshot and now succeeds.
    await retryAccountFence(accountOp('acct-stale', attempts), { conflictAttempts: 3 });
    expect(await orgCount('acct-stale')).toBe(1);
    expect(attempts.n).toBe(1);
    expect(await epoch()).toBe(before + 2); // predecessor, then the fresh attempt
  });

  it('a committed prior ACCOUNT operation ahead of the account is detected the same way', async () => {
    const { pred, acct } = await stage(accountOp('acct-prior'), accountOp('acct-after'));
    await pred;
    expect(isSerializationConflict(await acct.then(() => null, (e) => e))).toBe(true);
    expect(await orgCount('acct-prior')).toBe(1);
    expect(await orgCount('acct-after')).toBe(0);
  });

  it('a committed real writer (updateAgent) ahead of the account is detected', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: 'o-upd' } });
    const admin = await db.user.create({ data: { id: generateId(), name: 'a' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'ag', urn: 'o-upd:ag', organizationId: org.id, visibility: 'ORGANIZATION' } });
    const ctx = { db, userId: admin.id, roles: [], clientId: `user:${admin.id}` } as unknown as Context;
    const { pred, acct } = await stage(
      () => M.updateAgent({}, { ref: agent.id, systemPrompt: 'p' }, ctx),
      accountOp('acct-real-writer'),
    );
    await pred;
    expect(isSerializationConflict(await acct.then(() => null, (e) => e))).toBe(true);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).systemPrompt).toBe('p');
    expect(await orgCount('acct-real-writer')).toBe(0);
  });

  it('a ROLLED-BACK holder ahead of the account bumps nothing and does not fail it', async () => {
    const before = await epoch();
    const { pred, acct } = await stage(
      () => withIncludeHistoryTransaction(db, async () => { throw new Error('predecessor aborts'); }),
      accountOp('acct-after-rollback'),
    );
    await expect(pred).rejects.toThrow('predecessor aborts');
    await acct;
    expect(await orgCount('acct-after-rollback')).toBe(1);
    expect(await epoch()).toBe(before + 1); // the account only; the aborted predecessor and the blocker left no bump
  });
});

describe('#2046 S9-3 account fence: ordering, loss of the lock owner, nesting', () => {
  it('reverse order: the account holds the fence through its commit and a competing holder waits', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const acct = withAccountFenceTransaction(db, async (f) => {
      await accountFenceClient(f).organization.create({ data: { id: generateId(), name: 'rev', urn: 'rev' } });
      entered();
      await held;
    });
    await inside;
    let competitorRan = false;
    const competitor = withIncludeHistoryTransaction(db, async () => { competitorRan = true; });
    await waitForLockWaitersOfType(db, 'advisory', 1, 5_000);
    expect(competitorRan).toBe(false);
    release();
    await acct;
    await competitor;
    expect(competitorRan).toBe(true);
  });

  it('losing the backend mid-transaction rolls back the effect and the bump, and leaks no fence', async () => {
    const before = await epoch();
    let pid = 0;
    let proceed!: () => void;
    const go = new Promise<void>((r) => { proceed = r; });
    let ready!: () => void;
    const isReady = new Promise<void>((r) => { ready = r; });
    const acct = withAccountFenceTransaction(db, async (f) => {
      const tx = accountFenceClient(f);
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx.organization.create({ data: { id: generateId(), name: 'dead', urn: 'dead' } });
      ready();
      await go;
      await tx.organization.create({ data: { id: generateId(), name: 'dead2', urn: 'dead2' } });
    });
    acct.catch(() => {});
    await isReady;
    await db.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`;
    proceed();
    await expect(acct).rejects.toBeTruthy();
    // Prisma's pool may still hand out the killed connection once; flush it so the assertions below use live ones.
    for (let i = 0; i < 5; i++) await db.$queryRaw`SELECT 1`.catch(() => {});
    expect(await orgCount('dead')).toBe(0);
    expect(await epoch()).toBe(before);
    // The fence is free: a new holder enters at once.
    await withIncludeHistoryTransaction(db, async () => {}, { timeoutMs: 2_000 });
    expect(await epoch()).toBe(before + 1);
  });

  it('refuses every nesting of the two modes before any statement', async () => {
    const before = await epoch();
    await expect(withIncludeHistoryTransaction(db, async () => { await withIncludeHistoryTransaction(db, async () => {}); })).rejects.toThrow(/nested/);
    await expect(withIncludeHistoryTransaction(db, async () => { await withAccountFenceTransaction(db, async () => {}); })).rejects.toThrow(/nested/);
    await expect(withAccountFenceTransaction(db, async () => { await withIncludeHistoryTransaction(db, async () => {}); })).rejects.toThrow(/nested/);
    await expect(withAccountFenceTransaction(db, async () => { await withAccountFenceTransaction(db, async () => {}); })).rejects.toThrow(/nested/);
    expect(await epoch()).toBe(before); // each outer transaction rolled back, bump included
  });

  it('a proof does not cross modes or outlive its transaction', async () => {
    let rc: any;
    let account: any;
    await withIncludeHistoryTransaction(db, async (c) => { rc = c; });
    await withAccountFenceTransaction(db, async (c) => { account = c; });
    expect(() => accountFenceClient(rc)).toThrow(/live prepared account-fence/);
    expect(() => includeHistoryClient(account)).toThrow(/live prepared include-history/);
    expect(() => accountFenceClient(account)).toThrow(/live prepared account-fence/);
  });
});

describe('#2046 S9-3 conflict classifier and whole-attempt retry', () => {
  const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test', meta });

  it('classifies P2034 and P2010 with 40001/40P01 only', () => {
    expect(isSerializationConflict(known('P2034'))).toBe(true);
    expect(isSerializationConflict(known('P2010', { code: '40001' }))).toBe(true);
    expect(isSerializationConflict(known('P2010', { code: '40P01' }))).toBe(true);
    expect(isSerializationConflict(known('P2010', { code: '55P03' }))).toBe(false); // lock_timeout
    expect(isSerializationConflict(known('P2010', { code: '23514' }))).toBe(false); // epoch guard
    expect(isSerializationConflict(known('P2028'))).toBe(false); // transaction timeout
    expect(isSerializationConflict(new Error('The include-history epoch row is missing'))).toBe(false);
  });

  it('stops at the attempt budget with the conflict, and re-runs only conflicts', async () => {
    let n = 0;
    await expect(retryAccountFence(async () => { n++; throw known('P2034'); }, { conflictAttempts: 3 })).rejects.toMatchObject({ code: 'P2034' });
    expect(n).toBe(3);
    let m = 0;
    await expect(retryAccountFence(async () => { m++; throw new Error('boom'); }, { conflictAttempts: 3 })).rejects.toThrow('boom');
    expect(m).toBe(1);
  });

  it('keeps the semantic budget separate from the conflict budget', async () => {
    class Stale extends Error {}
    let n = 0;
    const result = await retryAccountFence(async () => {
      n++;
      if (n === 1) throw new Stale();
      if (n === 2) throw known('P2010', { code: '40001' });
      if (n === 3) throw new Stale();
      return 'ok';
    }, { conflictAttempts: 2, semantic: (e) => e instanceof Stale, semanticRetries: 2 });
    expect(result).toBe('ok');
    expect(n).toBe(4);
    let k = 0;
    await expect(retryAccountFence(async () => { k++; throw new Stale(); }, { conflictAttempts: 9, semantic: (e) => e instanceof Stale, semanticRetries: 1 })).rejects.toBeInstanceOf(Stale);
    expect(k).toBe(2);
  });

  it('gives up at the overall deadline', async () => {
    let n = 0;
    await expect(retryAccountFence(async () => { n++; throw known('P2034'); }, { conflictAttempts: 1000, deadlineMs: 30 })).rejects.toMatchObject({ code: 'P2034' });
    expect(n).toBeLessThan(1000);
  });
});

describe('#2046 S9-3 the fence key has one acquisition site', () => {
  it('no other source takes advisory key (2063, 1772) or its alias', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== 'generated' && name !== 'node_modules') walk(path); continue; }
        if (!/\.(ts|sql)$/.test(name) || /\.test\.ts$/.test(name)) continue;
        const text = readFileSync(path, 'utf8');
        if (/2063\s*,\s*1772/.test(text) || (/pg_advisory_(xact_)?lock/.test(text) && /\b2063\b/.test(text) && /\b1772\b/.test(text))) {
          offenders.push(path);
        }
      }
    };
    walk(new URL('../../', import.meta.url).pathname);
    walk(new URL('../../../prisma/', import.meta.url).pathname);
    expect(offenders.map((p) => p.replace(/^.*\/(src|prisma)\//, '$1/'))).toEqual(['src/lib/includes/includeHistoryFence.ts']);
  });
});
