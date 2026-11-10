/**
 * #2314 — the whoami snapshot contract. Rows, total and the App/worker resolution share ONE repeatable-read
 * transaction (server.ts, #1133/#1598). Kept in its own file because the `vi.mock` below is file-wide.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const seen = vi.hoisted(() => ({ isolation: [] as string[] }));

// Pass-through wrapper: runs the real filter, and records the isolation level of the client it was handed.
vi.mock('./whoamiSessionFilter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./whoamiSessionFilter.js')>();
  return {
    ...real,
    whoamiSessionFilter: async (tx: Parameters<typeof real.whoamiSessionFilter>[0], ...rest: unknown[]) => {
      const rows = await tx.$queryRaw<Array<{ isolation: string }>>`SELECT current_setting('transaction_isolation') AS isolation`;
      seen.isolation.push(rows[0].isolation);
      return (real.whoamiSessionFilter as (...a: unknown[]) => ReturnType<typeof real.whoamiSessionFilter>)(tx, ...rest);
    },
  };
});

let user: { id: string };

function auth(): AuthContext {
  return { userId: user.id, roles: ['READER'], clientId: `user:${user.id}` };
}

beforeEach(async () => {
  await cleanDb(db);
  seen.isolation.length = 0;
  user = await db.user.create({ data: { id: generateId(), handle: 'snap-user', roles: ['READER'] } });
  await db.session.create({ data: { id: generateId(), userId: user.id, type: 'DEVELOPER', startedAt: new Date() } });
});

describe('hadron_whoami — snapshot contract (#2314)', () => {
  it('opens a callback transaction at RepeatableRead', async () => {
    const spy = vi.spyOn(db, '$transaction');
    try {
      await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
      expect(spy).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
    } finally {
      spy.mockRestore();
    }
  });

  it('hands the selection filter the repeatable-read transaction client, not the pool', async () => {
    await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
    expect(seen.isolation).toEqual(['repeatable read']);
  });

  it('reads the session rows and the total on that same transaction client', async () => {
    const calls: string[] = [];
    const original = db.$transaction.bind(db) as (fn: (tx: unknown) => unknown, opts?: unknown) => Promise<unknown>;
    // Record the session reads made through the transaction client; a read that bypasses it (the pool) records nothing.
    const record = (tx: Record<string, unknown>) =>
      new Proxy(tx, {
        get(target, prop) {
          const value = target[prop as string];
          if (prop === 'session') {
            return new Proxy(value as Record<string, unknown>, {
              get(model, op) {
                const fn = model[op as string];
                if ((op === 'findMany' || op === 'count') && typeof fn === 'function') {
                  return (...args: unknown[]) => { calls.push(String(op)); return (fn as (...a: unknown[]) => unknown).apply(model, args); };
                }
                return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(model) : fn;
              },
            });
          }
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    const spy = vi.spyOn(db, '$transaction').mockImplementation(
      ((fn: (tx: unknown) => unknown, opts?: unknown) => original((tx) => fn(record(tx as Record<string, unknown>)), opts)) as never,
    );
    try {
      const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
      expect(out).toContain('1 session(s):');
    } finally {
      spy.mockRestore();
    }
    expect(calls.sort()).toEqual(['count', 'findMany']);
  });
});
