import { describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { generateId } from '../id.js';
import {
  includeHistoryClient,
  withIncludeHistoryTransaction,
  type IncludeHistoryTransaction,
} from './includeHistoryFence.js';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function recordedClient() {
  const events: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
      events.push(sql.join('?'));
      return 1;
    }),
  } as unknown as Prisma.TransactionClient;
  const client = {
    $transaction: vi.fn(async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;
  return { client, tx, events };
}

describe('#2063 include-history prepared transaction boundary', () => {
  it('takes the one exclusive fence before handing the transaction to any inner work', async () => {
    const { client, tx, events } = recordedClient();
    await withIncludeHistoryTransaction(client, async (prepared) => {
      expect(includeHistoryClient(prepared)).toBe(tx);
      events.push('authority/rows/work');
    });
    expect(events).toEqual([
      expect.stringMatching(/SELECT pg_advisory_xact_lock\(2063, 1772\)/),
      'authority/rows/work',
    ]);
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 30_000,
    });
  });

  it('does not enter the callback or publish a context when fence acquisition fails', async () => {
    const { client, tx } = recordedClient();
    vi.mocked(tx.$executeRaw).mockRejectedValueOnce(new Error('lock cancelled'));
    const work = vi.fn();
    await expect(withIncludeHistoryTransaction(client, work)).rejects.toThrow('lock cancelled');
    expect(work).not.toHaveBeenCalled();
  });

  it('does not run work after the entire transaction budget was spent waiting for the fence', async () => {
    const { client, tx } = recordedClient();
    vi.mocked(tx.$executeRaw).mockImplementationOnce((async () => {
      await new Promise((done) => setTimeout(done, 30));
      return 1;
    }) as unknown as typeof tx.$executeRaw);
    const work = vi.fn();
    await expect(withIncludeHistoryTransaction(client, work, { timeoutMs: 10 }))
      .rejects.toThrow(/expired/i);
    expect(work).not.toHaveBeenCalled();
  });

  it('refuses forged contexts, pooled clients, and raw transaction clients before any query', () => {
    const { client, tx } = recordedClient();
    for (const value of [undefined, null, {}, client, tx]) {
      expect(() => includeHistoryClient(value as IncludeHistoryTransaction))
        .toThrow(/prepared include-history transaction/i);
    }
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])('invalidates the context after callback completion (throws=%s)', async (throws) => {
    const { client } = recordedClient();
    let escaped!: IncludeHistoryTransaction;
    const result = withIncludeHistoryTransaction(client, async (prepared) => {
      escaped = prepared;
      if (throws) throw new Error('rollback');
    });
    if (throws) await expect(result).rejects.toThrow('rollback');
    else await result;
    expect(() => includeHistoryClient(escaped)).toThrow(/prepared include-history transaction/i);
  });

  it('refuses a context whose transaction budget expired while its callback was still running', async () => {
    const { client } = recordedClient();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      await withIncludeHistoryTransaction(client, async (prepared) => {
        expect(includeHistoryClient(prepared)).toBeDefined();
        clock.mockReturnValue(30_100);
        expect(() => includeHistoryClient(prepared)).toThrow(/prepared include-history transaction/i);
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('refuses a nested pooled wrapper instead of waiting for another connection behind its own fence', async () => {
    const { client } = recordedClient();
    await withIncludeHistoryTransaction(client, async () => {
      await expect(withIncludeHistoryTransaction(client, async () => undefined))
        .rejects.toThrow(/nested include-history transaction/i);
    });
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid transaction budgets (%s) before opening a transaction', async (value) => {
    const { client } = recordedClient();
    await expect(withIncludeHistoryTransaction(client, async () => undefined, { timeoutMs: value }))
      .rejects.toThrow(/positive safe integer/i);
    await expect(withIncludeHistoryTransaction(client, async () => undefined, { maxWaitMs: value }))
      .rejects.toThrow(/positive safe integer/i);
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});

describe('#2063 exclusive fence over real Postgres transactions', () => {
  it('restores lock_timeout on the same pooled connection after the fence commits', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '1');
    const single = new PrismaClient({ datasourceUrl: url.toString() });
    const inspect = (tx: Prisma.TransactionClient) => tx.$queryRaw<Array<{ pid: number; timeout: string }>>`
      SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS timeout`;
    try {
      const [before] = await single.$transaction(inspect);
      await withIncludeHistoryTransaction(single, async (prepared) => {
        const [inside] = await inspect(includeHistoryClient(prepared));
        expect(inside.pid).toBe(before.pid);
        expect(inside.timeout).toBe('4321ms');
      }, { timeoutMs: 4321 });
      const [after] = await single.$transaction(inspect);
      expect(after.pid).toBe(before.pid);
      expect(after.timeout).toBe(before.timeout);
    } finally {
      await single.$disconnect();
    }
  });

  it('completes an eight-call burst on a two-connection pool without a second pooled client', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '2');
    const limited = new PrismaClient({ datasourceUrl: url.toString() });
    const started = performance.now();
    let active = 0;
    let maximum = 0;
    try {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        withIncludeHistoryTransaction(limited, async (prepared) => {
          active += 1;
          maximum = Math.max(maximum, active);
          try {
            await includeHistoryClient(prepared).$executeRaw`SELECT pg_sleep(0.005)`;
            return i;
          } finally {
            active -= 1;
          }
        })));
      expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(maximum).toBe(1);
      console.info(`#2063 serialized burst: 8 transactions / pool 2 / ${Math.round(performance.now() - started)}ms`);
    } finally {
      await limited.$disconnect();
    }
  });

  it('serializes two outer transactions and reads commits made during the wait', async () => {
    const user = await db.user.create({ data: { email: `fence-${generateId()}@example.test` } });
    const holding = latch();
    const release = latch();
    let entered = false;
    const first = withIncludeHistoryTransaction(db, async (prepared) => {
      const tx = includeHistoryClient(prepared);
      await tx.user.update({ where: { id: user.id }, data: { email: `committed-${user.id}@example.test` } });
      holding.resolve();
      await release.promise;
    });
    await holding.promise;
    const second = withIncludeHistoryTransaction(db, async (prepared) => {
      entered = true;
      const tx = includeHistoryClient(prepared);
      const [{ isolation }] = await tx.$queryRaw<Array<{ isolation: string }>>`
        SELECT current_setting('transaction_isolation') AS isolation`;
      expect(isolation).toBe('read committed');
      return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true } });
    });
    // Attach rejection handling immediately; a negative-control mutant may fail early.
    const outcome = second.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 2_000);
      expect(entered).toBe(false);
    } finally {
      release.resolve();
      await first;
    }
    expect(await outcome).toEqual({ value: { email: `committed-${user.id}@example.test` } });
  });

  it('rolls back inner writes and releases the fence after a callback refusal', async () => {
    const id = generateId();
    await expect(withIncludeHistoryTransaction(db, async (prepared) => {
      await includeHistoryClient(prepared).user.create({ data: { id, email: `rollback-${id}@example.test` } });
      throw new Error('refused after write');
    })).rejects.toThrow('refused after write');
    expect(await db.user.findUnique({ where: { id } })).toBeNull();
    await expect(withIncludeHistoryTransaction(db, async (prepared) =>
      includeHistoryClient(prepared).user.count())).resolves.toBeGreaterThanOrEqual(0);
  });

  it('cancels only the waiting backend, never enters its callback, and permits later work', async () => {
    const holding = latch();
    const release = latch();
    const first = withIncludeHistoryTransaction(db, async () => {
      holding.resolve();
      await release.promise;
    });
    await holding.promise;
    const work = vi.fn(async () => undefined);
    const waiting = withIncludeHistoryTransaction(db, work);
    const outcome = waiting.then(() => null, (error: unknown) => error);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 2_000);
      const rows = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.datname = current_database() AND l.locktype = 'advisory'
          AND l.classid = 2063 AND l.objid = 1772 AND l.objsubid = 2 AND NOT l.granted`;
      expect(rows).toHaveLength(1);
      const [{ cancelled }] = await db.$queryRaw<Array<{ cancelled: boolean }>>`
        SELECT pg_cancel_backend(${rows[0].pid}::int) AS cancelled`;
      expect(cancelled).toBe(true);
      expect(await outcome).toBeInstanceOf(Error);
      expect(work).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([first, waiting]);
    }
    await expect(withIncludeHistoryTransaction(db, async () => 'next')).resolves.toBe('next');
  });

  it('bounds acquisition while another transaction continues holding the fence', async () => {
    const holding = latch();
    const release = latch();
    const first = withIncludeHistoryTransaction(db, async () => {
      holding.resolve();
      await release.promise;
    });
    await holding.promise;
    const work = vi.fn(async () => undefined);
    const waiting = withIncludeHistoryTransaction(db, work, { timeoutMs: 100 });
    const outcome = waiting.then(() => 'resolved', () => 'rejected');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        outcome,
        new Promise<string>((done) => { timer = setTimeout(() => done('still waiting'), 1_000); }),
      ]);
      expect(result).toBe('rejected');
      expect(work).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      release.resolve();
      await Promise.allSettled([first, waiting]);
    }
    await expect(withIncludeHistoryTransaction(db, async () => 'released')).resolves.toBe('released');
  });

  it('expires a bounded transaction without committing its writes or leaving a usable context', async () => {
    const id = generateId();
    let escaped!: IncludeHistoryTransaction;
    await expect(withIncludeHistoryTransaction(db, async (prepared) => {
      escaped = prepared;
      await includeHistoryClient(prepared).user.create({ data: { id, email: `timeout-${id}@example.test` } });
      await new Promise((done) => setTimeout(done, 250));
      expect(() => includeHistoryClient(prepared)).toThrow(/prepared include-history transaction/i);
    }, { timeoutMs: 100 })).rejects.toThrow(/expired|closed|timeout/i);
    expect(await db.user.findUnique({ where: { id } })).toBeNull();
    expect(() => includeHistoryClient(escaped)).toThrow(/prepared include-history transaction/i);
    await expect(withIncludeHistoryTransaction(db, async () => 'released')).resolves.toBe('released');
  });
});
