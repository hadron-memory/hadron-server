import { randomUUID } from 'node:crypto';
/**
 * #887 Slice 1 — per-memory round-robin fairness in the embedding drain.
 *
 * `drainEmbeddingQueue`'s selection used to be a global
 * `ORDER BY embedding_pending_at ASC LIMIT n`: one memory's old backlog
 * (bulk import, backfill, retryFailedEmbeddings re-drive) forms a convoy
 * that fills every batch ahead of other memories' due fresh writes.
 *
 * These pin the FAIRNESS PROPERTY as the acceptance (Xylon's gate ruling 1):
 * across repeated bounded batches, every memory with due work gets an
 * opportunity — no fixed first-page subset starves the rest — including
 * when there are more due memories than batch slots, and a newly due
 * memory progresses under a continuing backlog. Within a memory,
 * oldest-due-first with deterministic id ties.
 *
 * Every assertion here is ROTATION-INVARIANT: the fair schedule may start
 * its memory cycle anywhere, so the tests assert served-within-k-batches
 * and per-memory ordering, never absolute cross-memory ordering. That keeps
 * them deterministic under the drain's rotating start point (and under any
 * prior test in this file having advanced it).
 *
 * Hermetic: fake embedding clients + the disposable per-worker DB; no bus,
 * no broker, no provider calls. The drain-ping entry path
 * (`handleEmbedWake` with an empty payload) shares the selection, so one
 * test drives the convoy through it; the direct `{ nodeId }` wake is a
 * different thing (one named node, marker-gated) and has its own pins in
 * embedNodes.bus.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { EmbeddingClient } from '../lib/embedding/client.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../lib/embedding/index.js';
import { drainEmbeddingQueue, handleEmbedWake, embeddingDispatcher } from './embedNodes.js';

const DIM = 768;

function oneHot(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[i % DIM] = 1;
  return v;
}

/**
 * Probe client records endpoint texts and counts. Admission order is observed
 * separately: concurrent DB reads can reorder the two pipelines' provider arrivals.
 */
function probeClient(opts: { failAbstracts?: Set<string> } = {}): {
  client: EmbeddingClient;
  calls: string[];
} {
  const calls: string[] = [];
  let next = 0;
  const client: EmbeddingClient = {
    provider: 'test',
    model: 'fairness-stub',
    dim: DIM,
    async embed(texts: string[]) {
      for (const t of texts) {
        calls.push(t);
        if (opts.failAbstracts?.has(t)) {
          throw new Error(`connect ECONNREFUSED (${t})`);
        }
      }
      return texts.map(() => oneHot(next++));
    },
  };
  return { client, calls };
}

let orgId: string;
let admittedIds: string[] = [];

async function makeMemory(suffix: string, vectorIndexEnabled = true): Promise<string> {
  const m = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      urn: `fair887-${suffix}:${generateId()}`,
      name: `fair887-${suffix}`,
      class: 'knowledge',
      vectorIndexEnabled,
      embeddingSource: 'abstract',
    },
  });
  return m.id;
}

interface DueNode {
  id: string;
  memoryId: string;
  loc: string;
  abstract: string;
}

async function makeDueNode(memoryId: string, loc: string, stamp: Date): Promise<DueNode> {
  const abstract = `abstract of ${loc}`;
  const n = await db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc,
      name: loc,
      content: `body of ${loc}`,
      abstract,
      embeddingPendingAt: stamp, embeddingWorkToken: randomUUID(),
    },
  });
  return { id: n.id, memoryId, loc, abstract };
}

/** Vector rows per memory — "embedded" as the DB sees it. */
async function embeddedCountByMemory(): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<{ memory_id: string; c: bigint }[]>`
    SELECT memory_id, COUNT(*)::bigint AS c FROM node_embeddings GROUP BY memory_id`;
  return new Map(rows.map((r) => [r.memory_id, Number(r.c)]));
}

/** Positions of one memory's abstracts in the embed-call sequence. */
function callIndexesForMemory(calls: string[], nodes: DueNode[], memoryId: string): number[] {
  const wanted = new Set(nodes.filter((n) => n.memoryId === memoryId).map((n) => n.abstract));
  return calls.map((c, i) => (wanted.has(c) ? i : -1)).filter((i) => i >= 0);
}

beforeEach(async () => {
  admittedIds = [];
  const read = db.node.findUnique.bind(db.node);
  vi.spyOn(db.node, 'findUnique').mockImplementation(((args: any) => {
    // Observe the first DB operation of an admitted pipeline, before async DB
    // completion can reorder provider arrivals. Forward the real query unchanged.
    if (args.select?.memory && args.select?.embeddingWorkToken) admittedIds.push(args.where.id);
    return read(args);
  }) as typeof db.node.findUnique);
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  const org = await db.organization.create({
    data: { id: generateId(), name: 'fair887-org', urn: 'fair887-org' },
  });
  orgId = org.id;
});

afterEach(async () => {
  await vi.waitFor(() => {
    const state = embeddingDispatcher(db).state();
    expect(state.active).toBe(0);
    expect(state.selecting || state.scheduled).toBe(false);
  });
  resetEmbeddingClientForTests();
  vi.restoreAllMocks();
  delete process.env.EMBEDDING_API_URL;
});

describe('#887 Slice 1 — the convoy (red on global FIFO)', () => {
  it("serves memory B's due fresh write in the FIRST batch under memory A's older backlog", async () => {
    // A: 30-node backlog stamped an hour ago. B: one fresh write, due now.
    // batchSize 10 — global FIFO fills the batch entirely from A.
    const memA = await makeMemory('a');
    const memB = await makeMemory('b');
    const old = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 30; i++) await makeDueNode(memA, `a${i}`, new Date(old.getTime() + i));
    const bNode = await makeDueNode(memB, 'b-fresh', new Date());

    const { client, calls } = probeClient();
    const r = await drainEmbeddingQueue(db, { batchSize: 10, client });

    // Batch bounds preserved: a full batch was processed.
    expect(r.embedded).toBe(10);
    // THE PROPERTY: B's fresh write was served in this first batch —
    // on main's global FIFO, calls[0..9] are all A's older nodes and B
    // starves until A's backlog drains (call index would be 30).
    expect(calls).toContain(bNode.abstract);
    expect(calls.indexOf(bNode.abstract)).toBeLessThan(10);
    const row = await db.node.findUniqueOrThrow({ where: { id: bNode.id } });
    expect(row.embeddingPendingAt).toBeNull();
  });

  it('more due memories than slots: repeated batches give EVERY memory an opportunity — no fixed first-page subset starves the rest', async () => {
    // 12 memories × 2 due nodes, one stamp epoch per memory (memory i's
    // nodes at base + i*1s): global FIFO order = memory order, so on main
    // the first two batches (20 slots) are memories 0..9 and m10/m11 starve.
    const memIds: string[] = [];
    const all: DueNode[] = [];
    const base = Date.now() - 3_600_000;
    for (let m = 0; m < 12; m++) {
      const memId = await makeMemory(`m${m}`);
      memIds.push(memId);
      for (let j = 0; j < 2; j++) {
        all.push(await makeDueNode(memId, `m${m}-n${j}`, new Date(base + m * 1000 + j)));
      }
    }

    const { client } = probeClient();
    await drainEmbeddingQueue(db, { batchSize: 10, client });
    await drainEmbeddingQueue(db, { batchSize: 10, client });

    // After ⌈12/10⌉ = 2 batches, every memory has embedded at least one
    // node (on main only the first ten memories do).
    const byMem = await embeddedCountByMemory();
    for (const memId of memIds) {
      expect(byMem.get(memId) ?? 0).toBeGreaterThanOrEqual(1);
    }
    // No duplicates across the batches: 20 distinct nodes embedded, 4 left.
    expect([...byMem.values()].reduce((s, c) => s + c, 0)).toBe(20);
    const stillPending = await db.node.count({ where: { embeddingPendingAt: { not: null } } });
    expect(stillPending).toBe(4);
  });

  it('a newly due memory makes progress under a continuing A backlog', async () => {
    const memA = await makeMemory('a');
    const old = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 25; i++) await makeDueNode(memA, `a${i}`, new Date(old.getTime() + i));
    const drain1 = probeClient();
    // Drain 1: A is the only due memory — it legitimately takes the batch.
    const r1 = await drainEmbeddingQueue(db, { batchSize: 10, client: drain1.client });
    expect(r1.embedded).toBe(10);

    // C becomes due while A's backlog continues. A fresh probe watches this
    // batch's call order in isolation.
    const memC = await makeMemory('c');
    const cNode = await makeDueNode(memC, 'c-fresh', new Date());
    const drain2 = probeClient();
    const r2 = await drainEmbeddingQueue(db, { batchSize: 10, client: drain2.client });

    // C is served within THIS batch (call index < batchSize) — on main the
    // 15 remaining older A nodes fill it and C waits for the next one.
    expect(r2.embedded).toBe(10);
    expect(drain2.calls).toContain(cNode.abstract);
    expect(drain2.calls.indexOf(cNode.abstract)).toBeLessThan(10);
    const row = await db.node.findUniqueOrThrow({ where: { id: cNode.id } });
    expect(row.embeddingPendingAt).toBeNull();
  });

  it('within a batch, one node per memory per round — first selections hit distinct memories, and no memory takes two slots while another waits', async () => {
    // Three memories × 10 due nodes, disjoint stamp epochs so main's global
    // order would be "all of A, then all of B, then all of C".
    const memA = await makeMemory('a');
    const memB = await makeMemory('b');
    const memC = await makeMemory('c');
    const base = Date.now() - 3_600_000;
    const nodes: DueNode[] = [];
    // A oldest, then B, then C — exactly the convoy ordering.
    for (let i = 0; i < 10; i++) nodes.push(await makeDueNode(memA, `a${i}`, new Date(base + i)));
    for (let i = 0; i < 10; i++) nodes.push(await makeDueNode(memB, `b${i}`, new Date(base + 10_000 + i)));
    for (let i = 0; i < 10; i++) nodes.push(await makeDueNode(memC, `c${i}`, new Date(base + 20_000 + i)));

    const { client, calls } = probeClient();
    const r = await drainEmbeddingQueue(db, { batchSize: 10, client });
    expect(r.embedded).toBe(10);

    // The first min(M, B) = 3 selections belong to 3 DISTINCT memories (on
    // main they are a0,a1,a2 — all memory A).
    const firstThreeMems = new Set(
      [0, 1, 2].map((i) => nodes.find((n) => n.id === admittedIds[i])?.memoryId),
    );
    expect(firstThreeMems.size).toBe(3);

    // Per-memory slot counts within the batch differ by at most one: a
    // memory never takes a second slot while an unserved memory waits.
    const counts = [memA, memB, memC].map(
      (m) => callIndexesForMemory(calls, nodes, m).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);

    // Within each memory, service is oldest-due-first: the call order
    // restricted to that memory's abstracts follows ascending stamp order
    // (each loc's suffix is its position in that memory's stamp sequence).
    for (const [memId, prefix] of [[memA, 'a'], [memB, 'b'], [memC, 'c']] as const) {
      const served = admittedIds.map(id => nodes.find(n => n.id === id))
        .filter(n => n?.memoryId === memId).map(n => n!.loc);
      const suffixes = served.map((loc) => Number(loc.slice(prefix.length)));
      expect(
        suffixes.every((s, k) => k === 0 || suffixes[k - 1] < s),
        `${prefix}: oldest-due-first within memory`,
      ).toBe(true);
    }
  });

  it('the bus drain ping inherits the same fair selection — B lands inside the ping’s first batch', async () => {
    // handleEmbedWake({}) loops full drainEmbeddingQueue batches, so a
    // multi-batch ping masks per-batch unfairness at the END of the run —
    // the call ORDER still shows it: on main B is call 61 (after A's 60),
    // under the fair schedule B is served in the first batch (first 25).
    const memA = await makeMemory('a');
    const memB = await makeMemory('b');
    const old = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 60; i++) await makeDueNode(memA, `a${i}`, new Date(old.getTime() + i));
    const bNode = await makeDueNode(memB, 'b-fresh', new Date());

    const { client, calls } = probeClient();
    setEmbeddingClientForTests(client);
    await handleEmbedWake(db, {}, client);
    await vi.waitFor(() => expect(calls).toContain(bNode.abstract));

    expect(calls.indexOf(bNode.abstract)).toBeGreaterThanOrEqual(0);
    expect(admittedIds.indexOf(bNode.id)).toBeLessThan(25);
  });
});

describe('#887 Slice 1 — parity controls (green before and after)', () => {
  it('an empty queue drains to zero processed with no embedding calls', async () => {
    const { client, calls } = probeClient();
    const r = await drainEmbeddingQueue(db, { batchSize: 10, client });
    expect(r).toEqual({ embedded: 0, failed: 0, skipped: 0 });
    expect(calls).toEqual([]);
  });

  it('a single due memory fills the batch oldest-first (no other memory awaits service)', async () => {
    const memA = await makeMemory('a');
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < 7; i++) await makeDueNode(memA, `a${i}`, new Date(base + i * 1000));

    const { client, calls } = probeClient();
    const r = await drainEmbeddingQueue(db, { batchSize: 10, client });
    expect(r.embedded).toBe(7);
    const byId = new Map((await db.node.findMany({ where: { id: { in: admittedIds } }, select: { id: true, abstract: true } })).map(n => [n.id, n.abstract]));
    const ordered = ['abstract of a0', 'abstract of a1', 'abstract of a2', 'abstract of a3', 'abstract of a4', 'abstract of a5', 'abstract of a6'];
    expect(admittedIds.map(id => byId.get(id))).toEqual(ordered);
    expect([...calls].sort()).toEqual([...ordered].sort());
  });

  it('same-stamp ties within a memory resolve deterministically by node id', async () => {
    const memA = await makeMemory('a');
    const same = new Date(Date.now() - 60_000);
    const nodes = [await makeDueNode(memA, 't0', same), await makeDueNode(memA, 't1', same),
      await makeDueNode(memA, 't2', same)];
    const expected = [...nodes].sort((x, y) => (x.id < y.id ? -1 : 1)).map((n) => n.abstract);

    const { client, calls } = probeClient();
    await drainEmbeddingQueue(db, { batchSize: 10, client });
    expect(admittedIds).toEqual([...nodes].sort((x, y) => x.id < y.id ? -1 : 1).map(n => n.id));
    expect([...calls].sort()).toEqual([...expected].sort());
  });

  it('never selects a FUTURE-dated backoff retry to manufacture fairness', async () => {
    const memA = await makeMemory('a');
    const memB = await makeMemory('b');
    const old = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 30; i++) await makeDueNode(memA, `a${i}`, new Date(old.getTime() + i));
    const backedOff = await makeDueNode(memB, 'b-backoff', new Date(Date.now() + 60_000));

    const { client, calls } = probeClient();
    const r = await drainEmbeddingQueue(db, { batchSize: 10, client });
    expect(r.embedded).toBe(10);
    expect(calls).not.toContain(backedOff.abstract);
    const row = await db.node.findUniqueOrThrow({ where: { id: backedOff.id } });
    expect(row.embeddingPendingAt).not.toBeNull(); // schedule untouched
  });

  it('a transient failure future-dates its node and does not block the rest of the batch', async () => {
    const memA = await makeMemory('a');
    const memB = await makeMemory('b');
    const old = new Date(Date.now() - 3_600_000);
    const a0 = await makeDueNode(memA, 'a0', old);
    await makeDueNode(memA, 'a1', new Date(old.getTime() + 1));
    const bNode = await makeDueNode(memB, 'b0', new Date());

    const { client, calls } = probeClient({ failAbstracts: new Set([a0.abstract]) });
    const r = await drainEmbeddingQueue(db, { batchSize: 5, client });
    expect(r.failed).toBe(1);
    expect(r.embedded).toBe(2);
    expect(calls).toContain(bNode.abstract); // B served in the same batch
    const a0row = await db.node.findUniqueOrThrow({ where: { id: a0.id } });
    expect(a0row.embeddingPendingAt).not.toBeNull(); // backoff retained
    expect(a0row.embeddingPendingAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('a PERMANENT-class failure leaves the queue, records the error, and frees the slot', async () => {
    const { EmbeddingRequestError } = await import('../lib/embedding/index.js');
    const memA = await makeMemory('a');
    const memB = await makeMemory('b');
    const old = new Date(Date.now() - 3_600_000);
    const a0 = await makeDueNode(memA, 'a0', old);
    const bNode = await makeDueNode(memB, 'b0', new Date(old.getTime() + 1));

    const calls: string[] = [];
    let next = 0;
    const client: EmbeddingClient = {
      provider: 'test',
      model: 'perm-stub',
      dim: DIM,
      async embed(texts: string[]) {
        calls.push(...texts);
        if (texts.includes(a0.abstract)) {
          throw new EmbeddingRequestError('HTTP 413 from stub', { retryable: false });
        }
        return texts.map(() => oneHot(next++));
      },
    };
    const r = await drainEmbeddingQueue(db, { batchSize: 5, client });
    expect(r.failed).toBe(1);
    expect(r.embedded).toBe(1);
    expect(calls).toContain(bNode.abstract);
    const a0row = await db.node.findUniqueOrThrow({ where: { id: a0.id } });
    expect(a0row.embeddingPendingAt).toBeNull(); // out of the queue
    expect(a0row.embeddingFailedAt).not.toBeNull(); // record kept
  });

  it('stale-version latest-wins: a re-stamp during the embed skips the stale write', async () => {
    const memB = await makeMemory('b');
    const bNode = await makeDueNode(memB, 'b0', new Date(Date.now() - 60_000));

    let next = 0;
    const client: EmbeddingClient = {
      provider: 'test',
      model: 'stale-stub',
      dim: DIM,
      async embed(texts: string[]) {
        // A newer write re-stamps the marker while this embed is in
        // flight — the upsert's captured-stamp guard must refuse to write.
        await db.node.update({
          where: { id: bNode.id },
          data: { embeddingPendingAt: new Date(), embeddingWorkToken: randomUUID() },
        });
        return texts.map(() => oneHot(next++));
      },
    };
    const r = await drainEmbeddingQueue(db, { batchSize: 5, client });
    expect(r.skipped).toBe(1);
    const rows = await db.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM node_embeddings WHERE node_id = ${bNode.id}`;
    expect(Number(rows[0].c)).toBe(0); // the stale vector never landed
    const row = await db.node.findUniqueOrThrow({ where: { id: bNode.id } });
    expect(row.embeddingPendingAt).not.toBeNull(); // fresh stamp owns the node
  });

  it("an unindexed memory's due node is excluded without an admitted pipeline", async () => {
    const memPlain = await makeMemory('plain', false);
    const memB = await makeMemory('b');
    const plainNode = await makeDueNode(memPlain, 'p0', new Date(Date.now() - 3_600_000));
    const bNode = await makeDueNode(memB, 'b0', new Date());

    const { client, calls } = probeClient();
    const r = await drainEmbeddingQueue(db, { batchSize: 5, client });
    expect(r.skipped).toBe(0);
    expect(r.embedded).toBe(1);
    expect(calls).not.toContain(plainNode.abstract);
    expect(calls).toContain(bNode.abstract);
    const row = await db.node.findUniqueOrThrow({ where: { id: plainNode.id } });
    expect(row.embeddingPendingAt).not.toBeNull(); // excluded in SQL; no pipeline or marker mutation
  });

  it('a soft-deleted due node is excluded (marker retained) and does not block others', async () => {
    const memA = await makeMemory('a');
    const memB = await makeMemory('b');
    const gone = await makeDueNode(memA, 'gone', new Date(Date.now() - 3_600_000));
    await db.node.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const bNode = await makeDueNode(memB, 'b0', new Date());

    const { client, calls } = probeClient();
    const r = await drainEmbeddingQueue(db, { batchSize: 5, client });
    expect(r.skipped).toBe(0);
    expect(r.embedded).toBe(1);
    expect(calls).toContain(bNode.abstract);
    const row = await db.node.findUniqueOrThrow({ where: { id: gone.id } });
    // Parity with the pre-fairness drain: embedNode skips deleted rows
    // without clearing the marker (a pre-existing wart, unchanged here).
    expect(row.embeddingPendingAt).not.toBeNull();
  });
});
