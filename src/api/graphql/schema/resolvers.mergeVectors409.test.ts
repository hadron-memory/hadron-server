import { randomUUID } from 'node:crypto';
/** #409: merge relocation must revoke the source's vector capability atomically. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { mergeMemoryGraph } from '../../../controller/operations/mergeMemories.js';
import { upsertAbstractVector, upsertChunkVectors, vectorSearchChunks, vectorSearchNodes } from '../../../services/embedding/vectors.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const q = [1, ...new Array(767).fill(0)];
let source: { id: string }; let target: { id: string }; let actorId: string; let readerId: string;
const oldStamp = new Date('2026-01-01T00:00:00.000Z');
const ctx = (): Context => ({ db, userId: actorId, roles: ['ADMIN'] });
async function seed(loc = 'relocate', nodeType = 'info') {
  const comment = nodeType === 'comment' ? await resolvers.Mutation.createComment({}, { targetRef: (await db.node.create({ data: { id: generateId(), memoryId: source.id, loc: 'comment-target', name: 'target' } })).id, body: 'old comment' }, ctx()) : null;
  const data = { memoryId: source.id, loc: comment?.loc ?? loc, name: loc, nodeType,
    content: 'source secret payload', abstract: 'destination summary', embeddingWorkToken: randomUUID(), embeddingPendingAt: oldStamp,
    embeddingFailedAt: oldStamp, embeddingAttempts: 8, embeddingError: 'old retry' };
  const node = comment ? await db.node.update({ where: { id: comment.id }, data }) : await db.node.create({ data: { id: generateId(), ...data } });
  await upsertAbstractVector(db, { nodeId: node.id, memoryId: source.id, provider: 'test', model: 'test', dim: 768, embedding: q });
  await upsertChunkVectors(db, node.id, [{ nodeId: node.id, memoryId: source.id, provider: 'test', model: 'test', dim: 768,
    chunkIndex: 0, charStart: 0, charEnd: 21, chunkText: 'source secret payload', embedding: q }]);
  return node;
}
const rawMerge = (database = db) => mergeMemoryGraph(database, { sourceMemoryId: source.id, targetMemoryId: target.id,
  fields: new Set(['CONTENT']), deleteSourceMem: false, editor: { userId: actorId, info: null } });
const vectorOpts = () => ({ memoryIds: [source.id], queryEmbedding: q, limit: 10 });

beforeEach(async () => {
  vi.stubEnv('EMBEDDING_API_URL', '');
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), urn: 'merge409', name: 'merge' } });
  actorId = (await db.user.create({ data: { id: generateId(), handle: 'merge409-admin', roles: ['ADMIN'] } })).id;
  readerId = (await db.user.create({ data: { id: generateId(), handle: 'merge409-reader', roles: ['READER'] } })).id;
  await db.orgMember.createMany({ data: [{ userId: actorId, organizationId: org.id, role: 'ADMIN' }, { userId: readerId, organizationId: org.id, role: 'READER' }] });
  source = await db.memory.create({ data: { id: generateId(), urn: 'merge409:source', name: 'source', organizationId: org.id,
    class: 'knowledge', visibility: 'ORGANIZATION', vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
  const foreign = await db.organization.create({ data: { id: generateId(), urn: 'destination409', name: 'destination' } });
  target = await db.memory.create({ data: { id: generateId(), urn: 'destination409:target', name: 'target', organizationId: foreign.id,
    class: 'knowledge', visibility: 'ORGANIZATION', vectorIndexEnabled: false, embeddingSource: 'abstract' } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetEmbeddingClientForTests(); });

describe('#409 merge vector isolation', () => {
  it.each([false, true])('purges source vectors inside the relocation commit (target indexed=%s)', async (indexed) => {
    await db.memory.update({ where: { id: target.id }, data: { vectorIndexEnabled: indexed } });
    const node = await seed();
    expect(await vectorSearchChunks(db, vectorOpts())).toHaveLength(1);
    await rawMerge(); // No resolver's later backfill may hide a non-atomic relocation.
    expect(await db.nodeEmbedding.count({ where: { nodeId: node.id } }), 'merge commit must purge source abstract and chunks').toBe(0);
    const moved = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(moved.memoryId).toBe(target.id);
    expect(moved.embeddingPendingAt === null).toBe(!indexed);
    if (indexed) expect(moved.embeddingWorkToken).not.toBe(node.embeddingWorkToken);
    expect(moved).toMatchObject({ embeddingFailedAt: null, embeddingError: null, embeddingAttempts: 0 });
    expect(await vectorSearchChunks(db, vectorOpts())).toEqual([]);
    expect(await vectorSearchNodes(db, vectorOpts())).toEqual([]);
  });

  it('GraphQL source-only search receives no moved passage, while destination re-embeds its own policy', async () => {
    await db.memory.update({ where: { id: target.id }, data: { vectorIndexEnabled: true } });
    const node = await seed();
    await resolvers.Mutation.mergeMemories({}, { input: { source: source.id, target: target.id } }, ctx());
    // A queued old source chunk must be absent even before the destination sweep.
    expect(await db.nodeEmbedding.count({ where: { nodeId: node.id } }), 'resolver backfill cannot retain source chunks').toBe(0);
    vi.stubEnv('EMBEDDING_API_URL', 'http://stub.invalid');
    setEmbeddingClientForTests({ provider: 'test', model: 'test', dim: 768, embed: async (texts) => texts.map(() => q) });
    expect(await embedNode(db, node.id)).toBe('embedded');
    const rows = await db.nodeEmbedding.findMany({ where: { nodeId: node.id }, select: { memoryId: true, kind: true } });
    expect(rows).toEqual([{ memoryId: target.id, kind: 'abstract' }]);
    const reader: Context = { db, userId: readerId, roles: ['READER'] };
    for (const mode of ['vector', 'hybrid'] as const) {
      const out = await resolvers.Query.findNodes({}, { query: 'payload', mode, filter: { memoryIds: [source.id] } }, reader);
      expect(out.hits).toEqual([]);
    }
    const chunks = await resolvers.Query.findNodes({}, { query: 'payload', mode: 'vector', granularity: 'chunk', filter: { memoryIds: [source.id] } }, reader);
    expect(chunks.passages).toEqual([]);
    expect(await vectorSearchNodes(db, { ...vectorOpts(), memoryIds: [target.id] })).toHaveLength(1);
  });

  it.each(['abstract', 'chunk'])('rejects an in-flight source %s rebuild after merge', async (kind) => {
    const node = await seed();
    await rawMerge();
    const row = { nodeId: node.id, memoryId: source.id, provider: 'old', model: 'old', dim: 768, embedding: q };
    const wrote = kind === 'abstract' ? await upsertAbstractVector(db, row, oldStamp)
      : await upsertChunkVectors(db, node.id, [{ ...row, chunkIndex: 0, charStart: 0, charEnd: 3, chunkText: 'old' }], oldStamp);
    expect(wrote, 'an old source worker must not recreate purged vectors').toBe(false);
    expect(await db.nodeEmbedding.count({ where: { nodeId: node.id } })).toBe(0);
  });

  it.each(['ALL', 'CONTENT', 'COMMENTS'] as const)('queries independently reject stale source-tagged rows (%s)', async (scope) => {
    const node = await seed('stale', scope === 'COMMENTS' ? 'comment' : 'info');
    // Model a retained/mis-tagged historical vector independent of merge cleanup.
    const meta = scope === 'COMMENTS' ? await db.commentMeta.findUniqueOrThrow({ where: { nodeId: node.id } }) : null;
    await db.$transaction(async (tx) => {
      if (meta) await tx.node.update({ where: { id: meta.targetNodeId }, data: { memoryId: target.id } });
      await tx.node.update({ where: { id: node.id }, data: { memoryId: target.id } });
    });
    const windows: boolean[] = [];
    const opts = { ...vectorOpts(), scope, onWindow: (w: { exhausted: boolean }) => windows.push(w.exhausted) };
    expect(await vectorSearchChunks(db, opts), 'chunk join must enforce node/embedding memory equality').toEqual([]);
    expect(await vectorSearchNodes(db, opts), 'node candidate join must enforce memory equality').toEqual([]);
    expect(windows).toEqual([true, true]);
  });

  it('carries comment vectors under the same destination indexing policy', async () => {
    const comment = await seed('thread', 'comment');
    await rawMerge();
    expect((await db.node.findUniqueOrThrow({ where: { id: comment.id } })).memoryId).toBe(target.id);
    expect(await db.nodeEmbedding.count({ where: { nodeId: comment.id } })).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: comment.id } })).embeddingPendingAt).toBeNull();
  });

  it.each(['abstract', 'chunk'])('rejects a source %s writer whose old marker was null', async (kind) => {
    const node = await seed();
    await db.node.update({ where: { id: node.id }, data: { embeddingPendingAt: null } });
    await rawMerge(); // An unindexed destination also has null: marker equality alone is insufficient.
    const row = { nodeId: node.id, memoryId: source.id, provider: 'old', model: 'old', dim: 768, embedding: q };
    const wrote = kind === 'abstract' ? await upsertAbstractVector(db, row, null)
      : await upsertChunkVectors(db, node.id, [{ ...row, chunkIndex: 0, charStart: 0, charEnd: 3, chunkText: 'old' }], null);
    expect(wrote, 'a source worker cannot insert into its former memory even when both markers are null').toBe(false);
  });

  it.each(['abstract', 'chunk'])('fences a source %s statement overlapping the relocation transaction', async (kind) => {
    const node = await seed();
    let release!: () => void; let signal!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const purged = new Promise<void>((resolve) => { signal = resolve; });
    const merger = db.$extends({ query: { nodeEmbedding: { async deleteMany({ args, query }) {
      const result = await query(args);
      signal(); await held;
      return result;
    } } } }) as unknown as typeof db;
    const merging = rawMerge(merger);
    await purged;
    const row = { nodeId: node.id, memoryId: source.id, provider: 'old', model: 'old', dim: 768, embedding: q };
    const stale = kind === 'abstract' ? upsertAbstractVector(db, row, oldStamp)
      : upsertChunkVectors(db, node.id, [{ ...row, chunkIndex: 0, charStart: 0, charEnd: 3, chunkText: 'old' }], oldStamp);
    let waitError: unknown;
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        const [row] = await db.$queryRaw<Array<{ waiting: bigint }>>`
          SELECT count(*)::bigint AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND (query LIKE '%INSERT INTO node_embeddings%' OR query LIKE '%FOR NO KEY UPDATE%')`;
        if (row.waiting > 0n) break;
        if (Date.now() > deadline) throw new Error('old vector writer did not block on the merge');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) { waitError = error; } finally { release(); }
    await merging;
    expect(await stale).toBe(false);
    if (waitError) throw waitError;
    expect(await db.nodeEmbedding.count({ where: { nodeId: node.id } })).toBe(0);
  }, 15000);

  it('uses a distinct work token even when relocation shares the old worker millisecond', async () => {
    const node = await seed();
    await db.memory.update({ where: { id: target.id }, data: { vectorIndexEnabled: true } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(oldStamp);
    try {
      await rawMerge();
      const moved = await db.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(moved.embeddingWorkToken).toMatch(/^[0-9a-f-]{36}$/);
      expect(moved.embeddingWorkToken).not.toBe(node.embeddingWorkToken);
    } finally { vi.useRealTimers(); }
  });

  it('rolls relocation and vector deletion back together when a batch fails', async () => {
    const node = await seed();
    const failing = db.$extends({ query: { nodeEmbedding: { async deleteMany({ args, query }) {
      await query(args); throw new Error('injected vector maintenance failure');
    } } } }) as unknown as typeof db;
    await expect(rawMerge(failing)).rejects.toThrow('injected vector maintenance failure');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).memoryId).toBe(source.id);
    expect(await db.nodeEmbedding.count({ where: { nodeId: node.id } })).toBe(2);
  });

  it('a refused encrypted merge leaves node and vectors untouched', async () => {
    const node = await seed();
    await db.memory.update({ where: { id: target.id }, data: { isEncrypted: true } });
    await expect(resolvers.Mutation.mergeMemories({}, { input: { source: source.id, target: target.id } }, ctx())).rejects.toThrow(/encrypt/i);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).memoryId).toBe(source.id);
    expect(await db.nodeEmbedding.count({ where: { nodeId: node.id } })).toBe(2);
  });
});
