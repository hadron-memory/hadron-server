/**
 * Spec 039 — bus-driven embedding wake-ups (embed.wake.v1).
 *
 * What this file pins (bus module mocked — the broker transport itself is
 * pinned by src/lib/bus/bus.test.ts):
 *   - enqueueNodeEmbedding publishes a { nodeId } wake-up AFTER the durable
 *     marker stamp (PR-507 review: the wake must not ride
 *     evt.node.written.v1 — the fact event races the stamp) for
 *     vector-indexed memories and nothing otherwise; a publish failure
 *     never breaks enqueue.
 *   - backfillMemoryEmbeddings publishes an empty drain ping.
 *   - handleEmbedWake: { nodeId } embeds off the stored marker (idempotent —
 *     a cleared marker skips); a transient failure THROWS (bus nak/redelivery
 *     contract); an empty payload drains the queue to exhaustion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { EmbeddingClient } from '../lib/embedding/client.js';

const publish = vi.fn(async () => {});
let busAvailable = true;
vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => (busAvailable ? { publish } : null)),
}));

import { enqueueNodeEmbedding, backfillMemoryEmbeddings } from '../services/embedding/enqueue.js';
import { handleEmbedWake, EMBED_WAKE_SUBJECT } from './embedNodes.js';

const DIM = 768;

function fakeClient(overrides: Partial<EmbeddingClient> = {}): EmbeddingClient {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => Array<number>(DIM).fill(0.1))),
    provider: 'test',
    model: 'test-model',
    dim: DIM,
    ...overrides,
  };
}

let memoryId: string;

async function createNodeRow(loc: string, pending = true) {
  return db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc,
      name: loc,
      content: `content of ${loc}`,
      abstract: `Abstract of ${loc}.`,
      tags: [],
      ...(pending ? { embeddingPendingAt: new Date() } : {}),
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  busAvailable = true;
  process.env.EMBEDDING_API_URL = 'http://embedding.test.invalid';
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'bus-embed-org', urn: 'bus-embed-org' },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: 'busembed',
      urn: 'bus-embed-org:busembed',
      class: 'knowledge',
      vectorIndexEnabled: true,
      embeddingSource: 'abstract',
    },
  });
  memoryId = memory.id;
});

afterEach(() => {
  delete process.env.EMBEDDING_API_URL;
});

describe('publishes on the write path', () => {
  it('enqueueNodeEmbedding publishes a { nodeId } wake-up AFTER stamping the marker', async () => {
    // No endpoint for the prompt-drain in this test — delete AFTER fixture
    // setup so isEmbeddingConfigured() is false during enqueue and the
    // prompt-drain doesn't race the assertion.
    delete process.env.EMBEDDING_API_URL;
    const node = await createNodeRow('p1', false);
    // Pin the post-marker ordering (PR-507 review): at publish time the
    // durable marker must already be visible — that's the whole reason the
    // wake lives here and not on evt.node.written.v1.
    let markerAtPublish: Date | null | undefined;
    publish.mockImplementationOnce(async () => {
      const row = await db.node.findUnique({ where: { id: node.id } });
      markerAtPublish = row?.embeddingPendingAt ?? null;
    });
    await enqueueNodeEmbedding(db, { nodeId: node.id, memoryId, plaintext: {} });
    // The wake publish is void-fired; wait for the snapshot inside the mock.
    await vi.waitFor(() => expect(markerAtPublish).not.toBeUndefined());
    expect(publish).toHaveBeenCalledWith(
      EMBED_WAKE_SUBJECT,
      { nodeId: node.id },
      expect.objectContaining({ idempotencyKey: expect.stringContaining(node.id) }),
    );
    expect(markerAtPublish).not.toBeNull();
  });

  it('does not publish for a non-indexed memory', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: false } });
    const node = await createNodeRow('p2', false);
    await enqueueNodeEmbedding(db, { nodeId: node.id, memoryId, plaintext: {} });
    expect(publish).not.toHaveBeenCalled();
  });

  it('a publish failure never breaks the enqueue (marker still set)', async () => {
    delete process.env.EMBEDDING_API_URL;
    publish.mockRejectedValueOnce(new Error('broker down'));
    const node = await createNodeRow('p3', false);
    await enqueueNodeEmbedding(db, { nodeId: node.id, memoryId, plaintext: {} });
    const row = await db.node.findUnique({ where: { id: node.id } });
    expect(row?.embeddingPendingAt).not.toBeNull();
  });

  it('a drain-ping publish failure never breaks the backfill', async () => {
    publish.mockRejectedValueOnce(new Error('broker down'));
    await createNodeRow('p5', false);
    const count = await backfillMemoryEmbeddings(db, memoryId);
    expect(count).toBe(1);
  });

  it('backfillMemoryEmbeddings publishes an empty drain ping', async () => {
    await createNodeRow('p4', false);
    const count = await backfillMemoryEmbeddings(db, memoryId);
    expect(count).toBe(1);
    expect(publish).toHaveBeenCalledWith(EMBED_WAKE_SUBJECT, {}, expect.anything());
  });
});

describe('handleEmbedWake', () => {
  it('embeds a marked node and clears its marker', async () => {
    const node = await createNodeRow('w1');
    const client = fakeClient();
    await handleEmbedWake(db, { nodeId: node.id }, client);
    expect(client.embed).toHaveBeenCalled();
    const row = await db.node.findUnique({ where: { id: node.id } });
    expect(row?.embeddingPendingAt).toBeNull();
  });

  it('is idempotent: a node whose marker is already cleared skips cheaply', async () => {
    const node = await createNodeRow('w2', false);
    const client = fakeClient();
    await handleEmbedWake(db, { nodeId: node.id }, client);
    expect(client.embed).not.toHaveBeenCalled();
  });

  it('THROWS on a transient failure so the bus naks/redelivers', async () => {
    const node = await createNodeRow('w3');
    const client = fakeClient({
      embed: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    await expect(handleEmbedWake(db, { nodeId: node.id }, client)).rejects.toThrow(/transient/);
    // Attempts incremented, marker retained (retryable).
    const row = await db.node.findUnique({ where: { id: node.id } });
    expect(row?.embeddingAttempts).toBeGreaterThanOrEqual(1);
    expect(row?.embeddingPendingAt).not.toBeNull();
  });

  it('an empty payload drains the whole queue', async () => {
    const a = await createNodeRow('d1');
    const b = await createNodeRow('d2');
    const c = await createNodeRow('d3');
    const client = fakeClient();
    await handleEmbedWake(db, {}, client);
    const rows = await db.node.findMany({
      where: { id: { in: [a.id, b.id, c.id] } },
      select: { embeddingPendingAt: true },
    });
    expect(rows.every((r) => r.embeddingPendingAt === null)).toBe(true);
  });

  it('acks (no throw) when no embedding endpoint is configured', async () => {
    delete process.env.EMBEDDING_API_URL;
    const node = await createNodeRow('w4');
    await expect(handleEmbedWake(db, { nodeId: node.id })).resolves.toBeUndefined();
  });

  it('PUNTS on encrypted memories — prompt-drain owns those (Codex P2)', async () => {
    // Encrypted + vector-indexed requires the explicit ack (spec 033 US5,
    // chk_memory_vector_encrypted_ack) — set it like the portal opt-in does.
    await db.memory.update({
      where: { id: memoryId },
      data: { isEncrypted: true, vectorIndexEncryptedAckAt: new Date() },
    });
    const node = await createNodeRow('enc1');
    const client = fakeClient();
    await handleEmbedWake(db, { nodeId: node.id }, client);
    expect(client.embed).not.toHaveBeenCalled();
    // Marker retained — NOT flipped to a permanent encrypted-no-plaintext
    // failure by a wake racing the plaintext-holding prompt-drain.
    const row = await db.node.findUnique({ where: { id: node.id } });
    expect(row?.embeddingPendingAt).not.toBeNull();
    expect(row?.embeddingFailedAt).toBeNull();
  });

  it('ignores malformed payloads instead of treating them as drain pings', async () => {
    await createNodeRow('m1'); // pending — a junk-triggered drain would clear it
    const client = fakeClient();
    for (const junk of [null, 'drain', 42, ['x'], { nodeId: 123 }]) {
      await expect(handleEmbedWake(db, junk, client)).resolves.toBeUndefined();
    }
    expect(client.embed).not.toHaveBeenCalled();
    const row = await db.node.findFirst({ where: { memoryId, loc: 'm1' } });
    expect(row?.embeddingPendingAt).not.toBeNull();
  });

  it('drain ping stops on a failing FULL batch by throwing (nak → spaced continuation)', async () => {
    // 26 pending rows (> one batch of 25), client always fails transiently:
    // without the guard the loop would re-select the same failing rows
    // back-to-back and burn the 5-attempt cap in milliseconds (Gemini).
    for (let i = 0; i < 26; i++) await createNodeRow(`f${i}`);
    const failing = fakeClient({
      embed: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    await expect(handleEmbedWake(db, {}, failing)).rejects.toThrow(/nak for spaced/);
    // Exactly ONE drain round ran: every row has at most 1 attempt.
    const rows = await db.node.findMany({ where: { memoryId }, select: { embeddingAttempts: true } });
    expect(Math.max(...rows.map((r) => r.embeddingAttempts))).toBeLessThanOrEqual(1);
  });

  it('drain ping returns quietly when failures occur in a short (final) batch', async () => {
    await createNodeRow('sf1');
    const failing = fakeClient({
      embed: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    await expect(handleEmbedWake(db, {}, failing)).resolves.toBeUndefined();
  });
});
