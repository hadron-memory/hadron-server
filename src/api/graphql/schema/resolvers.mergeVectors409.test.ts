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
    content: 'source secret payload', abstract: 'destination summary', embeddingPendingAt: oldStamp,
    embeddingFailedAt: oldStamp, embeddingAttempts: 8, embeddingError: 'old retry' };
  const node = comment ? await db.node.update({ where: { id: comment.id }, data }) : await db.node.create({ data: { id: generateId(), ...data } });
  await upsertAbstractVector(db, { nodeId: node.id, memoryId: source.id, provider: 'test', model: 'test', dim: 768, embedding: q });
  await upsertChunkVectors(db, node.id, [{ nodeId: node.id, memoryId: source.id, provider: 'test', model: 'test', dim: 768,
    chunkIndex: 0, charStart: 0, charEnd: 21, chunkText: 'source secret payload', embedding: q }]);
  return node;
}
const rawMerge = () => mergeMemoryGraph(db, { sourceMemoryId: source.id, targetMemoryId: target.id,
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
    if (indexed) expect(moved.embeddingPendingAt!.getTime()).not.toBe(oldStamp.getTime());
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

  it('a refused encrypted merge leaves node and vectors untouched', async () => {
    const node = await seed();
    await db.memory.update({ where: { id: target.id }, data: { isEncrypted: true } });
    await expect(resolvers.Mutation.mergeMemories({}, { input: { source: source.id, target: target.id } }, ctx())).rejects.toThrow(/encrypt/i);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).memoryId).toBe(source.id);
    expect(await db.nodeEmbedding.count({ where: { nodeId: node.id } })).toBe(2);
  });
});
