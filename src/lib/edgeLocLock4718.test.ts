/**
 * #4718: the selection -> upsert gap of derivedEdgeLocForUpsert is closed by FOR KEY SHARE on the selected migrated
 * row, held to the caller's commit. Each pin runs a real caller transaction against a real second connection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from './id.js';
import { derivedEdgeLocForUpsert } from './edgeLocLookup.js';

const NAME = 'a😀b';
const MIGRATED = 'root:a-b:leaf';
const RUNTIME = 'root:a--b:leaf';

async function fixture() {
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'edge-lock-org', graphName: 'edge/lock4718' });
  const source = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'root', name: 'root' } });
  const target = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'leaf', name: 'leaf' } });
  const migrated = await db.edge.create({
    data: { id: generateId(), memoryId: graph.id, sourceId: source.id, targetId: target.id, loc: MIGRATED, name: NAME },
  });
  const args = { memoryId: graph.id, sourceId: source.id, targetId: target.id, sourceLoc: 'root', targetLoc: 'leaf', name: NAME };
  const upsertAt = (tx: Pick<typeof db, 'edge'>, loc: string) =>
    tx.edge.upsert({
      where: { loc_memoryId: { loc, memoryId: graph.id } },
      create: { id: generateId(), memoryId: graph.id, sourceId: source.id, targetId: target.id, name: NAME, loc },
      update: {},
    });
  const rows = () => db.edge.findMany({ where: { memoryId: graph.id, name: NAME, deletedAt: null }, select: { loc: true } });
  return { graph, source, target, migrated, args, upsertAt, rows };
}

/** True once some OTHER backend is blocked on a row lock (the writer under test holds the key share). */
async function waitForRowLockWaiter() {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const [r] = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')
        AND pid <> pg_backend_pid()`;
    if (r.n > 0) return;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('the competing writer never blocked on the selected row');
}

describe('derivedEdgeLocForUpsert holds the selected migrated row to commit (#4718)', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  it('a hard deleteEdge between selection and upsert waits for the writer: no twin', async () => {
    const f = await fixture();
    let deleted: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      const selected = await derivedEdgeLocForUpsert(tx, f.args);
      expect(selected).toBe(MIGRATED);
      deleted = db.edge.delete({ where: { id: f.migrated.id } }).catch((e: unknown) => e);
      await waitForRowLockWaiter();
      await f.upsertAt(tx, selected);
    });
    await deleted;
    // The writer upserted AT the migrated row; the delete then removed it. Never a second row beside it.
    expect((await f.rows()).length).toBeLessThanOrEqual(1);
    const later = await derivedEdgeLocForUpsert(db, f.args);
    expect(later).toBe(RUNTIME);
  });

  it('an endpoint re-key (loc update) between selection and upsert waits for the writer', async () => {
    const f = await fixture();
    let rekeyed!: Promise<unknown>;
    await db.$transaction(async (tx) => {
      const selected = await derivedEdgeLocForUpsert(tx, f.args);
      rekeyed = db.edge.update({ where: { id: f.migrated.id }, data: { loc: 'moved:a-b:leaf' } });
      rekeyed.catch(() => undefined); // surfaced by the await below; this only keeps an early rejection from going unhandled
      await waitForRowLockWaiter();
      await f.upsertAt(tx, selected);
    });
    await rekeyed; // a failed re-key fails the test
    const all = await db.edge.findMany({ where: { memoryId: f.graph.id, name: NAME }, select: { loc: true } });
    expect(all.map((r) => r.loc)).toEqual(['moved:a-b:leaf']);
  });

  it('a row deleted BEFORE the lock is taken is not selected: the runtime spelling, no stale loc', async () => {
    const f = await fixture();
    await db.edge.delete({ where: { id: f.migrated.id } });
    await db.$transaction(async (tx) => {
      expect(await derivedEdgeLocForUpsert(tx, f.args)).toBe(RUNTIME);
    });
  });

  it('two seam writers key-share the same row and never block each other', async () => {
    const f = await fixture();
    await db.$transaction(async (a) => {
      expect(await derivedEdgeLocForUpsert(a, f.args)).toBe(MIGRATED);
      await db.$transaction(async (b) => {
        expect(await derivedEdgeLocForUpsert(b, f.args)).toBe(MIGRATED);
      }, { timeout: 3000 });
    });
  });
});

describe('lock order against moveNodeSubtree (#4718)', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  // Order, one for every path: channel key -> subtree advisory locks -> node rows (+ memory fences) -> edge row.
  // The mover holds the node rows FIRST and reaches the edge row last (its edge pass); the seam writer takes the edge
  // row and nothing after it that a mover could hold. Run the interleaving that closes a cycle if either side breaks it:
  // the mover already owns the node rows when the writer selects and key-shares the edge.
  it.each(Array.from({ length: 8 }, (_, i) => i))('cross-memory move re-keying the edge vs a seam select and upsert, round %i: both complete', async () => {
    const f = await fixture();
    const { org } = { org: await db.organization.findFirstOrThrow() };
    const dest = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'edge-lock-org:edge/dest4718', name: 'edge/dest4718', class: 'knowledge' },
    });
    const user = await db.user.create({ data: { githubId: 471800 + Math.floor(Math.random() * 90000), githubUsername: `m4718-${generateId()}`, roles: ['ADMIN'] } });
    const { moveNodeSubtree } = await import('./nodeSubtreeMove.js');
    const { lockMemoriesForChannelChange } = await import('./channels.js');
    const sourceRow = await db.node.findUniqueOrThrow({ where: { id: f.source.id } });

    let moverHoldsNodes!: () => void;
    const nodesHeld = new Promise<void>((r) => { moverHoldsNodes = r; });
    let writerDone!: () => void;
    const writerCommitted = new Promise<void>((r) => { writerDone = r; });

    const mover = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${f.source.id} FOR UPDATE`;
      moverHoldsNodes();
      // Go on once the writer has committed, or is blocked on a lock this transaction holds (a cycle then closes below).
      await Promise.race([writerCommitted, waitForRowLockWaiter().catch(() => undefined)]);
      await moveNodeSubtree(tx, { source: sourceRow, destLoc: 'moved', destMemoryId: dest.id, editor: { userId: user.id } });
    }, { timeout: 15_000 });

    await nodesHeld;
    await db.$transaction(async (tx) => {
      await lockMemoriesForChannelChange(tx, [f.graph.id]);
      const selected = await derivedEdgeLocForUpsert(tx, f.args);
      expect(selected).toBe(MIGRATED);
      await f.upsertAt(tx, selected);
    }, { timeout: 15_000 });
    writerDone();
    await mover;

    // One edge for the relationship; the move carried it with its source and re-derived its loc (cor:api:190:01).
    const all = await db.edge.findMany({ where: { name: NAME, sourceId: f.source.id }, select: { memoryId: true, loc: true } });
    expect(all).toHaveLength(1);
    expect(all[0].memoryId).toBe(dest.id);
  });
});

describe('KNOWN, ACCEPTED: a writer key-sharing two edges against a mover re-keying both (#4718)', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  // The one cycle the lock order cannot prevent: the seam caller's relationship order and moveNodeSubtree's plan order
  // are independent. The move (no channel key) aborts with 40P01 and is retryable; the writer completes; no corruption.
  // Pinned so the behavior is a recorded contract, not a surprise (follow-up: retryOnDeadlock around the move).
  it('the mover aborts 40P01, the writer commits, and a retried move completes with both edges carried', async () => {
    const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'edge-lock-multi', graphName: 'edge/multi4718' });
    const dest = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'edge-lock-multi:edge/dest', name: 'edge/dest', class: 'knowledge' },
    });
    const user = await db.user.create({ data: { githubId: 477001 + Math.floor(Math.random() * 9000), githubUsername: `m4718-${generateId()}`, roles: ['ADMIN'] } });
    const { moveNodeSubtree } = await import('./nodeSubtreeMove.js');
    const { lockMemoriesForChannelChange } = await import('./channels.js');
    const source = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'root', name: 'root' } });
    const t1 = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'leaf1', name: 'leaf1' } });
    const t2 = await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'leaf2', name: 'leaf2' } });
    for (const t of [t1, t2]) {
      await db.edge.create({ data: { id: generateId(), memoryId: graph.id, sourceId: source.id, targetId: t.id, loc: `root:a-b:${t.loc}`, name: NAME } });
    }
    const args = (t: typeof t1) => ({ memoryId: graph.id, sourceId: source.id, targetId: t.id, sourceLoc: 'root', targetLoc: t.loc, name: NAME });
    const sourceRow = await db.node.findUniqueOrThrow({ where: { id: source.id } });
    const move = (tx: Parameters<typeof moveNodeSubtree>[0]) =>
      moveNodeSubtree(tx, { source: sourceRow, destLoc: 'moved', destMemoryId: dest.id, editor: { userId: user.id } });

    let moverHolds!: () => void;
    const moverHoldsNodes = new Promise<void>((r) => { moverHolds = r; });
    let writerFirst!: () => void;
    const writerHasFirst = new Promise<void>((r) => { writerFirst = r; });
    const mover = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${source.id} FOR UPDATE`;
      moverHolds();
      await writerHasFirst;
      await move(tx);
    }, { timeout: 20_000 });
    await moverHoldsNodes;
    const writer = db.$transaction(async (tx) => {
      await lockMemoriesForChannelChange(tx, [graph.id]);
      await derivedEdgeLocForUpsert(tx, args(t2)); // the caller's order: E2 first,
      writerFirst();
      await new Promise((r) => setTimeout(r, 500));
      await derivedEdgeLocForUpsert(tx, args(t1)); // then E1; the mover re-keys E1 first
    }, { timeout: 20_000 });
    const [m, w] = await Promise.allSettled([mover, writer]);
    expect(w.status).toBe('fulfilled');
    expect(m.status).toBe('rejected');
    expect(String((m as PromiseRejectedResult).reason)).toContain('40P01');
    // Nothing was half-moved, and the retry the caller is told to make succeeds.
    expect((await db.edge.findMany({ where: { sourceId: source.id, memoryId: graph.id } })).length).toBe(2);
    await db.$transaction((tx) => move(tx), { timeout: 20_000 });
    expect(await db.edge.count({ where: { sourceId: source.id, memoryId: dest.id } })).toBe(2);
  });
});
