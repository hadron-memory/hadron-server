/**
 * #1025 — concurrent re-embeds of one node must not corrupt its vectors.
 *
 * Both failures these tests pin were found in production, on the specs corpus,
 * and neither announced itself at the write site:
 *
 *   - the ABSTRACT path was a DELETE-then-INSERT pair, not an upsert, racing
 *     the partial unique `node_embeddings_abstract_uniq (node_id) WHERE kind =
 *     'abstract'`. The loser failed 23505 and the node was left flagged
 *     `embedding_failed_at` and absent from vector search — which reads
 *     identically to "no hits matched";
 *   - the CHUNK path fails the same way, on the composite unique
 *     (node_id, kind, chunk_index). The second writer's DELETE removes only
 *     what was in its own statement snapshot — the first writer's brand-new
 *     rows were never in it — so its insert of chunk_index 0 collides.
 *
 * The races are driven for real — two overlapping writers against the same
 * node — rather than asserting the SQL text. A test that only called each
 * function once would have passed against the broken code.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import {
  upsertAbstractVector,
  upsertChunkVectors,
  type ChunkVectorRow,
} from './vectors.js';

const DIM = 768;
/** A distinguishable unit vector, so we can tell whose write survived. */
const vec = (slot: number): number[] => {
  const v = new Array(DIM).fill(0);
  v[slot % DIM] = 1;
  return v;
};

let memId: string;
let nodeId: string;

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'vec-race-org', graphName: 'vec/race' });
  memId = made.graph.id;
  await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: true } });
  nodeId = generateId();
  await db.node.create({
    data: { id: nodeId, memoryId: memId, loc: 'race.target', name: 'race target' },
  });
});

/**
 * `node_embeddings.kind` is a Postgres ENUM, so a bound parameter arrives as
 * text and needs the explicit cast — the production writes sidestep this by
 * using SQL literals.
 */
const countKind = async (kind: 'abstract' | 'chunk'): Promise<number> => {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM node_embeddings
    WHERE node_id = ${nodeId} AND kind = ${kind}::"EmbeddingKind"`;
  return Number(rows[0].n);
};

const abstractRow = (slot: number) => ({
  nodeId,
  memoryId: memId,
  provider: 'test',
  model: `stub-${slot}`,
  dim: DIM,
  embedding: vec(slot),
});

const chunkRows = (slots: number[]): ChunkVectorRow[] =>
  slots.map((slot, i) => ({
    nodeId,
    memoryId: memId,
    provider: 'test',
    model: `stub-${slot}`,
    dim: DIM,
    chunkIndex: i,
    charStart: i * 10,
    charEnd: i * 10 + 10,
    chunkText: `chunk-${slot}-${i}`,
    embedding: vec(slot),
  }));

describe('#1025 — upsertAbstractVector', () => {
  it('is idempotent: writing twice leaves exactly one row', async () => {
    await upsertAbstractVector(db, abstractRow(1));
    await upsertAbstractVector(db, abstractRow(2));

    expect(await countKind('abstract')).toBe(1);
    const rows = await db.$queryRaw<{ model: string }[]>`
      SELECT model FROM node_embeddings WHERE node_id = ${nodeId} AND kind = 'abstract'`;
    expect(rows[0].model).toBe('stub-2'); // last write wins, in place
  });

  it('survives CONCURRENT re-embeds without a unique violation', async () => {
    // The reported failure: a write-path re-embed interleaving with the
    // embedding_pending_at sweep for the same node. Before the fix one of
    // these rejected 23505 and the node dropped out of vector search.
    const writers = [1, 2, 3, 4, 5, 6].map((slot) => upsertAbstractVector(db, abstractRow(slot)));
    await expect(Promise.all(writers)).resolves.toBeDefined();

    expect(await countKind('abstract')).toBe(1);
  });

  it('leaves the node with a vector at every moment (no delete window)', async () => {
    // The transaction the old implementation needed existed to protect this;
    // an upserting statement has no window to protect, because the row is
    // overwritten rather than removed and re-added.
    await upsertAbstractVector(db, abstractRow(1));

    const observations: number[] = [];
    const writer = (async () => {
      for (let i = 2; i < 12; i++) await upsertAbstractVector(db, abstractRow(i));
    })();
    const reader = (async () => {
      for (let i = 0; i < 20; i++) observations.push(await countKind('abstract'));
    })();
    await Promise.all([writer, reader]);

    expect(observations).not.toContain(0);
  });
});

describe('#1025 — upsertChunkVectors', () => {
  it('replaces the whole chunk set rather than accumulating', async () => {
    await upsertChunkVectors(db, nodeId, chunkRows([1, 1, 1]));
    expect(await countKind('chunk')).toBe(3);

    await upsertChunkVectors(db, nodeId, chunkRows([2, 2]));
    expect(await countKind('chunk')).toBe(2);
  });

  it('CONCURRENT rebuilds leave exactly one set, not both merged', async () => {
    // Without serialization the second writer's DELETE misses the first
    // writer's just-inserted rows, and its own insert then collides with them
    // on (node_id, kind, chunk_index) — the whole rebuild fails 23505.
    await Promise.all([
      upsertChunkVectors(db, nodeId, chunkRows([1, 1, 1, 1])),
      upsertChunkVectors(db, nodeId, chunkRows([2, 2, 2, 2])),
    ]);

    expect(await countKind('chunk')).toBe(4);

    // And the surviving set is internally consistent — one writer's, not a mix.
    const rows = await db.$queryRaw<{ model: string }[]>`
      SELECT model FROM node_embeddings WHERE node_id = ${nodeId} AND kind = 'chunk'`;
    expect(new Set(rows.map((r) => r.model)).size).toBe(1);
  });

  it('an empty set clears the chunks', async () => {
    await upsertChunkVectors(db, nodeId, chunkRows([1, 1]));
    await upsertChunkVectors(db, nodeId, []);
    expect(await countKind('chunk')).toBe(0);
  });
});
