/**
 * #3571 (ruling 0223, cor:int:010:01): a row the pre-#3568 no-installation path left at SYNCING, with no source or no
 * installation and no sync running, becomes PENDING and nothing else. A sync actually in flight, and every other row,
 * are untouched. "No sync running" is proven by the sync-run lock every attempt holds (shared) from before its SYNCING
 * stamp until its final status write; the reconciliation takes it exclusively with try, per row, so a running sync makes
 * it skip the row rather than wait or overwrite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { execGit } from './execGit.js';
import { syncGraphFromGithub } from './syncGraphFromGithub.js';
import { reconcileSyncingStatus } from './reconcileSyncing.js';

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
    const locks = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory'
      AND objid = (hashtext(${`hadron:git-sync:${id}`}) & x'ffffffff'::bigint)::oid`;
    expect(Number(locks[0].n)).toBe(0);
  }, 30_000);
});

describe('#3571 the not-attempted refusal stays write-free', () => {
  it('a NO_INSTALLATION sync of a SYNCING row writes nothing and takes no run lock', async () => {
    const id = await memory({ organizationId: (await org(false)).id, source: 'https://github.com/x/y' });
    const before = await row(id);
    const graph = await db.memory.findUniqueOrThrow({ where: { id }, include: { organization: true } });
    expect(await syncGraphFromGithub(graph)).toMatchObject({ notAttemptedReason: 'NO_INSTALLATION' });
    expect(await row(id)).toEqual(before);
  });
});
