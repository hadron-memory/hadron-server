/**
 * #3571 (ruling 0223, cor:int:010:01): a row the pre-#3568 no-installation path left at SYNCING, with no source or no
 * installation and no sync running, becomes PENDING and nothing else. A sync actually in flight, and every other row,
 * are untouched. "No sync running" is proven by the sync-run lock every attempt holds (shared) from before its SYNCING
 * stamp until its final status write; the reconciliation takes it exclusively with try, per row, so a running sync makes
 * it skip the row rather than wait or overwrite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { execGit } from './execGit.js';
import { syncGraphFromGithub } from './syncGraphFromGithub.js';
import { reconcileSyncingStatus } from './reconcileSyncing.js';
import { acquireSyncRunLock, syncRunLockKey } from './syncRunLock.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../config.js')>(),
  get GRAPHS_PATH() { return paths.root; },
}));
vi.mock('./gitBranch.js', () => ({ prepareWriteBranch: vi.fn(async () => {}) }));
vi.mock('./execGit.js', async importOriginal => ({ ...await importOriginal<typeof import('./execGit.js')>(), execGit: vi.fn() }));
vi.mock('./githubApp.js', () => ({ getInstallationToken: vi.fn(async () => 'fixture-token'), toHttpsUrl: (source: string) => source }));

let n = 0;
async function org(installed: boolean) {
  n += 1;
  return db.organization.create({ data: { name: `rs${n}`, urn: `rs${n}.test`, ...(installed ? { githubInstallationId: 1000 + n } : {}) } });
}
async function memory(over: { organizationId?: string | null; source?: string | null; syncStatus?: 'SYNCING' | 'PENDING' | 'OK' | 'ERROR';
  isEncrypted?: boolean; deleted?: boolean } = {}) {
  n += 1;
  // A memory is owned by an organization or by a user (chk_memory_owner_xor).
  const owner = over.organizationId ? null : (await db.user.create({ data: { handle: `rs-owner-${n}`, roles: ['READER'] } })).id;
  const m = await db.memory.create({ data: {
    organizationId: over.organizationId ?? null, ownerUserId: owner, class: 'knowledge', name: `m${n}`, urn: `rs.test:m${n}`,
    source: over.source === undefined ? null : over.source, syncStatus: over.syncStatus ?? 'SYNCING',
    // History a reconciliation must keep exactly (ruling 0223).
    syncError: 'earlier error', lastSyncedAt: new Date('2026-01-02T03:04:05.678Z'),
    lastSyncReport: JSON.stringify({ v: 1, outcome: 'partial', entries: [] }),
    ...(over.isEncrypted ? { isEncrypted: true } : {}),
    ...(over.deleted ? { deletedAt: new Date('2026-02-03T00:00:00Z'), deletedBy: 'test' } : {}),
  } });
  return m.id;
}
/** The whole stored row, as the database holds it (updated_at included), so "nothing else" is checked byte for byte. */
async function row(id: string): Promise<Record<string, unknown>> {
  return (await db.$queryRaw<Array<{ r: Record<string, unknown> }>>`SELECT to_jsonb(m) AS r FROM memories m WHERE m.id = ${id}`)[0].r;
}
/** Sessions holding or waiting on the memory's sync-run advisory lock right now (the key is syncRunLockKey's, never a copy of its prefix). */
const runLockHolders = async (memoryId: string): Promise<number> => Number((await db.$queryRaw<Array<{ n: bigint }>>`
  SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'
    AND objid = (hashtext(${syncRunLockKey(memoryId)}) & x'ffffffff'::bigint)::oid`)[0].n);
/** Poll until a condition holds or the deadline passes (no fixed sleeps). */
async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached before the deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const without = (r: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== k));

beforeEach(async () => {
  await cleanDb(db);
  paths.root = mkdtempSync(join(tmpdir(), 'rs3571-'));
  vi.mocked(execGit).mockReset();
  vi.mocked(execGit).mockImplementation(async () => ({ stdout: '', stderr: '' }));
});
afterEach(() => rmSync(paths.root, { recursive: true, force: true }));

describe('#3571 an abandoned SYNCING row becomes PENDING and nothing else', () => {
  it.each([
    ['no source', async () => memory({ organizationId: (await org(true)).id, source: null })],
    ['an organization with no installation', async () => memory({ organizationId: (await org(false)).id, source: 'https://github.com/x/y' })],
  ])('reconciles a row with %s, changing only sync_status', async (_label, make) => {
    const id = await make();
    const before = await row(id);
    const out = await reconcileSyncingStatus(db, { apply: true });
    expect(out).toMatchObject({ reconciled: 1 });
    const after = await row(id);
    expect(after.sync_status).toBe('PENDING');
    expect(without(after, 'sync_status')).toEqual(without(before, 'sync_status'));
  });

  it('a repeat apply is a no-op', async () => {
    const id = await memory({ organizationId: (await org(false)).id, source: 'https://github.com/x/y' });
    await reconcileSyncingStatus(db, { apply: true });
    const once = await row(id);
    expect(await reconcileSyncingStatus(db, { apply: true })).toMatchObject({ candidates: 0, reconciled: 0 });
    expect(await row(id)).toEqual(once);
  });

  it('a dry run counts and writes nothing', async () => {
    const id = await memory({ organizationId: (await org(false)).id, source: 'https://github.com/x/y' });
    const before = await row(id);
    expect(await reconcileSyncingStatus(db, { apply: false })).toMatchObject({ candidates: 1, reconciled: 0 });
    expect(await row(id)).toEqual(before);
  });

  it('leaves encrypted, deleted, configured and non-SYNCING rows untouched, and reports the uncovered one', async () => {
    const noInstall = (await org(false)).id;
    const installed = (await org(true)).id;
    const ids = [
      await memory({ organizationId: noInstall, source: 'https://github.com/x/y', isEncrypted: true }),
      await memory({ organizationId: noInstall, source: 'https://github.com/x/y', deleted: true }),
      await memory({ organizationId: installed, source: 'https://github.com/x/y' }), // configured: a sync may be stuck, not ours
      await memory({ organizationId: noInstall, source: 'https://github.com/x/y', syncStatus: 'ERROR' }),
      await memory({ organizationId: null, source: 'https://github.com/x/y' }), // user-owned with a source: not ruled
    ];
    const before = await Promise.all(ids.map(row));
    const out = await reconcileSyncingStatus(db, { apply: true });
    expect(out).toMatchObject({ candidates: 0, reconciled: 0, uncovered: 1 });
    expect(await Promise.all(ids.map(row))).toEqual(before);
  });

  it('re-checks under the lock: a candidate whose configuration changed is skipped, not reconciled', async () => {
    const o = await org(false);
    const id = await memory({ organizationId: o.id, source: 'https://github.com/x/y' });
    const before = await row(id);
    const out = await reconcileSyncingStatus(db, {
      apply: true,
      // Between the candidate scan and the locked re-check, the organization gains an installation.
      onCandidates: async () => { await db.organization.update({ where: { id: o.id }, data: { githubInstallationId: 4242 } }); },
    });
    expect(out).toMatchObject({ candidates: 1, reconciled: 0, ineligible: 1 });
    expect(await row(id)).toEqual(before);
  });
});

describe('#3571 a sync actually in flight is never overwritten', () => {
  it('a real sync, held mid-attempt after its SYNCING stamp, keeps its row while the reconciliation runs', async () => {
    const o = await org(true);
    const id = await memory({ organizationId: o.id, source: 'https://github.com/x/y', syncStatus: 'PENDING' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const inGit = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(execGit).mockImplementation(async () => { started(); await gate; throw new Error('git unavailable (fixture)'); });

    const graph = await db.memory.findUniqueOrThrow({ where: { id }, include: { organization: true } });
    const running = syncGraphFromGithub(graph);
    await inGit; // the attempt has stamped SYNCING and is inside its git step
    expect((await row(id)).sync_status).toBe('SYNCING');

    // The installation goes away mid-attempt, so the row now LOOKS like an abandoned no-installation row.
    await db.organization.update({ where: { id: o.id }, data: { githubInstallationId: null } });
    const during = await row(id);
    const out = await reconcileSyncingStatus(db, { apply: true });
    expect(out).toMatchObject({ candidates: 1, reconciled: 0, held: 1 });
    expect(await row(id)).toEqual(during);

    release();
    await running;
    // The attempt finishes as its own: the reconciliation never wrote PENDING over it.
    expect((await row(id)).sync_status).toBe('ERROR');
    // And it let go of the run lock: a reconciliation now sees no running sync.
    expect(await runLockHolders(id)).toBe(0); // #4731: the key comes from syncRunLockKey, not a hard-coded prefix
  }, 30_000);
});

describe('#3571 the not-attempted refusal stays write-free', () => {
  it('a NO_INSTALLATION sync of a SYNCING row writes nothing and takes no run lock', async () => {
    const id = await memory({ organizationId: (await org(false)).id, source: 'https://github.com/x/y' });
    const before = await row(id);
    const graph = await db.memory.findUniqueOrThrow({ where: { id }, include: { organization: true } });
    expect(await syncGraphFromGithub(graph)).toMatchObject({ notAttemptedReason: 'NO_INSTALLATION' });
    expect(await row(id)).toEqual(before);
    expect(await runLockHolders(id)).toBe(0); // #4731: no run lock was taken (and none is left)
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// #4731 (polish deferred from #4719): per-row failure, bounded waits, the re-check's predicates, shared versus exclusive, the
// protocol legs the first pins left open, and a lock failure that names no host.
// ---------------------------------------------------------------------------------------------------------------------

/** Hold the row's exclusive run-lock key (what a running reconciliation holds) until released. */
async function holdExclusive(id: string): Promise<{ release: () => void; done: Promise<unknown> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const isHeld = new Promise<void>((resolve) => { held = resolve; });
  const done = db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${syncRunLockKey(id)}))`;
    held();
    await gate;
  }, { timeout: 60_000 });
  await isHeld;
  return { release, done };
}

describe('#4731 one bad row never aborts the run', () => {
  it('a failing row is counted and left unchanged while the others are reconciled; the log names a code, never a host or id', async () => {
    const o = await org(true);
    const ids = [await memory({ organizationId: o.id }), await memory({ organizationId: o.id }), await memory({ organizationId: o.id })].sort();
    const before = await row(ids[1]);
    const real = db.$transaction.bind(db);
    let calls = 0;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((fn: unknown, opts: unknown) => {
      calls += 1;
      if (calls === 2) return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 10.9.8.7:5432'), { code: '57P01' }));
      return (real as (f: unknown, o: unknown) => Promise<unknown>)(fn, opts);
    }) as never);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await reconcileSyncingStatus(db, { apply: true });
      expect(out).toMatchObject({ candidates: 3, reconciled: 2, failed: 1, held: 0, ineligible: 0 });
      expect(logged).toHaveBeenCalledWith('[reconcile-syncing] a row failed and was left unchanged', { code: '57P01', errorClass: 'Error' });
      expect(JSON.stringify(logged.mock.calls)).not.toContain('10.9.8.7');
    } finally { spy.mockRestore(); logged.mockRestore(); }
    expect(await row(ids[1])).toEqual(before); // the failed row is exactly as it was
    expect((await row(ids[0])).sync_status).toBe('PENDING');
    expect((await row(ids[2])).sync_status).toBe('PENDING');
    // Re-running finishes it: nothing was lost.
    expect(await reconcileSyncingStatus(db, { apply: true })).toMatchObject({ candidates: 1, reconciled: 1, failed: 0 });
  });
});

describe('#4731 a row transaction bounds its own lock wait', () => {
  it('a row lock held by a slow writer makes that row fail after the timeout (the FOR UPDATE re-check), without hanging the run or touching the row', async () => {
    const o = await org(true);
    const blocked = await memory({ organizationId: o.id });
    const free = await memory({ organizationId: o.id });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    // A slow writer on the blocked row holding the WEAKEST row lock (FOR KEY SHARE, what a foreign-key insert takes): it conflicts
    // with the reconciliation's FOR UPDATE re-check but not with its non-key UPDATE, so only that clause makes this row wait.
    const writer = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${blocked} FOR KEY SHARE`;
      locked();
      await gate;
    }, { timeout: 60_000 });
    await isLocked;
    const before = await row(blocked);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = Date.now();
    try {
      // Raced against a deadline: without the row's lock_timeout the run would wait on the writer forever, and a regression must
      // FAIL here (the finally below then frees the writer) rather than hang the suite behind a held lock.
      const out = await Promise.race([
        reconcileSyncingStatus(db, { apply: true, lockTimeoutMs: 300 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the reconciliation waited on the row lock past the deadline')), 8_000)),
      ]);
      expect(out).toMatchObject({ candidates: 2, reconciled: 1, failed: 1 });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(logged).toHaveBeenCalledWith('[reconcile-syncing] a row failed and was left unchanged', { code: expect.any(String), errorClass: expect.any(String) });
    } finally { logged.mockRestore(); release(); await writer; }
    expect(await row(blocked)).toEqual(before);
    expect((await row(free)).sync_status).toBe('PENDING');
  }, 30_000);

  it('a lock timeout that is not a positive integer falls back to the default, never to "no timeout"', async () => {
    const o = await org(true);
    await memory({ organizationId: o.id });
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      await db.memory.updateMany({ data: { syncStatus: 'SYNCING' } });
      expect(await reconcileSyncingStatus(db, { apply: true, lockTimeoutMs: bad })).toMatchObject({ reconciled: 1, failed: 0 });
    }
  });
});

describe('#4731 the locked re-check judges every predicate, not only the installation', () => {
  it.each([
    ['the memory gained a source and its organization an installation', (id: string, orgId: string) => Promise.all([
      db.memory.update({ where: { id }, data: { source: 'https://github.com/x/y' } }),
      db.organization.update({ where: { id: orgId }, data: { githubInstallationId: 77_001 } })])],
    ['the memory was deleted', (id: string) => db.memory.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: 'test' } })],
    ['the memory became encrypted', (id: string) => db.memory.update({ where: { id }, data: { isEncrypted: true } })],
    ['the memory is no longer SYNCING', (id: string) => db.memory.update({ where: { id }, data: { syncStatus: 'OK' } })],
  ])('skips as ineligible when %s between the scan and the lock', async (_label, change) => {
    const o = await org(false);
    const id = await memory({ organizationId: o.id, source: 'https://github.com/x/y' });
    const out = await reconcileSyncingStatus(db, { apply: true, onCandidates: async () => { await change(id, o.id); } });
    expect(out).toMatchObject({ candidates: 1, reconciled: 0, ineligible: 1 });
    expect((await row(id)).sync_status).not.toBe('PENDING');
  });
});

describe('#4731 shared (sync) versus exclusive (reconcile)', () => {
  it('two syncs hold the key together, neither waiting on the other, and a reconciliation skips while either holds it', async () => {
    const o = await org(false);
    const id = await memory({ organizationId: o.id, source: 'https://github.com/x/y' });
    const first = await acquireSyncRunLock(id);
    const second = await Promise.race([
      acquireSyncRunLock(id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the second shared holder waited on the first')), 5000)),
    ]);
    try {
      expect(await runLockHolders(id)).toBe(2);
      expect(await reconcileSyncingStatus(db, { apply: true })).toMatchObject({ candidates: 1, reconciled: 0, held: 1 });
      await first();
      expect(await reconcileSyncingStatus(db, { apply: true })).toMatchObject({ reconciled: 0, held: 1 }); // the second still holds it
    } finally { await first(); await second(); }
    expect(await reconcileSyncingStatus(db, { apply: true })).toMatchObject({ candidates: 1, reconciled: 1, held: 0 });
  });

  it('a reconciliation that finds another working the same row skips it as held, and does not wait', async () => {
    const o = await org(false);
    const id = await memory({ organizationId: o.id, source: 'https://github.com/x/y' });
    const other = await holdExclusive(id);
    try {
      const started = Date.now();
      expect(await reconcileSyncingStatus(db, { apply: true })).toMatchObject({ candidates: 1, reconciled: 0, held: 1 });
      expect(Date.now() - started).toBeLessThan(5000);
      expect((await row(id)).sync_status).toBe('SYNCING');
    } finally { other.release(); await other.done; }
  });

  it('a sync that starts while a reconciliation holds the key waits, then stamps SYNCING and carries on', async () => {
    const o = await org(true);
    const id = await memory({ organizationId: o.id, source: 'https://github.com/x/y', syncStatus: 'PENDING' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inGit = false;
    vi.mocked(execGit).mockImplementation(async () => { inGit = true; await gate; throw new Error('git unavailable (fixture)'); });
    const holder = await holdExclusive(id);
    const graph = await db.memory.findUniqueOrThrow({ where: { id }, include: { organization: true } });
    const running = syncGraphFromGithub(graph);
    await until(async () => (await runLockHolders(id)) === 2); // the sync is queued behind the exclusive holder
    expect(inGit).toBe(false);
    expect((await row(id)).sync_status).toBe('PENDING'); // it has not stamped SYNCING
    holder.release();
    await holder.done;
    await until(async () => (await row(id)).sync_status === 'SYNCING' && inGit);
    release();
    await running;
    expect((await row(id)).sync_status).toBe('ERROR'); // its own final write, after the wait
    expect(await runLockHolders(id)).toBe(0);
  }, 30_000);

  it('two concurrent syncs of one memory both run (they share the key), and both let go of it', async () => {
    const o = await org(true);
    const id = await memory({ organizationId: o.id, source: 'https://github.com/x/y', syncStatus: 'PENDING' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inGit = 0;
    vi.mocked(execGit).mockImplementation(async () => { inGit += 1; await gate; throw new Error('git unavailable (fixture)'); });
    const graph = await db.memory.findUniqueOrThrow({ where: { id }, include: { organization: true } });
    const both = [syncGraphFromGithub(graph), syncGraphFromGithub(graph)];
    // The second sync holds the shared key while the first is inside its git step (the git step itself is serialised by the
    // checkout lock, which is a different lock): neither waits on the other for the RUN lock.
    await until(async () => inGit >= 1 && (await runLockHolders(id)) === 2);
    release();
    await Promise.all(both);
    expect(await runLockHolders(id)).toBe(0);
  }, 30_000);
});

describe('#4731 the lock is released after the final status write on every path', () => {
  it('a sync that ends in ERROR (an early throw before any git work) leaves the key free and a final status', async () => {
    const o = await org(true);
    const id = await memory({ organizationId: o.id, source: 'ext::whoami', syncStatus: 'PENDING' }); // an invalid source refuses at once
    const graph = await db.memory.findUniqueOrThrow({ where: { id }, include: { organization: true } });
    await syncGraphFromGithub(graph);
    expect((await row(id)).sync_status).not.toBe('SYNCING');
    expect(await runLockHolders(id)).toBe(0);
  });

  it('a sync that completes its git step leaves the key free and a final status', async () => {
    const o = await org(true);
    const id = await memory({ organizationId: o.id, source: 'https://github.com/x/y', syncStatus: 'PENDING' });
    const graph = await db.memory.findUniqueOrThrow({ where: { id }, include: { organization: true } });
    await syncGraphFromGithub(graph); // execGit answers an empty success: OK or a later ERROR, never left SYNCING
    expect(['OK', 'ERROR']).toContain(String((await row(id)).sync_status));
    expect(await runLockHolders(id)).toBe(0);
  });
});

describe('#4731 a failed run-lock connection names no host in the stored or returned error (Rook LOW)', () => {
  it('a database connect failure stores fixed text and its code, never host:port', async () => {
    const o = await org(true);
    const id = await memory({ organizationId: o.id, source: 'https://github.com/x/y', syncStatus: 'PENDING' });
    const graph = await db.memory.findUniqueOrThrow({ where: { id }, include: { organization: true } });
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://nobody:secret-password@127.0.0.1:1/nowhere'; // nothing listens on port 1
    let out: Awaited<ReturnType<typeof syncGraphFromGithub>>;
    try { out = await syncGraphFromGithub(graph); } finally {
      if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    }
    const stored = (await row(id)).sync_error as string;
    expect(stored).toMatch(/^sync failed \(internal\)( \(\w+\))?$/);
    for (const text of [stored, String((out as { error?: string }).error)]) {
      expect(text).not.toContain('127.0.0.1');
      expect(text).not.toContain('secret-password');
      expect(text).not.toContain(':1');
    }
    expect(stored).toBe((out as { error?: string }).error);
  }, 30_000);
});
