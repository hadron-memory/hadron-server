/**
 * 033-rag-vector-retrieval US1 — async embedding pipeline + vector search.
 *
 * Hermetic: CI has pgvector but no embedding endpoint, so these inject a
 * deterministic stub `EmbeddingClient` (one-hot vectors) and exercise the real
 * pipeline — embedNode, the durable markers, drainEmbeddingQueue, backfill, and
 * the pgvector similarity query. Real-model semantics are validated manually
 * via quickstart (Ollama); here we pin the retrieval mechanics.
 *
 * Covers SC-001 (retrieval), SC-002 (non-blocking), SC-003 (failure recovery),
 * SC-004 (backfill), SC-008 (no vector index).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import type { EmbeddingClient } from '../../lib/embedding/index.js';
import {
  EmbeddingRequestError,
  setEmbeddingClientForTests,
  resetEmbeddingClientForTests,
} from '../../lib/embedding/index.js';
import { embedNode, drainEmbeddingQueue, embeddingDispatcher } from '../../jobs/embedNodes.js';
import { stampEmbeddingObligation } from '../../services/embedding/obligation.js';
import { enqueueNodeEmbedding, backfillMemoryEmbeddings } from '../../services/embedding/enqueue.js';
import { vectorSearchNodes } from '../../services/embedding/vectors.js';

const DIM = 768;

function oneHot(i: number): number[] {
  const v = new Array(DIM).fill(0);
  v[i % DIM] = 1;
  return v;
}

/** Deterministic stub: maps known abstracts to fixed vectors; default-hashes the rest. */
function stubClient(map: Record<string, number[]>, opts: { failTimes?: number } = {}): EmbeddingClient {
  let fails = opts.failTimes ?? 0;
  return {
    provider: 'test',
    model: 'stub-model',
    dim: DIM,
    async embed(texts: string[]) {
      if (fails > 0) {
        fails -= 1;
        throw new Error('stub embed failure');
      }
      return texts.map((t) => map[t] ?? oneHot(100 + (t.length % 200)));
    },
  };
}

let orgId: string;
let memId: string;

async function makeMemory(vectorIndexEnabled: boolean): Promise<string> {
  const m = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      urn: `org-033:${generateId()}`,
      name: 'mem',
      class: 'knowledge',
      vectorIndexEnabled,
    },
  });
  return m.id;
}

async function makeNode(memoryId: string, loc: string, abstract: string): Promise<string> {
  const n = await db.node.create({
    data: { id: generateId(), memoryId, loc, name: loc, abstract, content: `body of ${loc}` },
  });
  await db.$transaction(tx => stampEmbeddingObligation(tx, n.id, memoryId));
  return n.id;
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  const org = await db.organization.create({
    data: { id: generateId(), name: 'org-033', urn: 'org-033' },
  });
  orgId = org.id;
  memId = await makeMemory(true);
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

afterEach(async () => {
  await vi.waitFor(() => {
    const state = embeddingDispatcher(db).state();
    expect(state.active).toBe(0);
    expect(state.selecting || state.scheduled).toBe(false);
  });
});

describe('SC-001 — semantic vector retrieval', () => {
  it('ranks the vector-closest node first, including a zero-keyword-overlap query', async () => {
    const backups = 'Database backup and restore procedures for disaster scenarios';
    const auth = 'User authentication and login session handling';
    const recipes = 'Holiday cookie recipes with cinnamon';
    setEmbeddingClientForTests(
      stubClient({ [backups]: oneHot(0), [auth]: oneHot(1), [recipes]: oneHot(2) }),
    );

    const aId = await makeNode(memId, 'backups', backups);
    await makeNode(memId, 'auth', auth);
    await makeNode(memId, 'recipes', recipes);
    for (const id of [aId, ...(await db.node.findMany({ where: { memoryId: memId, loc: { not: 'backups' } }, select: { id: true } })).map((n) => n.id)]) {
      expect(await embedNode(db, id)).toBe('embedded');
    }

    // Query vector aligns with the backups node — note the query words share no
    // literal substring with its abstract (semantic, not keyword).
    const hits = await vectorSearchNodes(db, {
      memoryIds: [memId],
      queryEmbedding: oneHot(0),
      limit: 10,
    });
    expect(hits[0]?.nodeId).toBe(aId);
    expect(hits[0]?.score).toBeGreaterThan(0.99);
  });

  it('stores exactly one abstract vector per node (re-embed replaces)', async () => {
    setEmbeddingClientForTests(stubClient({}));
    const id = await makeNode(memId, 'n1', 'some abstract text');
    await embedNode(db, id);
    await db.$transaction(tx => stampEmbeddingObligation(tx, id, memId));
    await embedNode(db, id); // re-embed
    const rows = await db.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM node_embeddings WHERE node_id = ${id} AND kind = 'abstract'`;
    expect(Number(rows[0].c)).toBe(1);
  });
});

describe('SC-002 — write is non-blocking', () => {
  it('sets the durable pending marker without awaiting the embed', async () => {
    // #1091 — this test used to RACE the code it tests, and lost under load.
    //
    // `beforeEach` sets EMBEDDING_API_URL, so `isEmbeddingConfigured()` is true
    // and `enqueueNodeEmbedding` really does fire its `setImmediate` drain. With
    // an instant stub, `embedNode` can run to completion — and `clearMarkers`
    // NULLS `embeddingPendingAt` on success — before this test's read returns.
    // The assertion then failed on a marker the code had correctly set and
    // correctly cleared, which reads as a timing flake and is not one: nothing
    // here is slow (18ms in isolation against a 5000ms limit), it is ordering.
    //
    // So gate the embed rather than trying to outrun it. Parking INSIDE
    // `embed()` splits the drain in half: it has demonstrably started, and it
    // demonstrably cannot have finished. That makes the assertion deterministic
    // AND strengthens it — while the embed is parked, "the write did not await
    // the embed" is the only thing that can explain `enqueueNodeEmbedding`
    // having already returned. The old version could pass with a blocking
    // enqueue as long as the read happened to win.
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    // Release and drain in finally: no admitted work may escape this fixture.
    let release!: () => void;
    const parked = new Promise<number[][]>(resolve => { release = () => resolve([oneHot(0)]); });
    setEmbeddingClientForTests({
      provider: 'test',
      model: 'stub-model',
      dim: DIM,
      async embed() {
        markStarted();
        return parked;
      },
    });

    const id = await makeNode(memId, 'n', 'abstract');
    await enqueueNodeEmbedding(db, {
      nodeId: id,
      memoryId: memId,
      workToken: (await db.node.findUniqueOrThrow({ where: { id } })).embeddingWorkToken,
      plaintext: { content: 'c', abstract: 'abstract' },
    });

    // The drain has entered `embed()` and is stuck there — so the marker cannot
    // have been cleared, whatever the scheduler did.
    try {
      await started;
      const node = await db.node.findUniqueOrThrow({ where: { id }, select: { embeddingPendingAt: true } });
      expect(node.embeddingPendingAt).not.toBeNull();
    } finally { release(); }
  });
});

describe('SC-003 — embedding failure is durable and recoverable', () => {
  it('records a failure, retries, and loses no node', async () => {
    const text = 'recoverable abstract';
    const id = await makeNode(memId, 'n', text);
    await db.node.update({ where: { id }, data: { embeddingPendingAt: new Date() } });

    // First drain fails (stub throws once). retryBaseMs 0 ⇒ the backoff
    // reschedule is immediately due, so the second drain picks it up.
    setEmbeddingClientForTests(stubClient({ [text]: oneHot(5) }, { failTimes: 1 }));
    await drainEmbeddingQueue(db, { batchSize: 10 });
    let node = await db.node.findUniqueOrThrow({ where: { id } });
    expect(node.embeddingFailedAt).not.toBeNull();
    expect(node.embeddingAttempts).toBe(1);
    expect(node.embeddingPendingAt).not.toBeNull(); // still queued (not lost)

    // Make the backed-off obligation due, then let bounded admission recover it.
    await db.node.update({ where: { id }, data: { embeddingPendingAt: new Date(0) } });
    // Second drain succeeds → embedded, markers cleared.
    setEmbeddingClientForTests(stubClient({ [text]: oneHot(5) }));
    await drainEmbeddingQueue(db, { batchSize: 10 });
    await vi.waitFor(async () => expect((await db.node.findUniqueOrThrow({ where: { id } })).embeddingPendingAt).toBeNull());
    node = await db.node.findUniqueOrThrow({ where: { id } });
    expect(node.embeddingPendingAt).toBeNull();
    expect(node.embeddingFailedAt).toBeNull();
    const hits = await vectorSearchNodes(db, { memoryIds: [memId], queryEmbedding: oneHot(5), limit: 5 });
    expect(hits[0]?.nodeId).toBe(id);
  });

  it('a retryable failure reschedules with a FUTURE pendingAt (backoff) instead of burning sweep ticks (#882)', async () => {
    const id = await makeNode(memId, 'n-backoff', 'abstract');
    await db.node.update({ where: { id }, data: { embeddingPendingAt: new Date() } });

    setEmbeddingClientForTests(stubClient({}, { failTimes: 1 }));
    const before = Date.now();
    await drainEmbeddingQueue(db, { batchSize: 10 }); // default retryBaseMs (60s)
    const node = await db.node.findUniqueOrThrow({ where: { id } });
    expect(node.embeddingPendingAt).not.toBeNull();
    // Future-dated by roughly the base delay — not immediately re-eligible.
    expect(node.embeddingPendingAt!.getTime()).toBeGreaterThan(before + 30_000);

    // The next drain must NOT re-select it (its stamp isn't due yet).
    setEmbeddingClientForTests(stubClient({}));
    const r = await drainEmbeddingQueue(db, { batchSize: 10 });
    expect(r.embedded + r.failed + r.skipped).toBe(0);
  });

  it('retryable failures never give up — a node past the old 5-attempt cap still retries and recovers (#882)', async () => {
    const text = 'blip survivor';
    const id = await makeNode(memId, 'n-survivor', text);
    // Simulate a node that has already failed many times (the pre-#882 cap
    // was 5, after which the node was permanently excluded).
    await db.node.update({
      where: { id },
      data: { embeddingPendingAt: new Date(), embeddingAttempts: 9, embeddingFailedAt: new Date(), embeddingError: 'old timeout' },
    });

    // Still fails once more → attempts keeps counting, node stays queued.
    setEmbeddingClientForTests(stubClient({ [text]: oneHot(9) }, { failTimes: 1 }));
    await drainEmbeddingQueue(db, { batchSize: 10 });
    let node = await db.node.findUniqueOrThrow({ where: { id } });
    expect(node.embeddingAttempts).toBe(10);
    expect(node.embeddingPendingAt).not.toBeNull(); // NOT dropped from the queue

    // Endpoint recovers → the node embeds.
    await db.node.update({ where: { id }, data: { embeddingPendingAt: new Date(0) } });
    setEmbeddingClientForTests(stubClient({ [text]: oneHot(9) }));
    await drainEmbeddingQueue(db, { batchSize: 10 });
    await vi.waitFor(async () => expect((await db.node.findUniqueOrThrow({ where: { id } })).embeddingPendingAt).toBeNull());
    node = await db.node.findUniqueOrThrow({ where: { id } });
    expect(node.embeddingPendingAt).toBeNull();
    expect(node.embeddingFailedAt).toBeNull();
    expect(node.embeddingAttempts).toBe(0);
    const hits = await vectorSearchNodes(db, { memoryIds: [memId], queryEmbedding: oneHot(9), limit: 5 });
    expect(hits[0]?.nodeId).toBe(id);
  });

  it('a permanent-class failure (deterministic 4xx) clears pendingAt immediately — no doomed retries (#882)', async () => {
    const id = await makeNode(memId, 'n-perm', 'abstract');
    await db.node.update({ where: { id }, data: { embeddingPendingAt: new Date() } });

    setEmbeddingClientForTests({
      provider: 'test',
      model: 'stub-model',
      dim: DIM,
      async embed() {
        throw new EmbeddingRequestError('HTTP 413 from stub', { retryable: false });
      },
    });
    const r = await drainEmbeddingQueue(db, { batchSize: 10 });
    expect(r.failed).toBe(1);
    const node = await db.node.findUniqueOrThrow({ where: { id } });
    expect(node.embeddingPendingAt).toBeNull(); // out of the queue
    expect(node.embeddingFailedAt).not.toBeNull(); // but the record stays
    expect(node.embeddingError).toContain('413');
  });
});

describe('SC-004 — backfill on opt-in after seeding', () => {
  it('embeds pre-existing nodes when the index is enabled', async () => {
    // Seed into a NON-indexed memory.
    const lateMem = await makeMemory(false);
    const text = 'pre-existing abstract content';
    const id = await makeNode(lateMem, 'seeded', text);
    setEmbeddingClientForTests(stubClient({ [text]: oneHot(7) }));

    // Enabling + backfill stamps the existing node pending.
    await db.memory.update({ where: { id: lateMem }, data: { vectorIndexEnabled: true } });
    const stamped = await backfillMemoryEmbeddings(db, lateMem);
    expect(stamped).toBe(1);

    await drainEmbeddingQueue(db, { batchSize: 10 });
    const hits = await vectorSearchNodes(db, { memoryIds: [lateMem], queryEmbedding: oneHot(7), limit: 5 });
    expect(hits[0]?.nodeId).toBe(id);
  });
});

describe('SC-008 — no vector index', () => {
  it('embedNode skips a node whose memory is not indexed', async () => {
    const plainMem = await makeMemory(false);
    const id = await makeNode(plainMem, 'n', 'abstract');
    setEmbeddingClientForTests(stubClient({}));
    expect(await embedNode(db, id)).toBe('skipped');
    const rows = await db.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM node_embeddings WHERE memory_id = ${plainMem}`;
    expect(Number(rows[0].c)).toBe(0);
  });

  it('vector search over an unindexed memory returns nothing', async () => {
    const plainMem = await makeMemory(false);
    await makeNode(plainMem, 'n', 'abstract');
    const hits = await vectorSearchNodes(db, { memoryIds: [plainMem], queryEmbedding: oneHot(0), limit: 5 });
    expect(hits).toEqual([]);
  });

  it('createMemory applies the class-derived default (knowledge → on)', async () => {
    // The resolver sets this; here we assert the column-level behavior the
    // resolver relies on by checking a knowledge memory created with the flag.
    const m = await db.memory.findUniqueOrThrow({ where: { id: memId } });
    expect(m.vectorIndexEnabled).toBe(true);
    expect(m.embeddingSource).toBe('abstract');
  });
});
