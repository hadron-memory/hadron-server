import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTestableMcpServer } from '../mcp/server.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { emptyActor, publishUser, requestActorStorage } from '../lib/requestActor.js';
import { deleteNodeVectors, deleteMemoryChunkVectors } from '../services/embedding/vectors.js';
import { upsertChunkVectors } from '../services/embedding/vectors.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { chunkNode } from '../lib/chunking.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../lib/embedding/index.js';
import { embedNode, drainEmbeddingQueue, stopEmbeddingWorker } from './embedNodes.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { validateMemoryNodes } from '../lib/memoryValidation.js';

let memoryId: string;
let nodeId: string;
let userId: string;
const content = (n: number) => 'abcd'.repeat(n); // one token / chunk; no overlap
const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
const client = { provider: 'fake', model: 'cap887', dim: 768, embed: vi.fn(async (texts: string[]) => texts.map(() => vector)) };
const row = () => db.node.findUniqueOrThrow({ where: { id: nodeId } }) as Promise<any>;
const chunks = () => db.nodeEmbedding.findMany({ where: { nodeId, kind: 'chunk' }, orderBy: { chunkIndex: 'asc' } });
const ctx = () => ({ db, userId, roles: ['ADMIN'] });
async function queue(n: number) {
  await db.node.update({ where: { id: nodeId }, data: { content: content(n), embeddingPendingAt: new Date(), embeddingWorkToken: randomUUID() } });
}
async function truncated() {
  await queue(300);
  expect(await embedNode(db, nodeId, undefined, client)).toBe('embedded');
}
beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'cap887', graphName: 'cap887/test' });
  memoryId = made.graph.id;
  userId = generateId();
  await db.user.create({ data: { id: userId, handle: `cap-${userId}` } });
  await db.orgMember.create({ data: { organizationId: made.org.id, userId, role: 'ADMIN' } });
  await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks', chunkTokens: 1, chunkOverlap: 0, forceFixedSize: true } });
  nodeId = generateId();
  await db.node.create({ data: { id: nodeId, memoryId, loc: 'target', name: 'cap', content: content(300) } });
});
describe('#887 partial indexing (fake client, real disposable DB)', () => {
  it.each([300, 256, 255, 1])('embeds first min(n,256) chunks, reports omitted count, meters only sent text (n=%i)', async n => {
    await queue(n);
    expect(chunkNode(content(n), { chunkTokens: 1, chunkOverlap: 0, forceFixedSize: true })).toHaveLength(n);
    expect(await embedNode(db, nodeId, undefined, client)).toBe('embedded');
    const stored = await chunks();
    expect(stored.map(c => c.chunkIndex)).toEqual(Array.from({ length: Math.min(n,256) }, (_, i) => i));
    expect(client.embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(Math.min(n,256));
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: n > 256 ? n-256 : null, embeddingError: null, embeddingFailedAt: null, embeddingPendingAt: null });
    const usage = await db.usageEvent.findMany({ where: { nodeId, type: 'embedding' } });
    expect(usage).toHaveLength(1);
    expect(usage[0].tokensIn).toBe(Math.min(n,256));
  });
  it('leaves the summary vector unaffected, and summary-only never sets a marker', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { embeddingSource: 'both' } });
    await db.node.update({ where: { id: nodeId }, data: { abstract: 'summary' } });
    await truncated();
    expect(await db.nodeEmbedding.count({ where: { nodeId, kind: 'abstract' } })).toBe(1);
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: 44 });
    await (resolvers.Mutation as any).updateMemory(null, { id: memoryId, embeddingSource: 'abstract' }, ctx());
    await embedNode(db, nodeId, undefined, client);
    expect(await chunks()).toHaveLength(0);
    expect(await db.nodeEmbedding.count({ where: { nodeId, kind: 'abstract' } })).toBe(1);
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
  });
  it('the worker clears a previous declaration when adopting summary-only policy', async () => {
    await truncated();
    // Seed pending work across a policy transition independently of the API purge.
    await db.memory.update({ where: { id: memoryId }, data: { embeddingSource: 'abstract' } });
    await db.node.update({ where: { id: nodeId }, data: { abstract: 'summary' } });
    await queue(300);
    expect(await embedNode(db, nodeId, undefined, client)).toBe('embedded');
    expect(await chunks()).toHaveLength(0);
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
  });
  it('system memory passage removal fences an in-flight worker while keeping pending summary work', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { class: 'system', embeddingSource: 'both' } });
    await db.node.update({ where: { id: nodeId }, data: { abstract: 'summary' } });
    await queue(300);
    const paused = { ...client, embed: async (texts: string[]) => {
      await (resolvers.Mutation as any).updateMemory(null, { id: memoryId, vectorIndexEnabled: false }, ctx());
      return texts.map(() => vector);
    } };
    expect(await embedNode(db, nodeId, undefined, paused)).toBe('skipped');
    expect(await chunks()).toHaveLength(0);
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
    expect((await row()).embeddingWorkToken).not.toBeNull();
    setEmbeddingClientForTests(client);
    try {
      // Recover through the real durable selector/dispatcher, not a direct embed call.
      expect(await drainEmbeddingQueue(db, { client })).toMatchObject({ embedded: 1, failed: 0 });
      expect((await row()).embeddingPendingAt).toBeNull();
    } finally {
      await stopEmbeddingWorker(db);
      resetEmbeddingClientForTests();
    }
  });
  it('re-embedding is stable; editing down and empty content clear it', async () => {
    await truncated(); await truncated();
    expect(await chunks()).toHaveLength(256);
    await queue(10); await embedNode(db, nodeId, undefined, client);
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
    await truncated(); await queue(0); await embedNode(db, nodeId, undefined, client);
    expect(await chunks()).toHaveLength(0);
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
  });
  it.each(['summary', 'disable', 'revoke'] as const)('clears when passage vectors go away: %s', async mode => {
    if (mode === 'revoke') {
      // Private owner fixture; authorized plaintext prompt, never a real key/provider.
      await db.memory.update({ where: { id: memoryId }, data: { class: 'private', userId, isEncrypted: true, vectorIndexEncryptedAckAt: new Date() } });
      await queue(300);
      expect(await embedNode(db, nodeId, { content: content(300) }, client)).toBe('embedded');
    } else await truncated();
    const args = mode === 'summary' ? { embeddingSource: 'abstract' } : { vectorIndexEnabled: false };
    await (resolvers.Mutation as any).updateMemory(null, { id: memoryId, ...args }, ctx());
    expect(await chunks()).toHaveLength(0);
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
    if (mode === 'summary') {
      await db.node.update({ where: { id: nodeId }, data: { abstract: 'summary' } });
      await embedNode(db, nodeId, undefined, client);
      expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
    }
  });
  it('exposes count in GraphQL and informational validation, even with zero retained findings', async () => {
    await truncated();
    const node = await row();
    expect(await (resolvers.Node as any).indexTruncated(node, {}, ctx())).toEqual({ omittedChunks: 44 });
    // Exercise the actual public SDL and normal parent read, not just the field helper.
    const server = new ApolloServer({ typeDefs, resolvers });
    try {
      const response = await server.executeOperation({ query: 'query($id: ID!) { node(ref: $id) { indexTruncated { omittedChunks } } }', variables: { id: nodeId } }, { contextValue: ctx() });
      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        expect(response.body.singleResult.data).toMatchObject({ node: { indexTruncated: { omittedChunks: 44 } } });
      }
    } finally { await server.stop(); }
    const report = await validateMemoryNodes(db, memoryId);
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'INDEX_TRUNCATED', nodeId, detail: expect.stringContaining('44') }));
    expect(report.findings.some(f => f.kind === 'EMBED_FAILED')).toBe(false);
    const result = await (resolvers.Query as any).validateMemory(null, { memoryRef: memoryId, limit: 0 }, ctx());
    expect(result).toMatchObject({ ok: true, totalFindings: 0, totalInformational: 1, truncated: true, findings: [] });
  });
  it('MCP reports truncation as informational rather than an issue', async () => {
    await truncated();
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const text = await createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` }).callToolText('hadron_validate', { memoryUrn: `hrn:mem:${memory.urn}` });
    expect(text).toContain('No issues found.');
    expect(text).toContain('Informational findings (1)');
    expect(text).toContain('[index-truncated]');
    expect(text).not.toContain('Found 1 issue');
  });
  it('retains real problems ahead of informational declarations within the page cap', async () => {
    await truncated();
    await db.node.update({ where: { id: nodeId }, data: { embeddingFailedAt: new Date(), embeddingError: 'synthetic failure' } });
    const report = await validateMemoryNodes(db, memoryId, 1);
    expect(report).toMatchObject({ totalFindings: 1, totalInformational: 1 });
    expect(report.findings).toEqual([expect.objectContaining({ kind: 'EMBED_FAILED' })]);
  });
  it('passage removal does not rewrite a clean node with no marker or pending work', async () => {
    await db.node.update({ where: { id: nodeId }, data: { embeddingPendingAt: null, embeddingWorkToken: null, embeddingTruncatedChunks: null } });
    const version = async () => (await db.$queryRaw<{version: string}[]>`SELECT xmin::text AS version FROM nodes WHERE id = ${nodeId}`)[0].version;
    const before = await version();
    await deleteMemoryChunkVectors(db, memoryId);
    expect(await version()).toBe(before);
  });
  it('a superseded in-flight embed cannot overwrite the new marker/vectors', async () => {
    await truncated(); await queue(300);
    const staleClient = { ...client, embed: async (texts: string[]) => {
      await queue(1); await embedNode(db, nodeId, undefined, client);
      return texts.map(() => vector);
    } };
    expect(await embedNode(db, nodeId, undefined, staleClient)).toBe('skipped');
    expect(await chunks()).toHaveLength(1);
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
  });
  it('the atomic vector writer rejects a stale token without changing a successful marker', async () => {
    await truncated();
    const stale = randomUUID();
    const chunk = chunkNode(content(1), { chunkTokens: 1, chunkOverlap: 0, forceFixedSize: true })[0];
    expect(await upsertChunkVectors(db, nodeId, [{ nodeId, memoryId, provider: 'fake', model: 'cap887', dim: 768,
      chunkIndex: 0, charStart: chunk.charStart, charEnd: chunk.charEnd, chunkText: chunk.text, embedding: vector }], stale, null)).toBe(false);
    expect(await chunks()).toHaveLength(256);
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: 44 });
  });
  it('additive migration leaves pre-existing nodes NULL without a backfill', async () => {
    const sql = readFileSync(new URL('../../prisma/migrations/20261031220000_embedding_truncated_chunks/migration.sql', import.meta.url), 'utf8');
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE nodes (id text) ON COMMIT DROP');
      await tx.$executeRawUnsafe("INSERT INTO nodes VALUES ('legacy')");
      await tx.$executeRawUnsafe(sql);
      expect(await tx.$queryRawUnsafe('SELECT embedding_truncated_chunks FROM nodes')).toEqual([{ embedding_truncated_chunks: null }]);
    });
  });
  it('operational vector replacement and purge preserve the last authored editor', async () => {
    await queue(300);
    await requestActorStorage.run(emptyActor(), async () => {
      publishUser(userId);
      await db.node.update({ where: { id: nodeId }, data: { name: 'authored name' } });
    });
    expect((await row()).updatedByUserId).toBe(userId);
    await requestActorStorage.run(emptyActor(), async () => {
      expect(await embedNode(db, nodeId, undefined, client)).toBe('embedded');
      expect((await row()).updatedByUserId).toBe(userId);
      await deleteNodeVectors(db, nodeId);
    });
    expect(await row()).toMatchObject({ updatedByUserId: userId, name: 'authored name', content: content(300), embeddingTruncatedChunks: null });
  });
  it('soft deletion clears the marker', async () => {
    await truncated();
    await (resolvers.Mutation as any).deleteNode(null, { nodeRef: nodeId }, ctx());
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
  });
});
