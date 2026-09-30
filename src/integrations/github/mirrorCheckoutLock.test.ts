import { describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { generateId } from '../../lib/id.js';
import { db } from '../db/client.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { mirrorCheckoutLockKey, withMirrorCheckoutLock } from './mirrorCheckoutLock.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Git mirror checkout lock', () => {
  it('queues same-process work before opening a second PostgreSQL session', async () => {
    const memoryId = generateId();
    const connect = vi.spyOn(Client.prototype, 'connect');
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;
    try {
      const first = withMirrorCheckoutLock(memoryId, async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      });
      await firstEntered.promise;
      const connectionsAtFirst = connect.mock.calls.length;
      const second = withMirrorCheckoutLock(memoryId, async () => {
        secondEntered = true;
      });
      // The second call has entered the local queue synchronously, but it must
      // leave PostgreSQL connection capacity untouched until the first exits.
      await Promise.resolve();
      expect(connect.mock.calls.length).toBe(connectionsAtFirst);
      expect(secondEntered).toBe(false);
      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(secondEntered).toBe(true);
      expect(connect.mock.calls.length).toBe(connectionsAtFirst + 1);
    } finally {
      releaseFirst.resolve();
      connect.mockRestore();
    }
  });

  it('waits for a lock held by another PostgreSQL session', async () => {
    const memoryId = generateId();
    const external = new Client({ connectionString: process.env.DATABASE_URL });
    await external.connect();
    const key = mirrorCheckoutLockKey(memoryId);
    try {
      await external.query('SELECT pg_advisory_lock($1::bigint)', [key]);
      let entered = false;
      const waiting = withMirrorCheckoutLock(memoryId, async () => { entered = true; });
      await waitForLockWaitersOfType(db, 'advisory');
      expect(entered).toBe(false);
      await external.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
      await waiting;
      expect(entered).toBe(true);
    } finally {
      await external.end();
    }
  });

  it('releases the lock when the checkout throws', async () => {
    const memoryId = generateId();
    await expect(withMirrorCheckoutLock(memoryId, async () => {
      throw new Error('git failed');
    })).rejects.toThrow('git failed');
    await expect(withMirrorCheckoutLock(memoryId, async () => 'next')).resolves.toBe('next');
  });
});
