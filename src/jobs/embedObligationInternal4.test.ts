import { beforeEach, describe, expect, it, vi } from 'vitest';
import { embedNode } from './embedNodes.js';

// Unit scope: the real worker executes against an instrumented DB/client. Vector SQL ownership
// is covered separately against the private DB, rather than claimed from these mocks.
vi.mock('../services/embedding/vectors.js', () => ({
  upsertAbstractVector: vi.fn(async () => true),
  upsertChunkVectors: vi.fn(async () => true),
  deleteNodeVectors: vi.fn(async () => {}),
  deleteNodeChunkVectors: vi.fn(async () => true),
}));
vi.mock('../lib/metering/index.js', () => ({ recordLlmUsage: vi.fn(async () => {}) }));

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const stamp = new Date('2026-10-21T00:00:00.000Z');
let row: Record<string, any>;
let database: any;
let client: any;

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    id: 'node', loc: 'test', abstract: 'current B', content: null, nodeType: 'info', deletedAt: null,
    embeddingPendingAt: stamp, embeddingWorkToken: B, embeddingAttempts: 0, commentMeta: null,
    memory: { id: 'memory', organizationId: null, vectorIndexEnabled: true, embeddingSource: 'abstract', isEncrypted: false },
  };
  database = { node: { findUnique: vi.fn(async () => row), updateMany: vi.fn(async () => ({ count: 1 })) } };
  client = { provider: 'fake', model: 'fake', dim: 1, embed: vi.fn(async () => [[1]]) };
});

describe('internal#4 captured embedding obligation identity', () => {
  it('keyless work cannot consume an encrypted obligation, even with legacy plaintext at rest', async () => {
    row.memory.isEncrypted = true;
    expect(await embedNode(database, 'node', undefined, client)).toBe('skipped');
    expect(client.embed).not.toHaveBeenCalled();
    expect(database.node.updateMany).not.toHaveBeenCalled();
  });
  it('same-millisecond prompt A cannot borrow the current row token B or spend an endpoint call', async () => {
    const outcome = await embedNode(database, 'node', { abstract: 'stale A' }, client, {
      workToken: A,
    } as any);
    expect(outcome).toBe('skipped');
    expect(client.embed).not.toHaveBeenCalled();
    expect(database.node.updateMany).not.toHaveBeenCalled();
  });

  it('an admitted current token can embed and every marker clear is conditional on that token', async () => {
    expect(await embedNode(database, 'node', { abstract: 'current B' }, client, { workToken: B } as any)).toBe('embedded');
    expect(client.embed).toHaveBeenCalledWith(['current B'], 'document');
    expect(database.node.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ embeddingWorkToken: B }),
      data: expect.objectContaining({ embeddingPendingAt: null, embeddingWorkToken: null }),
    }));
  });

  it('an unreconciled runnable null-token row does not silently become a timestamp-only attempt', async () => {
    row.embeddingWorkToken = null;
    expect(await embedNode(database, 'node', undefined, client)).toBe('skipped');
    expect(client.embed).not.toHaveBeenCalled();
    expect(database.node.updateMany).not.toHaveBeenCalled();
  });

  it('a transient failure rotates identity and keeps its durable future retry obligation', async () => {
    client.embed.mockRejectedValueOnce(new Error('synthetic transient'));
    expect(await embedNode(database, 'node', undefined, client, { workToken: B } as any)).toBe('failed-transient');
    const update = database.node.updateMany.mock.calls[0][0];
    expect(update.where.embeddingWorkToken).toBe(B);
    expect(update.data.embeddingWorkToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(update.data.embeddingWorkToken).not.toBe(B);
    expect(update.data.embeddingPendingAt.getTime()).toBeGreaterThan(Date.now());
  });
});
