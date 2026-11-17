/**
 * 033-rag-vector-retrieval — DB-invariant regression tests (T016, constitution S5).
 *
 * The vector-index config invariants are backstopped by Postgres CHECK
 * constraints (not just app logic), and the "one abstract vector per node"
 * rule by a partial unique index that the Prisma `@@unique` can't express.
 * These tests pin that the structural backstops are actually present on the
 * test DB (built via pre-push.sql + `db push` + post-push.sql; #434 removed globalSetup's copy).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

let orgId: string;
let seq = 0;

function memoryData(overrides: Record<string, unknown>) {
  seq += 1;
  return {
    id: generateId(),
    organizationId: orgId,
    urn: `org-033:mem-${seq}`,
    name: `mem-${seq}`,
    class: 'knowledge' as const, // app_id stays NULL (chk_memory_class_app_id)
    ...overrides,
  };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'org-033', urn: 'org-033' },
  });
  orgId = org.id;
});

describe('chk_memory_vector_encrypted_ack (FR-026)', () => {
  it('rejects enabling the index on an encrypted memory without acknowledgment', async () => {
    await expect(
      db.memory.create({
        data: memoryData({
          isEncrypted: true,
          vectorIndexEnabled: true,
          vectorIndexEncryptedAckAt: null,
        }),
      }),
    ).rejects.toThrow();
  });

  it('allows an encrypted indexed memory once acknowledged', async () => {
    const mem = await db.memory.create({
      data: memoryData({
        isEncrypted: true,
        vectorIndexEnabled: true,
        vectorIndexEncryptedAckAt: new Date(),
      }),
    });
    expect(mem.vectorIndexEnabled).toBe(true);
    expect(mem.vectorIndexEncryptedAckAt).not.toBeNull();
  });

  it('allows a non-encrypted indexed memory without acknowledgment', async () => {
    const mem = await db.memory.create({
      data: memoryData({ isEncrypted: false, vectorIndexEnabled: true }),
    });
    expect(mem.vectorIndexEnabled).toBe(true);
  });
});

describe('chk_memory_chunk_tokens_positive / chk_memory_chunk_overlap_valid (FR-003)', () => {
  it('rejects chunkTokens <= 0', async () => {
    await expect(
      db.memory.create({ data: memoryData({ chunkTokens: 0 }) }),
    ).rejects.toThrow();
  });

  it('rejects chunkOverlap >= chunkTokens', async () => {
    await expect(
      db.memory.create({ data: memoryData({ chunkTokens: 512, chunkOverlap: 512 }) }),
    ).rejects.toThrow();
  });

  it('rejects negative chunkOverlap', async () => {
    await expect(
      db.memory.create({ data: memoryData({ chunkOverlap: -1 }) }),
    ).rejects.toThrow();
  });

  it('accepts valid chunk dials', async () => {
    const mem = await db.memory.create({
      data: memoryData({ chunkTokens: 512, chunkOverlap: 64 }),
    });
    expect(mem.chunkTokens).toBe(512);
    expect(mem.chunkOverlap).toBe(64);
  });
});

describe('node_embeddings structural backstops', () => {
  it('has the abstract partial-unique index (one abstract vector per node)', async () => {
    const rows = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'node_embeddings' AND indexname = 'node_embeddings_abstract_uniq'
    `;
    expect(rows).toHaveLength(1);
  });

  it('has the HNSW index for similarity search', async () => {
    const rows = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'node_embeddings' AND indexname = 'node_embeddings_embedding_hnsw'
    `;
    expect(rows).toHaveLength(1);
  });
});
