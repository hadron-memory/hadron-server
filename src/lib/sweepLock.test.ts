/**
 * #445 slice 1 — withSweepLock: duplicate suppression for a periodic sweep across
 * server processes, on a DEDICATED pg session (Prisma's pool cannot hold a session
 * advisory lock). The lock is NOT an exactly-once guarantee; these pins prove
 * exclusion, release on every exit, and that no pool connection is held.
 */
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { sweepLockKey, withSweepLock } from './sweepLock.js';
import { runAnonymousCleanupTick } from '../jobs/cleanupAnonymousMemories.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function grantedLocks(key: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND ((classid::bigint << 32) | objid::bigint) = ${key}::bigint`;
  return rows[0].n;
}

describe('withSweepLock (#445)', () => {
  it('skips while another session holds the name, and runs again after release', async () => {
    const name = 'test-two-session';
    const entered = deferred();
    const latch = deferred();
    const first = withSweepLock(name, async () => { entered.resolve(); await latch.promise; return 'a'; });
    await entered.promise;
    let secondRan = false;
    const second = await withSweepLock(name, async () => { secondRan = true; });
    expect(second).toEqual({ ran: false });
    expect(secondRan).toBe(false);
    // A different name is a different lock.
    expect(await withSweepLock('test-other-name', async () => 1)).toEqual({ ran: true, value: 1 });
    latch.resolve();
    expect(await first).toEqual({ ran: true, value: 'a' });
    expect(await withSweepLock(name, async () => 'c')).toEqual({ ran: true, value: 'c' });
  });

  it('keys by a source-constant name under its own namespace', () => {
    expect(sweepLockKey('x')).toMatch(/^-?\d+$/);
    expect(sweepLockKey('x')).toBe(sweepLockKey('x'));
    expect(sweepLockKey('x')).not.toBe(sweepLockKey('y'));
  });

  it('releases when fn throws, and the error propagates', async () => {
    const name = 'test-throw';
    await expect(withSweepLock(name, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await grantedLocks(sweepLockKey(name))).toBe(0);
    expect(await withSweepLock(name, async () => 'ok')).toEqual({ ran: true, value: 'ok' });
  });

  it('a lost session releases the lock: a later call acquires', async () => {
    const name = 'test-terminate';
    const entered = deferred();
    const latch = deferred();
    const key = sweepLockKey(name);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const first = withSweepLock(name, async () => { entered.resolve(); await latch.promise; });
      await entered.promise;
      const killer = new Client({ connectionString: process.env.DATABASE_URL });
      await killer.connect();
      try {
        await killer.query(
          `SELECT pg_terminate_backend(pid) FROM pg_locks
           WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
          [key],
        );
      } finally {
        await killer.end();
      }
      expect(await withSweepLock(name, async () => 'later')).toEqual({ ran: true, value: 'later' });
      latch.resolve();
      await first.catch(() => {});
    } finally {
      logged.mockRestore();
    }
  });

  it('excludes a real second process, with one granted advisory row while held and none after', async () => {
    const name = 'test-two-process';
    const dir = mkdtempSync(join(tmpdir(), 'sweeplock-'));
    const latchFile = join(dir, 'release');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/lib/sweepLock.child.fixture.ts', name, latchFile], {
      env: process.env, stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    const held = new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => { out += d.toString(); if (out.includes('held')) resolve(); });
      child.on('exit', () => reject(new Error('child exited before holding: ' + out)));
    });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    try {
      await held;
      expect(await grantedLocks(sweepLockKey(name))).toBe(1);
      expect(await withSweepLock(name, async () => 'never')).toEqual({ ran: false });
      writeFileSync(latchFile, '');
      await exited;
      expect(out).toContain('released');
      expect(await grantedLocks(sweepLockKey(name))).toBe(0);
      expect(await withSweepLock(name, async () => 'after')).toEqual({ ran: true, value: 'after' });
    } finally {
      child.kill();
    }
  }, 60_000);

  it('holds no Prisma pool connection: the anonymous cleanup runs inside it with connection_limit=1', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '5');
    const one = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const result = await withSweepLock('test-pool', async () => one.memory.count());
      expect(result.ran).toBe(true);
      expect(await runAnonymousCleanupTick(one)).toEqual({ ran: true, value: 0 });
    } finally {
      await one.$disconnect();
    }
  });

  it('skips this tick (no throw, fn never runs) when the lock session cannot connect', async () => {
    const real = process.env.DATABASE_URL;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none';
    try {
      let ran = false;
      expect(await withSweepLock('test-connect-fail', async () => { ran = true; })).toEqual({ ran: false });
      expect(ran).toBe(false);
      expect(logged).toHaveBeenCalled();
    } finally {
      process.env.DATABASE_URL = real;
      logged.mockRestore();
    }
  });
});

describe('anonymous cleanup tick (#445)', () => {
  it('two concurrent ticks issue the delete once', async () => {
    const latch = deferred();
    const entered = deferred();
    const deleteMany = vi.fn(async () => { entered.resolve(); await latch.promise; return { count: 0 }; });
    const fake = { memory: { deleteMany } } as unknown as PrismaClient;
    const first = runAnonymousCleanupTick(fake);
    await entered.promise;
    expect(await runAnonymousCleanupTick(fake)).toEqual({ ran: false });
    latch.resolve();
    expect((await first).ran).toBe(true);
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
});
