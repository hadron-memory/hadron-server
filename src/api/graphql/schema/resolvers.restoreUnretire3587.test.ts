/**
 * #3587 (ruling 0220) — `restoreRevision` refuses, with nothing written, a snapshot that would drop `superseded`
 * from a minted spec, and its auto-save rolls back with any refused or failed restore. Real Postgres throughout.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { snapshotTagsOf } from '../../../lib/restoreUnretireGuard.js';

const M = resolvers.Mutation;
let ctx: Context;
let agentId: string;
let memoryId: string;

const mk = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType: 'system', content: `c ${loc}`, tags: [], ...extra } as any });
const rowOf = (loc: string) => db.node.findFirstOrThrow({ where: { memoryId, loc } });
const revCount = () => db.node.count({ where: { memoryId, loc: { startsWith: 'revisions:rev-' } } });
const save = async () => (await M.createRevision({}, { agentRef: agentId, description: 'pre' }, ctx)).revisionLoc as string;
const restore = (revisionLoc: string, c: Context = ctx) => M.restoreRevision({}, { agentRef: agentId, revisionLoc }, c);
const MINT = new Date('2026-01-01T00:00:00Z');
// chk_node_mint_complete wants the mint record whole: a backfilled one (no revision) is the simplest legal shape.
const mintedFields = { mintedAt: MINT, mintedByInfo: 'backfill' };
/** A full byte-level picture of everything a refused restore must leave alone. */
const picture = async () => ({
  nodes: await db.node.findMany({ where: { memoryId }, orderBy: { id: 'asc' } }),
  edges: await db.edge.findMany({ where: { memoryId }, orderBy: { id: 'asc' } }),
  nodeRevisions: await db.nodeRevision.count(),
});
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Unretire', urn: 'unretire-3587.example' } });
  const user = await db.user.create({ data: { githubId: 3587001, githubUsername: 'unretire-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  ctx = { db, userId: user.id, roles: ['ADMIN'] };
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Unretire', visibility: 'PERSONAL' }, ctx);
  agentId = agent.id;
  memoryId = agent.systemMemoryId!;
});

describe('#3587 restore refuses to un-retire a minted spec', () => {
  it('P1: retire after the snapshot, restore it: refused with the code, and nothing at all is written (no auto-save)', async () => {
    await mk('specs:a', mintedFields);
    await mk('specs:b', mintedFields);
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: { in: ['specs:a', 'specs:b'] } }, data: { tags: ['superseded'], content: 'banner' } });
    const before = await picture();
    const revs = await revCount();
    const e = await refusal(restore(rev));
    expect(e.extensions).toMatchObject({ code: 'RESTORE_WOULD_UNRETIRE_SPEC', memoryId, locs: ['specs:a', 'specs:b'], count: 2 });
    expect(e.message).toContain('nothing was written');
    expect(await revCount()).toBe(revs);
    expect(await picture()).toEqual(before);
  });

  it('caps the named locs at 10 and counts them all', async () => {
    for (let i = 0; i < 12; i++) await mk(`specs:s${String(i).padStart(2, '0')}`, mintedFields);
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: { startsWith: 'specs:s' } }, data: { tags: ['superseded'] } });
    const e = await refusal(restore(rev));
    expect(e.extensions.count).toBe(12);
    expect(e.extensions.locs).toHaveLength(10);
  });

  it('P7: a minted retired spec that is TOMBSTONED now, revived by the snapshot without superseded, is refused', async () => {
    await mk('specs:t', mintedFields);
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: 'specs:t' }, data: { tags: ['superseded'], deletedAt: new Date() } });
    const before = await picture();
    const e = await refusal(restore(rev));
    expect(e.extensions).toMatchObject({ code: 'RESTORE_WOULD_UNRETIRE_SPEC', locs: ['specs:t'], count: 1 });
    expect(await picture()).toEqual(before);
  });

  it('a snapshot entry with no tags field reads as [] and is refused', async () => {
    await mk('specs:n', mintedFields);
    const rev = await save();
    const revRow = await rowOf(rev);
    const data = revRow.data as any;
    for (const n of data.snapshot.nodes) if (n.loc === 'specs:n') delete n.tags;
    await db.node.update({ where: { id: revRow.id }, data: { data } });
    await db.node.updateMany({ where: { memoryId, loc: 'specs:n' }, data: { tags: ['superseded'] } });
    expect((await refusal(restore(rev))).extensions.code).toBe('RESTORE_WOULD_UNRETIRE_SPEC');
  });

  it('P6 controls are not refused: never-minted retired, minted not retired, snapshot keeps superseded, omitted (tombstoned as today)', async () => {
    await mk('specs:draft');                                   // retired but never minted: the stated limit
    await mk('specs:live', mintedFields);              // minted, not retired now
    await mk('specs:kept', { ...mintedFields, tags: ['superseded'] }); // the snapshot keeps the tag
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: 'specs:draft' }, data: { tags: ['superseded'] } });
    await mk('specs:omitted', { ...mintedFields, tags: ['superseded'] }); // retired, minted, not in the snapshot: deletion is unprotected (120:09)
    await restore(rev);
    expect((await rowOf('specs:draft')).tags).toEqual([]);
    expect((await rowOf('specs:live')).deletedAt).toBeNull();
    expect((await rowOf('specs:kept')).tags).toEqual(['superseded']);
    expect((await rowOf('specs:omitted')).deletedAt).not.toBeNull();
  });

  it('keys on the node\'s own mint record, never the memory corpus stamp (an unminted retired spec in a corpus-stamped memory restores)', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { corpusMintedAt: MINT } });
    await mk('specs:u');
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: 'specs:u' }, data: { tags: ['superseded'] } });
    await restore(rev);
    expect((await rowOf('specs:u')).tags).toEqual([]);
  });

  it('matches superseded as a whole, case-sensitive tag', async () => {
    await mk('specs:c', mintedFields);
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: 'specs:c' }, data: { tags: ['Superseded', 'superseded-by'] } });
    await restore(rev); // neither is the tag
    expect((await rowOf('specs:c')).tags).toEqual([]);
  });

  it('the guard does not depend on the #1591 permanence switch (it is off here)', async () => {
    const { isMintedSpecPermanenceEnforced } = await import('../../../lib/mintedSpecPermanence.js');
    expect(isMintedSpecPermanenceEnforced()).toBe(false);
    await mk('specs:p', mintedFields);
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: 'specs:p' }, data: { tags: ['superseded'] } });
    expect((await refusal(restore(rev))).extensions.code).toBe('RESTORE_WOULD_UNRETIRE_SPEC');
  });

  it('malformed snapshot tags are refused as malformed, not read as a substring', async () => {
    await mk('specs:m', mintedFields);
    const rev = await save();
    const revRow = await rowOf(rev);
    const data = revRow.data as any;
    for (const n of data.snapshot.nodes) if (n.loc === 'specs:m') n.tags = 'superseded';
    await db.node.update({ where: { id: revRow.id }, data: { data } });
    const before = await picture();
    const revs = await revCount();
    const e = await refusal(restore(rev));
    expect(e.message).toMatch(/malformed/);
    expect(await revCount()).toBe(revs);
    expect(await picture()).toEqual(before);
    expect(() => snapshotTagsOf({ tags: 'superseded' })).toThrow();
    expect(() => snapshotTagsOf({ tags: ['a', 1] })).toThrow();
    expect(snapshotTagsOf({})).toEqual([]);
  });

  it('P5: any failure after the auto-save rolls it back (a later guard throws; no revisions:rev-* row survives)', async () => {
    await mk('specs:x');
    const rev = await save();
    const revs = await revCount();
    // A snapshot whose node has an invalid shape fails inside the transaction, after the auto-save write.
    const revRow = await rowOf(rev);
    const data = revRow.data as any;
    data.snapshot.nodes.push({ loc: 'specs:bad', name: 5, nodeType: 'system', tags: [] });
    await db.node.update({ where: { id: revRow.id }, data: { data } });
    await refusal(restore(rev));
    expect(await revCount()).toBe(revs);
  });

  it('a successful restore keeps exactly one auto-save revision; standalone createRevision still works', async () => {
    await mk('specs:ok');
    const rev = await save();
    const revs = await revCount();
    await restore(rev);
    expect(await revCount()).toBe(revs + 1);
    await save();
    expect(await revCount()).toBe(revs + 2);
  });

  it('a caller with no access to the Agent gets no RESTORE_WOULD_UNRETIRE_SPEC and no locs', async () => {
    await mk('specs:z', mintedFields);
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: 'specs:z' }, data: { tags: ['superseded'] } });
    const other = await db.user.create({ data: { githubId: 3587002, githubUsername: 'unretire-outsider', roles: [] } });
    const e = await refusal(restore(rev, { db, userId: other.id, roles: [] }));
    expect(e.extensions?.code).not.toBe('RESTORE_WOULD_UNRETIRE_SPEC');
    expect(e.extensions?.locs).toBeUndefined();
    expect(JSON.stringify(e.message)).not.toContain('specs:z');
  });
});

describe('#3587 concurrency (two real connections)', () => {
  async function waitFor(pred: () => Promise<boolean>, what: string) {
    const end = Date.now() + 8_000;
    while (Date.now() < end) { if (await pred()) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('P2b (leaf): a retirement holding the row; the restore waits on it under the check, then refuses and leaves nothing', async () => {
    await mk('specs:r', mintedFields);
    const rev = await save();
    const revs = await revCount();
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let bPid = 0;
    // B emulates writeNodeCore's order: the loc key, the row lock, then the tag update; it holds the transaction open.
    const b = db.$transaction(async (tx) => {
      bPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${'specs:r'}))`;
      await tx.$queryRaw`SELECT id FROM nodes WHERE memory_id = ${memoryId} AND loc = 'specs:r' FOR UPDATE`;
      await tx.node.updateMany({ where: { memoryId, loc: 'specs:r' }, data: { tags: ['superseded'] } });
      await hold;
    }, { timeout: 20_000 });
    await waitFor(async () => bPid > 0 && (await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE pid = ${bPid}::int AND locktype = 'advisory'`)[0].n > 0n, 'B to hold its key');
    const a = restore(rev).then(() => null, (e: any) => e);
    await waitFor(async () => (await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND ${bPid}::int = ANY(pg_blocking_pids(pid))`)[0].n > 0n, 'the restore to wait on B');
    release();
    await b;
    const e = await a;
    expect(e?.extensions?.code).toBe('RESTORE_WOULD_UNRETIRE_SPEC');
    expect(await revCount()).toBe(revs);
    expect((await rowOf('specs:r')).tags).toEqual(['superseded']);
  }, 30_000);

  it('P3 (ancestor key held first, not a retirement): a bare holder of the ancestor key makes the restore queue, then it proceeds, no deadlock; the B-first retirement is P3b', async () => {
    await mk('specs:p', mintedFields);
    await mk('specs:p:child');
    const rev = await save();
    let aPid = 0;
    // Hold the restore at its first statement by taking the ancestor key ourselves, then let it queue.
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const holder = db.$transaction(async (tx) => {
      aPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${'specs:p'}))`;
      await hold;
    }, { timeout: 20_000 });
    await waitFor(async () => aPid > 0, 'holder');
    const a = restore(rev).then(() => null, (e: any) => e);
    await waitFor(async () => (await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory' AND ${aPid}::int = ANY(pg_blocking_pids(pid))`)[0].n > 0n, 'the restore to queue on the ancestor key');
    release();
    await holder;
    expect(await a).toBeNull();
    // a retirement afterwards is an ordinary write
    await db.node.updateMany({ where: { memoryId, loc: 'specs:p' }, data: { tags: ['superseded'] } });
  }, 30_000);

  it('P3b (ancestor topology, B-first retirement): B holds key(specs:p) and the row and retires it; the restore waits on the ADVISORY key, then refuses with nothing written (gate D1)', async () => {
    await mk('specs:p', mintedFields);
    await mk('specs:p:child');
    const rev = await save();
    const revs = await revCount();
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let bPid = 0;
    const b = db.$transaction(async (tx) => {
      bPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${'specs:p'}))`;
      await tx.$queryRaw`SELECT id FROM nodes WHERE memory_id = ${memoryId} AND loc = 'specs:p' FOR UPDATE`;
      await tx.node.updateMany({ where: { memoryId, loc: 'specs:p' }, data: { tags: ['superseded'] } });
      await hold;
    }, { timeout: 20_000 });
    await waitFor(async () => bPid > 0 && (await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE pid = ${bPid}::int AND locktype = 'advisory'`)[0].n > 0n, 'B key');
    const a = restore(rev).then(() => null, (e: any) => e);
    await waitFor(async () => (await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory' AND ${bPid}::int = ANY(pg_blocking_pids(pid))`)[0].n > 0n, 'restore to wait on the advisory key');
    release();
    await b;
    const e = await a;
    expect(e?.extensions?.code).toBe('RESTORE_WOULD_UNRETIRE_SPEC');
    expect(await revCount()).toBe(revs);
    expect((await rowOf('specs:p')).tags).toEqual(['superseded']);
  }, 30_000);

  it('P4b (D6): a save waiting longer than Prisma\'s 5 s default behind a holder of the revisions key still succeeds with a distinct slot (35 s bound)', async () => {
    await mk('specs:w');
    await save();
    const revs = await revCount();
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let hPid = 0;
    const holder = db.$transaction(async (tx) => {
      hPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${'revisions'}))`;
      await hold;
    }, { timeout: 20_000 });
    await waitFor(async () => hPid > 0, 'holder');
    const startedAt = Date.now();
    const waiting = M.createRevision({}, { agentRef: agentId }, ctx).then((r: unknown) => r, (e: unknown) => e);
    await waitFor(async () => (await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory' AND ${hPid}::int = ANY(pg_blocking_pids(pid))`)[0].n > 0n, 'the save to wait on the revisions key');
    await new Promise((r) => setTimeout(r, Math.max(0, 5_800 - (Date.now() - startedAt))));
    release();
    await holder;
    const res: any = await waiting;
    expect(res instanceof Error ? res.message : 'ok').toBe('ok');
    expect(await revCount()).toBe(revs + 1);
  }, 40_000);

  it('P4: two restores and a standalone createRevision on one Agent take distinct slots, none aborts', async () => {
    await mk('specs:q');
    const rev = await save();
    const revs = await revCount();
    const results = await Promise.allSettled([restore(rev), restore(rev), M.createRevision({}, { agentRef: agentId }, ctx)]);
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => (r as any).reason?.message))).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const slots = await db.node.findMany({ where: { memoryId, loc: { startsWith: 'revisions:rev-' } }, select: { loc: true } });
    expect(slots).toHaveLength(revs + 3);
    expect(new Set(slots.map((s) => s.loc)).size).toBe(revs + 3);
  }, 30_000);
});

describe('#3587 snapshot-side tag match', () => {
  it('a snapshot holding only Superseded / superseded-by does not keep the tag, so restoring it over a live retirement is refused', async () => {
    await mk('specs:s', { ...mintedFields, tags: ['Superseded', 'superseded-by'] });
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: 'specs:s' }, data: { tags: ['superseded'] } });
    const e = await refusal(restore(rev));
    expect(e?.extensions?.code).toBe('RESTORE_WOULD_UNRETIRE_SPEC');
  });
});

describe('#3587 compiled boot prompt carve-out', () => {
  it('a minted, retired compiled boot prompt is not a retirement the guard judges: restoring a snapshot that lacks the tag succeeds and leaves the row byte-identical (cor:agt:040:12)', async () => {
    await mk('specs:cb', { nodeType: 'compiled-boot-prompt', role: 'boot-prompt', ...mintedFields });
    const rev = await save();
    await db.node.updateMany({ where: { memoryId, loc: 'specs:cb' }, data: { tags: ['superseded'] } });
    const before = await rowOf('specs:cb');
    await restore(rev);
    expect(await rowOf('specs:cb')).toEqual(before);
  });
});
