/**
 * #556 — a graph sync is single-flight, whichever caller starts it.
 *
 * The guard first lived in the `/reload` handler, which covered reloads and
 * nothing else. `src/index.ts` calls `startup()` directly at boot, so a CI
 * trigger arriving during the initial sync — the likeliest moment for one,
 * immediately after a deploy — saw a false flag and started a second sync over
 * the same git checkouts (@codex, PR #1250).
 *
 * **A guard that knows about one of an operation's two callers is not a guard
 * on the operation.** So it moved onto the operation, and these cases exercise
 * it directly rather than through a route — because the route is exactly the
 * caller it already covered.
 *
 * PER PROCESS, deliberately and insufficiently: two workers each hold their own
 * flag. The container runs one node process today, which makes this sufficient
 * rather than correct, and the docstring in startup.ts says so.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findManyMock = vi.hoisted(() => vi.fn());
const syncMock = vi.hoisted(() => vi.fn());

vi.mock('../integrations/db/client.js', () => ({
  db: { memory: { findMany: findManyMock } },
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: syncMock,
}));

const { startup, isSyncInFlight } = await import('./startup.js');

const MEMORY = {
  id: 'm1',
  name: 'mem',
  source: 'https://github.com/acme/repo',
  organization: { urn: 'acme' },
};

beforeEach(() => {
  findManyMock.mockReset();
  syncMock.mockReset();
  findManyMock.mockResolvedValue([MEMORY]);
  syncMock.mockResolvedValue({ nodeCount: 1 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#556 — startup() is single-flight', () => {
  it('skips a second sync while the first is running', async () => {
    let release!: () => void;
    // Resolve with a real result shape — the loop reads `result.error`, so a
    // bare `undefined` throws inside the operation and the test would fail for
    // the wrong reason.
    syncMock.mockImplementation(
      () => new Promise((r) => { release = () => r({ nodeCount: 1 }); }),
    );

    const first = startup();
    await new Promise((r) => setTimeout(r, 20));
    expect(isSyncInFlight(), 'the first sync holds the flag').toBe(true);

    // This is the boot-vs-reload collision, reproduced at the operation.
    expect(await startup()).toBe('skipped');

    // The assertion that makes this about SYNCS rather than return values: a
    // 'skipped' that still walked the memories would have raced anyway.
    expect(syncMock, 'the second call did no work').toHaveBeenCalledTimes(1);

    release();
    expect(await first).toBe('ran');
  });

  it('releases the flag once the sync finishes', async () => {
    expect(await startup()).toBe('ran');
    expect(isSyncInFlight()).toBe(false);
    // A second sync afterwards is fine — single-flight, not once-ever.
    expect(await startup()).toBe('ran');
    expect(syncMock).toHaveBeenCalledTimes(2);
  });

  it('releases the flag when the sync THROWS', async () => {
    // The `finally` half. Without it one failure wedges every future sync
    // until the process restarts — invisible until the day a sync throws,
    // and then permanent.
    findManyMock.mockRejectedValueOnce(new Error('db down'));
    await expect(startup()).rejects.toThrow('db down');
    expect(isSyncInFlight(), 'the flag must not be stuck').toBe(false);
    expect(await startup()).toBe('ran');
  });

  it('releases the flag on the disabled-by-env early return', async () => {
    // An early return is the classic way a flag leaks: the happy path clears
    // it, the short-circuit does not.
    process.env.DISABLE_STARTUP_SYNC = 'true';
    try {
      expect(await startup()).toBe('ran');
      expect(isSyncInFlight()).toBe(false);
    } finally {
      delete process.env.DISABLE_STARTUP_SYNC;
    }
  });

  it('releases the flag on the no-memories early return', async () => {
    findManyMock.mockResolvedValue([]);
    expect(await startup()).toBe('ran');
    expect(isSyncInFlight()).toBe(false);
  });
});
