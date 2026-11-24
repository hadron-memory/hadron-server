/**
 * #3587 — the gate's pins that #4750 (which built the rule) left open, all against real Postgres:
 * - P8 concealment: an Agent-readable, non-ADMIN caller gets today's Forbidden, byte-identical, with no code and no locs;
 * - D2 scope: standalone `createRevision` reads its snapshot OUTSIDE its transaction (observe-only, through the pool);
 * - the union lock set: the restore's first `acquireLockSet` holds `revisions` plus every snapshot ancestor
 *   (observe-only spy on the real function);
 * - D5: a competing insert of loc `revisions` that takes no `revisions` key, held open on a second connection, makes
 *   the parent ensure wait and then do nothing: no 25P02, the restore and a standalone save both succeed;
 * - scope: the #1591 guards stay disabled, and `restoreNode` / `restoreNodeRevision` stay outside the rule (ruling
 *   0220 names only the snapshot restore; cor:spc:010:02's stated limit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Observe-only: the real acquireLockSet runs; the spy records each call's keys.
const lockSetCalls = vi.hoisted(() => [] as Array<Array<{ memoryId: string; loc: string }>>);
vi.mock('../../../lib/nodeSubtreeLock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/nodeSubtreeLock.js')>();
  return {
    ...real,
    acquireLockSet: async (tx: Parameters<typeof real.acquireLockSet>[0], keys: Parameters<typeof real.acquireLockSet>[1]) => {
      lockSetCalls.push(keys.map((k) => ({ memoryId: k.memoryId, loc: k.loc })));
      return real.acquireLockSet(tx, keys);
    },
  };
});

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { isMintedSpecPermanenceEnforced } from '../../../lib/mintedSpecPermanence.js';
import { setRestorePauseBeforeRetirementCheckForTests } from './resolvers.mutation.session.js';

const M = resolvers.Mutation as any;
let ctx: Context;
let orgId: string;
let agentId: string;
let memoryId: string;

const MINT = new Date('2026-01-01T00:00:00Z');
const mintedFields = { mintedAt: MINT, mintedByInfo: 'backfill' };
const mk = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType: 'system', content: `c ${loc}`, tags: [], ...extra } as any });
const rowOf = (loc: string) => db.node.findFirstOrThrow({ where: { memoryId, loc } });
const revCount = () => db.node.count({ where: { memoryId, loc: { startsWith: 'revisions:rev-' } } });
const save = async (c: Context = ctx) => (await M.createRevision({}, { agentRef: agentId, description: 'pre' }, c)).revisionLoc as string;
const restore = (revisionLoc: string, c: Context = ctx) => M.restoreRevision({}, { agentRef: agentId, revisionLoc }, c);
const retire = (loc: string) => db.node.updateMany({ where: { memoryId, loc }, data: { tags: ['superseded'] } });
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error('expected a refusal');
}
async function waitFor(pred: () => Promise<boolean>, what: string) {
  const end = Date.now() + 8_000;
  while (Date.now() < end) { if (await pred()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(async () => {
  await cleanDb(db);
  lockSetCalls.length = 0;
  const org = await db.organization.create({ data: { name: 'Unretire pins', urn: 'unretire-pins-3587.example' } });
  orgId = org.id;
  const user = await db.user.create({ data: { githubId: 3587101, githubUsername: 'unretire-pins-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  ctx = { db, userId: user.id, roles: ['ADMIN'] };
  // ORGANIZATION visibility, so an org READER can read the Agent but is not its ADMIN (P8).
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Unretire pins', visibility: 'ORGANIZATION' }, ctx);
  agentId = agent.id;
  memoryId = agent.systemMemoryId!;
});

describe('#3587 P8 — concealment for a readable, non-ADMIN caller', () => {
  it('an un-retiring snapshot and a harmless one get the SAME Forbidden, with no code of the rule and no locs', async () => {
    const reader = await db.user.create({ data: { githubId: 3587102, githubUsername: 'unretire-pins-reader', roles: [] } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: reader.id, role: 'READER' } });
    const rctx: Context = { db, userId: reader.id, roles: [] };
    // Precondition: the reader passes the Agent read gate (it is not refused as absent).
    expect((await (resolvers.Query as any).agent({}, { ref: agentId }, rctx))?.id).toBe(agentId);

    await mk('specs:z', mintedFields);
    await mk('notes:plain');
    const rev = await save();
    // Harmless first: nothing in the snapshot would un-retire anything.
    const harmless = await refusal(restore(rev, rctx));
    await retire('specs:z');
    const unretiring = await refusal(restore(rev, rctx));

    expect(unretiring.extensions?.code).toBe('FORBIDDEN');
    expect(unretiring.extensions?.locs).toBeUndefined();
    expect(unretiring.message).not.toContain('specs:z');
    // Byte-identical to the refusal of a snapshot the rule has nothing to say about.
    expect(JSON.stringify({ m: unretiring.message, x: unretiring.extensions })).toBe(JSON.stringify({ m: harmless.message, x: harmless.extensions }));
    expect((await rowOf('specs:z')).tags).toEqual(['superseded']);
  });
});

describe('#3587 P2s — a retirement that lands after the auto-save and before the check (leaf, seam-driven)', () => {
  // Proofs inside the restore, not endpoint proofs: the pause is a test-only seam in restoreRevision between the
  // auto-save write and the row-locked check. The endpoint races are P2b and P3b in resolvers.restoreUnretire3587.test.ts.
  afterEach(() => { setRestorePauseBeforeRetirementCheckForTests(null); });

  it('ordering: a retirement COMMITTED in that window is seen (the check reads after the auto-save), and the restore refuses with no auto-save', async () => {
    const spec = await mk('specs:l', mintedFields); // a leaf: no snapshot loc lies under it, so A never holds key(specs:l)
    await mk('notes:other');
    const rev = await save();
    const revs = await revCount();
    let reached!: () => void;
    const atPause = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const resume = new Promise<void>((r) => { release = r; });
    setRestorePauseBeforeRetirementCheckForTests(async () => { reached(); await resume; });
    const a = restore(rev).then(() => null, (e: any) => e);
    await atPause;
    // B: a real retirement through updateNode, which commits while A is paused (A holds no key or row it needs).
    await M.updateNode({}, { input: { id: spec.id, tags: ['superseded'] } }, ctx);
    // Observed before A resumes: a fresh read sees the committed tag.
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).tags).toEqual(['superseded']);
    release();
    const e = await a;
    expect(e?.extensions?.code).toBe('RESTORE_WOULD_UNRETIRE_SPEC');
    expect(e?.extensions?.locs).toEqual(['specs:l']);
    expect(await revCount()).toBe(revs);
    expect((await rowOf('specs:l')).tags).toEqual(['superseded']);
  }, 30_000);

  it('row lock: a retirement HELD OPEN in that window makes the check wait for it, then refuse (a non-locking read would see the old tags and restore)', async () => {
    const spec = await mk('specs:w', mintedFields);
    await mk('notes:other');
    const rev = await save();
    const revs = await revCount();
    let reached!: () => void;
    const atPause = new Promise<void>((r) => { reached = r; });
    let resumeA!: () => void;
    const resume = new Promise<void>((r) => { resumeA = r; });
    setRestorePauseBeforeRetirementCheckForTests(async () => { reached(); await resume; });
    const a = restore(rev).then(() => null, (e: any) => e);
    let releaseB!: () => void;
    const hold = new Promise<void>((r) => { releaseB = r; });
    let bPid = 0;
    let b: Promise<unknown> = Promise.resolve();
    try {
      await atPause;
      // B: the retirement's row write, held open on a second connection (an UPDATE takes the row's NO KEY UPDATE lock).
      b = db.$transaction(async (tx) => {
        bPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
        await tx.$executeRaw`UPDATE nodes SET tags = ARRAY['superseded']::text[] WHERE id = ${spec.id}`;
        await hold;
      }, { timeout: 20_000 });
      await waitFor(async () => bPid > 0 && (await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_locks WHERE pid = ${bPid}::int AND locktype = 'transactionid' AND granted`)[0].n > 0n, 'B to hold its update');
      resumeA();
      // A waits on B. Without the check's row lock A would still wait, at a later locked write, but its check would
      // already have read the old tags and the restore would succeed: the refusal below is what pins the lock.
      await waitFor(async () => (await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_stat_activity WHERE ${bPid}::int = ANY(pg_blocking_pids(pid)) AND query ILIKE '%FOR NO KEY UPDATE%'`)[0].n > 0n,
        'the retirement check to wait on B');
    } finally {
      resumeA();
      releaseB();
      await b;
    }
    const e = await a;
    expect(e?.extensions?.code).toBe('RESTORE_WOULD_UNRETIRE_SPEC');
    expect(e?.extensions?.locs).toEqual(['specs:w']);
    expect(await revCount()).toBe(revs);
    expect((await rowOf('specs:w')).tags).toEqual(['superseded']);
  }, 30_000);
});

describe('#3587 D2 — standalone createRevision reads outside its transaction', () => {
  it('the snapshot node and edge reads go through the pool, not the transaction client', async () => {
    await mk('notes:a');
    const poolReads: string[] = [];
    // Observe-only: every call still reaches the real client; only calls made on the POOL object are recorded.
    const watched = new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop !== 'node' && prop !== 'edge') return typeof v === 'function' ? v.bind(target) : v;
        return new Proxy(v as object, {
          get(m, p) {
            const fn = Reflect.get(m, p, m);
            if (p !== 'findMany' || typeof fn !== 'function') return typeof fn === 'function' ? fn.bind(m) : fn;
            return (args: unknown) => { poolReads.push(String(prop)); return (fn as (a: unknown) => unknown).call(m, args); };
          },
        });
      },
    }) as typeof db;
    await M.createRevision({}, { agentRef: agentId }, { ...ctx, db: watched });
    expect(poolReads).toEqual(expect.arrayContaining(['node', 'edge']));
    expect(await revCount()).toBe(1);
  });
});

describe('#3587 — the restore takes ONE complete advisory set first', () => {
  it('its first acquireLockSet holds `revisions` and every strict ancestor of every snapshot loc', async () => {
    await mk('specs:a:b:c');
    await mk('notes:x');
    const rev = await save();
    lockSetCalls.length = 0;
    await restore(rev);
    const first = lockSetCalls.find((keys) => keys.every((k) => k.memoryId === memoryId));
    expect(first, 'the restore called acquireLockSet').toBeDefined();
    const locs = new Set(first!.map((k) => k.loc));
    for (const l of ['revisions', 'specs', 'specs:a', 'specs:a:b', 'notes']) expect(locs.has(l), `holds ${l}`).toBe(true);
    // It is the restore's first lock-set call: nothing before it in this transaction took a loc key.
    expect(lockSetCalls.indexOf(first!)).toBe(0);
  });
});

describe('#3587 D5 — a competing `revisions` insert that takes no `revisions` key', () => {
  async function competingParentInsert() {
    // The parent is absent (hard-deleted), as before any save on a fresh memory; the revision rows stay.
    await db.$executeRaw`DELETE FROM nodes WHERE memory_id = ${memoryId} AND loc = 'revisions'`;
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let bPid = 0;
    // B: a raw insert of the parent, the way a bulk create of a root loc lands (no `revisions` path key), held open.
    const b = db.$transaction(async (tx) => {
      bPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx.$executeRaw`INSERT INTO nodes (id, memory_id, loc, name, node_type, updated_at)
        VALUES (${generateId()}, ${memoryId}, 'revisions', 'revisions', 'system', now())`;
      await hold;
    }, { timeout: 20_000 });
    await waitFor(async () => bPid > 0 && (await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks WHERE pid = ${bPid}::int AND locktype = 'transactionid' AND granted`)[0].n > 0n, 'B to hold its insert');
    const waitsOnB = () => waitFor(async () => (await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND ${bPid}::int = ANY(pg_blocking_pids(pid))`)[0].n > 0n, 'the parent ensure to wait on B');
    return { b, release, waitsOnB };
  }

  it('the restore\'s parent ensure waits for B, then does nothing: the restore succeeds with one auto-save, no 25P02', async () => {
    await mk('notes:r');
    const rev = await save();
    const revs = await revCount();
    const { b, release, waitsOnB } = await competingParentInsert();
    const a = restore(rev).then(() => null, (e: any) => e);
    try { await waitsOnB(); } finally { release(); await b; }
    const e = await a;
    expect(e ? `${e.code ?? ''} ${e.message}` : null).toBeNull();
    expect(await revCount()).toBe(revs + 1);
    expect(await db.node.count({ where: { memoryId, loc: 'revisions' } })).toBe(1);
  }, 30_000);

  it('a standalone createRevision in the same position also waits, then succeeds with a distinct slot', async () => {
    await mk('notes:s');
    await save();
    const revs = await revCount();
    const { b, release, waitsOnB } = await competingParentInsert();
    const a = M.createRevision({}, { agentRef: agentId }, ctx).then(() => null, (e: any) => e);
    try { await waitsOnB(); } finally { release(); await b; }
    const e = await a;
    expect(e ? `${e.code ?? ''} ${e.message}` : null).toBeNull();
    expect(await revCount()).toBe(revs + 1);
  }, 30_000);
});

describe('#3587 scope — what the rule leaves alone', () => {
  it('the two #1591 guards stay disabled', () => {
    expect(isMintedSpecPermanenceEnforced()).toBe(false);
  });

  it('restoreNode revives a tombstoned minted retired spec as it is, still retired (not a door of this rule)', async () => {
    const spec = await mk('specs:t', { ...mintedFields, tags: ['superseded'], deletedAt: new Date() });
    await (resolvers.Mutation as any).restoreNode({}, { nodeRef: spec.id }, ctx);
    const row = await rowOf('specs:t');
    expect(row.deletedAt).toBeNull();
    expect(row.tags).toEqual(['superseded']);
  });

  it('restoreNodeRevision may still put back a minted spec\'s pre-retirement tags (cor:spc:010:02 stated limit, ruling 0220 Q5)', async () => {
    const spec = await mk('specs:h', mintedFields);
    await M.updateNode({}, { input: { id: spec.id, content: 'second' } }, ctx);
    const first = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: spec.id }, orderBy: { revNo: 'asc' } });
    await M.updateNode({}, { input: { id: spec.id, tags: ['superseded'] } }, ctx);
    expect((await rowOf('specs:h')).tags).toEqual(['superseded']);
    await M.restoreNodeRevision({}, { revisionId: first.id }, ctx);
    expect((await rowOf('specs:h')).tags).not.toContain('superseded');
  });
});
