import { withIncludeHistoryClientTransaction } from '../../lib/includes/includeHistoryFence.js';
/** #1460: reviving a node must not publish vectors from its prior incarnation. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { toVectorLiteral, upsertAbstractVector, vectorSearchChunks, vectorSearchNodes } from '../../services/embedding/vectors.js';
import { writeNodeCore } from '../../api/graphql/schema/resolvers.mutation.node.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../../mcp/server.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const query = [1, ...new Array(767).fill(0)];
let memory: { id: string; urn: string };
let nodeId: string;
let adminId: string;
const oldPendingAt = new Date('2026-01-01T00:00:00.000Z');

beforeEach(async () => {
  vi.stubEnv('EMBEDDING_BACKEND', 'http');
  vi.stubEnv('EMBEDDING_API_URL', '');
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'revival-vector-org', urn: 'revival-vector-org' } });
  const admin = await db.user.create({ data: { githubId: 14601, githubUsername: 'revival-vector-admin', roles: ['ADMIN'] } });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'revival-vector-org:kb', name: 'kb', class: 'knowledge', vectorIndexEnabled: true },
  });
  const node = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'reused', name: 'Old', abstract: 'old summary', content: 'old secret text', embeddingPendingAt: oldPendingAt },
  });
  nodeId = node.id;
  const vector = toVectorLiteral(query);
  await db.$executeRaw`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, embedding)
    VALUES (${generateId()}, ${nodeId}, ${memory.id}, 'abstract', 'test', 'test', 768, ${vector}::vector)
  `;
  await db.$executeRaw`
    INSERT INTO node_embeddings (id, node_id, memory_id, kind, provider, model, dim, chunk_index, char_start, char_end, chunk_text, embedding)
    VALUES (${generateId()}, ${nodeId}, ${memory.id}, 'chunk', 'test', 'test', 768, 0, 0, 15, 'old secret text', ${vector}::vector)
  `;
  await db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date(), deletedBy: adminId } });
  expect(await vectorSearchChunks(db, { memoryIds: [memory.id], queryEmbedding: query, limit: 5 })).toEqual([]);
});

afterAll(() => vi.unstubAllEnvs());

async function expectOldVectorsGone() {
  expect(await vectorSearchChunks(db, { memoryIds: [memory.id], queryEmbedding: query, limit: 5 })).toEqual([]);
  expect(await vectorSearchNodes(db, { memoryIds: [memory.id], queryEmbedding: query, limit: 5 })).toEqual([]);
  expect(await db.nodeEmbedding.count({ where: { nodeId } })).toBe(0);
  const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  expect(node.deletedAt).toBeNull();
  expect(node.content).toBe('replacement only');
}

describe('revival clears prior vectors without an embedding endpoint', () => {
  it('GraphQL create mode', async () => {
    const ctx: Context = { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` };
    const revived = await writeNodeCore({ memoryId: memory.id, loc: 'reused', name: 'New', content: 'replacement only' }, ctx, 'create');
    expect(revived.id).toBe(nodeId);
    await expectOldVectorsGone();
  });

  it('MCP hadron_create_node', async () => {
    const server = createTestableMcpServer({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
    const text = await server.callToolText('hadron_create_node', {
      urn: `hrn:node:${memory.urn}:reused`, name: 'New', content: 'replacement only',
    });
    expect(text).toMatch(/Node saved/);
    await expectOldVectorsGone();
  });

  it('does not queue embedding when GraphQL revives in an unindexed memory', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: false } });
    const ctx: Context = { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` };
    await writeNodeCore({ memoryId: memory.id, loc: 'reused', name: 'New', content: 'replacement only' }, ctx, 'create');
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).embeddingPendingAt).toBeNull();
    await expectOldVectorsGone();
  });

  it('does not queue embedding when MCP revives in an unindexed memory', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: false } });
    const server = createTestableMcpServer({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
    const text = await server.callToolText('hadron_create_node', {
      urn: `hrn:node:${memory.urn}:reused`, name: 'New', content: 'replacement only',
    });
    expect(text).toMatch(/Node saved/);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).embeddingPendingAt).toBeNull();
    await expectOldVectorsGone();
  });

  it('invalidates an in-flight old embed before post-commit scheduling', async () => {
    const ctx: Context = { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` };
    const effects: Array<() => void> = [];
    await withIncludeHistoryClientTransaction(db, (tx) => writeNodeCore(
      { memoryId: memory.id, loc: 'reused', name: 'New', content: 'replacement only' },
      ctx, 'create', { transaction: { tx, pooledDb: db, afterCommit: (effect) => effects.push(effect) } },
    ));
    const staleWrite = await upsertAbstractVector(db, {
      nodeId, memoryId: memory.id, provider: 'old-worker', model: 'old', dim: 768, embedding: query,
    }, oldPendingAt);
    expect(staleWrite).toBe(false);
    await expectOldVectorsGone();
    // Hold the normal after-commit wake so this pins the committed state before
    // the asynchronous enqueuer can stamp a newer marker on its own.
    expect(effects).toHaveLength(1);
  });

  it('rejects an old abstract insert that began while revival held the node lock', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const newPendingAt = new Date('2026-09-29T00:00:00.000Z');
    const reviving = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${nodeId} FOR UPDATE`;
      await tx.nodeEmbedding.deleteMany({ where: { nodeId } });
      await tx.node.update({
        where: { id: nodeId },
        data: { deletedAt: null, deletedBy: null, embeddingPendingAt: newPendingAt, content: 'replacement only' },
      });
      signalLocked();
      await held;
    });
    await locked;
    const staleWrite = upsertAbstractVector(db, {
      nodeId, memoryId: memory.id, provider: 'old-worker', model: 'old', dim: 768, embedding: query,
    }, oldPendingAt);
    let lockError: unknown;
    try {
      // Wait until the old writer is actually blocked inside Postgres. This
      // proves its statement began before the revival transaction committed.
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [{ waiting }] = await db.$queryRaw<Array<{ waiting: bigint }>>`
          SELECT count(*)::bigint AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%INSERT INTO node_embeddings%'
        `;
        if (waiting > 0n) break;
        if (Date.now() > deadline) throw new Error('old abstract writer did not reach a database lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) {
      lockError = error;
    } finally {
      release();
    }
    await reviving;
    const wrote = await staleWrite;
    if (lockError) throw lockError;
    expect(wrote).toBe(false);
    await expectOldVectorsGone();
  }, 15_000);

  it('a refused create over a live node leaves its vectors intact', async () => {
    await db.node.update({ where: { id: nodeId }, data: { deletedAt: null, deletedBy: null } });
    const ctx: Context = { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` };
    await expect(writeNodeCore({ memoryId: memory.id, loc: 'reused', name: 'New' }, ctx, 'create'))
      .rejects.toMatchObject({ extensions: { code: 'NodeLocConflictError' } });
    expect(await db.nodeEmbedding.count({ where: { nodeId } })).toBe(2);
  });
});
