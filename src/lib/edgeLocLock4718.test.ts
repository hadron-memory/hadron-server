/**
 * #4718: the selection -> upsert gap of derivedEdgeLocForUpsert is closed by FOR KEY SHARE on the selected migrated
 * row, held to the caller's commit. Each pin runs a real caller transaction against a real second connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from './id.js';
import { derivedEdgeLocForUpsert } from './edgeLocLookup.js';
import pg from 'pg';

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

/** True once at least `n` OTHER backends are blocked on a row lock. */
async function waitForLockWaiters(n: number) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const [r] = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')
        AND pid <> pg_backend_pid()`;
    if (r.n >= n) return;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('the expected lock wait was never observed');
}

/**
 * #4940: waiters the pin under test must NOT mistake for its own. One sits in ANOTHER database (a parallel test worker's
 * clone, or `postgres`), one in THIS database blocked behind a holder that has nothing to do with the writer. Both stay
 * blocked until `release()`. A barrier that counts any row-lock waiter in the cluster releases on either.
 */
async function startDecoyWaiters() {
  const otherName = `edgelock_decoy_${generateId().replace(/\W/g, '').slice(0, 16).toLowerCase()}`;
  const url = new URL(process.env.DATABASE_URL!);
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${otherName}`);
  const toOther = () => { const u = new URL(url); u.pathname = `/${otherName}`; return new pg.Client({ connectionString: u.toString() }); };
  const holderOther = toOther();
  const waiterOther = toOther();
  await holderOther.connect();
  await waiterOther.connect();
  await holderOther.query('CREATE TABLE d(id int PRIMARY KEY); INSERT INTO d VALUES (1)');
  await holderOther.query('BEGIN; UPDATE d SET id = 1 WHERE id = 1');
  const otherBlocked = waiterOther.query('UPDATE d SET id = 1 WHERE id = 1').catch(() => undefined);

  const sameTable = `decoy4940_${generateId().replace(/\W/g, '').slice(0, 12).toLowerCase()}`;
  await db.$executeRawUnsafe(`CREATE TABLE ${sameTable}(id int PRIMARY KEY)`);
  await db.$executeRawUnsafe(`INSERT INTO ${sameTable} VALUES (1)`);
  let releaseSame!: () => void;
  const sameRelease = new Promise<void>((r) => { releaseSame = r; });
  let sameHeld!: () => void;
  const sameHolds = new Promise<void>((r) => { sameHeld = r; });
  const holderSame = db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE ${sameTable} SET id = 1 WHERE id = 1`);
    sameHeld();
    await sameRelease;
  }, { timeout: 60_000 });
  await sameHolds;
  const waiterSame = db.$transaction((tx) => tx.$executeRawUnsafe(`UPDATE ${sameTable} SET id = 1 WHERE id = 1`), { timeout: 60_000 }).catch(() => undefined);
  // Both decoys are really blocked before the pin starts.
  const until = Date.now() + 10_000;
  for (;;) {
    const [r] = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple') AND pid <> pg_backend_pid()`;
    if (r.n >= 2) break;
    if (Date.now() > until) throw new Error('the decoy waiters never blocked');
    await new Promise((res) => setTimeout(res, 5));
  }
  return async function release() {
    await holderOther.query('COMMIT').catch(() => undefined);
    releaseSame();
    await Promise.all([otherBlocked, holderSame, waiterSame]);
    await holderOther.end();
    await waiterOther.end();
    await db.$executeRawUnsafe(`DROP TABLE ${sameTable}`);
    await admin.query(`DROP DATABASE ${otherName}`);
    await admin.end();
  };
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

  // The one cycle the lock order cannot prevent, reached here only because the writer drives the seam WITHOUT the
  // endpoint advisory keys every real caller holds first (#4888 audit: sync and the promoter take the channel key and
  // an exclusive advisory lock over each endpoint path, which serializes them against the mover's source key, so no
  // current caller can form it). Pinned as the recorded behavior of the synthetic cycle, not as a request to make it
  // succeed. Exactly one side is the deadlock victim (40P01); which one is the database's choice (it depends on who
  // waits longest), so the pin asserts that and never names a role. No sleep: both sides advance on OBSERVED lock waits.
  it('one side aborts 40P01, the other commits, and a retry of the victim completes with both edges carried, with unrelated lock waiters present (#4940)', async () => {
    const releaseDecoys = await startDecoyWaiters();
    try {
      await runTwoEdgeCycle();
    } finally {
      await releaseDecoys();
    }
  });

  async function runTwoEdgeCycle() {
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
    mover.catch(() => undefined);
    await moverHoldsNodes;
    const writer = db.$transaction(async (tx) => {
      await lockMemoriesForChannelChange(tx, [graph.id]);
      await derivedEdgeLocForUpsert(tx, args(t2)); // the caller's order: E2 first,
      writerFirst();
      // Hold E1 back until the mover is OBSERVED blocked on a lock this writer holds (E2's key share, or the channel
      // key), so the writer's next step is the one that closes the cycle, whatever the machine's speed.
      await waitForLockWaiters(1);
      await derivedEdgeLocForUpsert(tx, args(t1)); // then E1; the mover re-keys E1 first
    }, { timeout: 20_000 });
    writer.catch(() => undefined);
    const [m, w] = await Promise.allSettled([mover, writer]);
    // Exactly one victim, and it is a deadlock; the other commits. Roles-agnostic.
    const rejected = [m, w].filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toContain('40P01');
    const moverWon = m.status === 'fulfilled';
    if (moverWon) {
      expect(await db.edge.count({ where: { sourceId: source.id, memoryId: dest.id } })).toBe(2);
    } else {
      // Nothing was half-moved, and the retry the caller is told to make succeeds.
      expect(await db.edge.count({ where: { sourceId: source.id, memoryId: graph.id } })).toBe(2);
      await db.$transaction((tx) => move(tx), { timeout: 20_000 });
      expect(await db.edge.count({ where: { sourceId: source.id, memoryId: dest.id } })).toBe(2);
    }
  }
});

describe('the post-lock re-check and the capped re-select loop (#4888)', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a row left alone between selection and lock is returned with the lock HELD (live arm)', async () => {
    const f = await fixture();
    await db.$transaction(async (tx) => {
      expect(await derivedEdgeLocForUpsert(tx, f.args)).toBe(MIGRATED);
      // From another connection, a lock that conflicts with FOR KEY SHARE must now fail at once: the share is held.
      // (NOWAIT: a refusal, never a wait.) The lock is taken BEFORE the loc is returned, so a mutant that returns first
      // leaves the row free and this succeeds.
      await expect(
        db.$transaction((other) => other.$queryRaw`SELECT id FROM edges WHERE id = ${f.migrated.id} FOR UPDATE NOWAIT`),
      ).rejects.toThrow(/55P03|could not obtain lock/);
    });
    // Released at the caller's commit.
    await db.$transaction((other) => other.$queryRaw`SELECT id FROM edges WHERE id = ${f.migrated.id} FOR UPDATE NOWAIT`);
  });

  /** A db whose selection always finds the migrated row and whose lock never holds: every attempt loses the race. */
  function racing() {
    const row = { id: 'edge-1', loc: MIGRATED, name: NAME, sourceId: 's', targetId: 't' };
    const findMany = vi.fn(async () => [row]);
    const $queryRaw = vi.fn(async () => [] as Array<{ id: string }>);
    const args = { memoryId: 'm', sourceId: 's', targetId: 't', sourceLoc: 'root', targetLoc: 'leaf', name: NAME };
    return { db: { edge: { findMany }, $queryRaw } as never, findMany, $queryRaw, args };
  }

  it('the cap is hit with the lock never held: the newest selection is returned and ONE fixed warn says so', async () => {
    const r = racing();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await derivedEdgeLocForUpsert(r.db, r.args)).toBe(MIGRATED);
    expect(r.findMany).toHaveBeenCalledTimes(6); // the first selection plus 5 re-selects
    expect(r.$queryRaw).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toContain('edge_loc_lock_cap_reached');
    // Fixed text: no loc, name or id of the edge is echoed.
    expect(text).not.toContain(MIGRATED);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain('edge-1');
  });

  it('no warn when the lock is held, nor on a plain answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = await fixture();
    await db.$transaction(async (tx) => {
      expect(await derivedEdgeLocForUpsert(tx, f.args)).toBe(MIGRATED);
    });
    expect(await derivedEdgeLocForUpsert(db, { ...f.args, name: 'plain' })).toBe('root:plain:leaf');
    expect(warn).not.toHaveBeenCalled();
  });
});
