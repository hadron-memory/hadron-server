/**
 * #445 slice 1 — withSweepLock: duplicate suppression for a periodic sweep across
 * server processes, on a DEDICATED pg session (Prisma's pool cannot hold a session
 * advisory lock). The lock is NOT an exactly-once guarantee; these pins prove
 * exclusion, release on every exit, and that no pool connection is held.
 */
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
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

/**
 * Granted advisory rows for `key` in THIS test's database only. `pg_locks` spans the
 * cluster while an advisory lock is database-local, so without the database and
 * `objsubid = 1` (the bigint form) boundary a concurrent worker on another test
 * database holding the same name would be counted, or terminated.
 */
async function grantedHolders(key: string): Promise<number[]> {
  const rows = await db.$queryRaw<{ pid: number }[]>`
    SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND objsubid = 1
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND ((classid::bigint << 32) | objid::bigint) = ${key}::bigint`;
  return rows.map((r) => r.pid);
}
const grantedLocks = async (key: string) => (await grantedHolders(key)).length;

/** A server that accepts TCP and never answers (`silent`), or finishes the pg handshake and then ignores every query. */
async function stalledServer(mode: 'silent' | 'ignore-queries'): Promise<{ url: string; server: Server; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    if (mode === 'silent') return;
    let started = false;
    socket.on('data', () => {
      if (started) return;
      started = true;
      // AuthenticationOk, then ReadyForQuery (idle); every later message is dropped on the floor.
      socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  return { url: `postgresql://u@127.0.0.1:${port}/d`, server, sockets };
}

describe('withSweepLock (#445)', () => {
  it('skips while another session holds the name, and runs again after release', async () => {
    const name = 'test-two-session';
    const entered = deferred();
    const latch = deferred();
    const first = withSweepLock(name, async () => { entered.resolve(); await latch.promise; return 'a'; });
    try {
      await entered.promise;
      let secondRan = false;
      const second = await withSweepLock(name, async () => { secondRan = true; });
      expect(second).toEqual({ ran: false });
      expect(secondRan).toBe(false);
      // A different name is a different lock.
      expect(await withSweepLock('test-other-name', async () => 1)).toEqual({ ran: true, value: 1 });
    } finally {
      latch.resolve();
    }
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
    const first = withSweepLock(name, async () => { entered.resolve(); await latch.promise; });
    try {
      await entered.promise;
      // Terminate exactly the backend this test saw holding the lock in its own database, by PID.
      const holders = await grantedHolders(key);
      expect(holders).toHaveLength(1);
      await db.$queryRaw`SELECT pg_terminate_backend(${holders[0]}::int)`;
      expect(await withSweepLock(name, async () => 'later')).toEqual({ ran: true, value: 'later' });
    } finally {
      latch.resolve();
      await first.catch(() => {});
      logged.mockRestore();
    }
  });

  it('counts only this database: the same name held in another database is neither counted nor a candidate to terminate', async () => {
    const key = sweepLockKey('test-other-database');
    const other = `hadron_sweeplock445_${process.pid}_${Date.now()}`;
    await db.$executeRawUnsafe(`CREATE DATABASE "${other}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${other}`;
    const foreign = new Client({ connectionString: url.toString() });
    try {
      await foreign.connect();
      await foreign.query('SELECT pg_advisory_lock($1::bigint)', [key]);
      const [{ n }] = (await foreign.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`, [key])).rows;
      expect(n).toBe(1); // the cluster-wide view DOES see it, so the scoping below is what excludes it
      expect(await grantedHolders(key)).toEqual([]);
    } finally {
      await foreign.end().catch(() => {});
      await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${other}" WITH (FORCE)`);
    }
  }, 60_000);

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

  it('skips this tick, and returns, when the connection stalls with no answer (bounded connect)', async () => {
    const stalled = await stalledServer('silent');
    const real = process.env.DATABASE_URL;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DATABASE_URL = stalled.url;
    try {
      let ran = false;
      const started = Date.now();
      expect(await withSweepLock('test-stalled-connect', async () => { ran = true; }, { acquireTimeoutMs: 300 })).toEqual({ ran: false });
      expect(ran).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(logged).toHaveBeenCalled();
    } finally {
      process.env.DATABASE_URL = real;
      logged.mockRestore();
      stalled.sockets.forEach((s) => s.destroy());
      stalled.server.close();
    }
  }, 15_000);

  it('skips this tick, and returns, when the lock query is never answered (bounded acquisition query)', async () => {
    const stalled = await stalledServer('ignore-queries');
    const real = process.env.DATABASE_URL;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DATABASE_URL = stalled.url;
    try {
      let ran = false;
      const started = Date.now();
      expect(await withSweepLock('test-stalled-query', async () => { ran = true; }, { acquireTimeoutMs: 300 })).toEqual({ ran: false });
      expect(ran).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.env.DATABASE_URL = real;
      logged.mockRestore();
      stalled.sockets.forEach((s) => s.destroy());
      stalled.server.close();
    }
  }, 15_000);
});

describe('anonymous cleanup tick (#445)', () => {
  it('two concurrent ticks issue the delete once', async () => {
    const latch = deferred();
    const entered = deferred();
    const deleteMany = vi.fn(async () => { entered.resolve(); await latch.promise; return { count: 0 }; });
    const fake = { memory: { deleteMany } } as unknown as PrismaClient;
    const first = runAnonymousCleanupTick(fake);
    try {
      await entered.promise;
      expect(await runAnonymousCleanupTick(fake)).toEqual({ ran: false });
    } finally {
      latch.resolve();
    }
    expect((await first).ran).toBe(true);
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
});
