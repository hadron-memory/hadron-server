/**
 * #4719 SEC10 F1 (Rook): the sync-run lock's dedicated connection must survive its backend going away mid-sync. Without
 * an 'error' listener, pg's idle-connection error is an unhandled EventEmitter error that exits the server process.
 * With one, a lost lock connection only logs, the lock is gone (Postgres freed it with the backend), and the release
 * still resolves.
 */
import { describe, expect, it, vi } from 'vitest';
import { db } from '../db/client.js';
import { acquireSyncRunLock, syncRunLockKey } from './syncRunLock.js';

const holderPid = async (memoryId: string): Promise<number | undefined> =>
  (await db.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_locks WHERE locktype = 'advisory'
    AND objid = (hashtext(${syncRunLockKey(memoryId)}) & x'ffffffff'::bigint)::oid`)[0]?.pid;

describe('#3571 the sync-run lock connection', () => {
  it('a backend terminated mid-hold is logged, not fatal, and the release still resolves', async () => {
    const memoryId = `lock-${Date.now()}`;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUncaught = (e: unknown) => { unhandled.push(e); };
    process.on('uncaughtException', onUncaught);
    try {
      const release = await acquireSyncRunLock(memoryId);
      const pid = await holderPid(memoryId);
      expect(pid).toBeDefined();
      await db.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(release()).resolves.toBeUndefined();
      expect(unhandled).toEqual([]);
      expect(errors).toHaveBeenCalledWith('[git-sync] sync-run lock connection lost', { code: expect.any(String) });
      // The lock went with the backend: nothing holds the key any more.
      expect(await holderPid(memoryId)).toBeUndefined();
    } finally {
      process.off('uncaughtException', onUncaught);
      errors.mockRestore();
    }
  });

  it('refuses without DATABASE_URL instead of falling back to PG* variables or localhost (#4719 BLIND F2)', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(acquireSyncRunLock('no-url')).rejects.toThrow(/DATABASE_URL is not set/);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
