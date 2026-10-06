/** #1189: fixture deletion must not overlap the recorder's batched FK writes. */
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/index.js';
import { cleanDb } from '../test/helpers.js';
import { drainNodeUsage, recordNodeUsage, trackUsageWrite } from './usageRecorder.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function client(
  insert: (data: unknown[]) => Promise<unknown>,
  deleted: string[] = [],
) {
  return new Proxy(
    {
      usageEvent: {
        createMany: ({ data }: { data: unknown[] }) => insert(data),
        deleteMany: async () => {
          deleted.push('usageEvent');
        },
      },
    },
    {
      get(target, name) {
        if (name === 'usageEvent') return target.usageEvent;
        return {
          deleteMany: async () => {
            deleted.push(String(name));
          },
        };
      },
    },
  ) as unknown as PrismaClient;
}

const node = { id: 'fixture-node', loc: 'note', memoryId: 'fixture-memory' };

describe('operation usage lifecycle', () => {
  it('keeps recording fire-and-forget but blocks real cleanDb until every chunk completes', async () => {
    const entered = deferred();
    const release = deferred();
    const deleted: string[] = [];
    const sizes: number[] = [];
    let overlapped = false;
    const db = client(async (data) => {
      sizes.push(data.length);
      entered.resolve();
      await release.promise;
      // Every chunk must finish before even the first parent delete.
      overlapped ||= deleted.length > 0;
    }, deleted);
    expect(
      recordNodeUsage(
        db,
        'read',
        Array.from({ length: 1001 }, () => node),
        {},
      ),
    ).toBeUndefined();
    await entered.promise;
    const cleanup = cleanDb(db);
    await Promise.resolve();
    expect(deleted).toEqual([]);
    release.resolve();
    await cleanup;
    expect(sizes).toEqual([500, 500, 1]);
    expect(overlapped).toBe(false);
    expect(deleted).toContain('node');
    expect(deleted.at(-1)).toBe('usageEvent');
  });

  it('drains writes added during a drain while keeping unrelated clients independent', async () => {
    const first = deferred(),
      second = deferred();
    const enteredFirst = deferred(),
      enteredSecond = deferred();
    let calls = 0;
    const db = client(async () => {
      if (++calls === 1) {
        enteredFirst.resolve();
        await first.promise;
      } else {
        enteredSecond.resolve();
        await second.promise;
      }
    });
    recordNodeUsage(db, 'write', node, {});
    await enteredFirst.promise;
    let drained = false;
    const draining = drainNodeUsage(db).then(() => {
      drained = true;
    });
    recordNodeUsage(db, 'read', node, {});
    await enteredSecond.promise;
    await cleanDb(client(async () => {}));
    expect(drained).toBe(false);
    first.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    second.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('names a hung usage writer and leaves fixture deletion to wait rather than proceeding', async () => {
    vi.useFakeTimers();
    const held = deferred();
    const db = {};
    try {
      trackUsageWrite(db, held.promise);
      const timed = expect(drainNodeUsage(db, { timeoutMs: 25 })).rejects.toThrow(
        'Timed out draining asynchronous usage-event writes after 25ms (1 pending)',
      );
      await vi.advanceTimersByTimeAsync(25);
      await timed;
      held.resolve();
      await drainNodeUsage(db);
    } finally {
      held.resolve();
      vi.useRealTimers();
    }
  });

  it('settles rejected inserts and still attempts later chunks before cleanup', async () => {
    let calls = 0;
    const db = client(async () => {
      ++calls;
      throw new Error('metering unavailable');
    });
    expect(() =>
      recordNodeUsage(
        db,
        'read',
        Array.from({ length: 501 }, () => node),
        {},
      ),
    ).not.toThrow();
    await cleanDb(db);
    expect(calls).toBe(2);
    await drainNodeUsage(db); // settled failures leave no pending lifecycle
  });
});
