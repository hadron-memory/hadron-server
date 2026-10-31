import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { chunkNode } from '../lib/chunking.js';
import { embedNode } from './embedNodes.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { validateMemoryNodes } from '../lib/memoryValidation.js';
import { recordLlmUsage } from '../lib/metering/index.js';

vi.mock('../lib/metering/index.js', () => ({ recordLlmUsage: vi.fn(async () => {}) }));
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
    expect(recordLlmUsage).toHaveBeenCalledWith(db, expect.objectContaining({ tokensIn: Math.min(n,256) }));
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
    const report = await validateMemoryNodes(db, memoryId);
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'INDEX_TRUNCATED', nodeId, detail: expect.stringContaining('44') }));
    expect(report.findings.some(f => f.kind === 'EMBED_FAILED')).toBe(false);
    const result = await (resolvers.Query as any).validateMemory(null, { memoryRef: memoryId, limit: 0 }, ctx());
    expect(result).toMatchObject({ ok: true, totalFindings: 1, truncated: true, findings: [] });
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
  it('soft deletion clears the marker', async () => {
    await truncated();
    await (resolvers.Mutation as any).deleteNode(null, { nodeRef: nodeId }, ctx());
    expect(await row()).toMatchObject({ embeddingTruncatedChunks: null });
  });
});
