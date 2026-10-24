import { beforeEach, expect, it, vi } from 'vitest';
import { embedNode } from './embedNodes.js';
import { deleteNodeVectors } from '../services/embedding/vectors.js';
vi.mock('../services/embedding/vectors.js', () => ({
  upsertAbstractVector: vi.fn(async () => true), upsertChunkVectors: vi.fn(async () => true),
  deleteNodeVectors: vi.fn(async () => {}), deleteNodeChunkVectors: vi.fn(async () => true),
}));
vi.mock('../lib/metering/index.js', () => ({ recordLlmUsage: vi.fn(async () => {}) }));
const token = '00000000-0000-4000-8000-000000000001';
let row: any; let db: any; let client: any;
beforeEach(() => {
  vi.clearAllMocks();
  row = { id: 'n', loc: 'chats:example:messages:001-user', nodeType: 'record', content: 'synthetic turn', abstract: 'synthetic abstract', deletedAt: null,
    embeddingPendingAt: new Date('2026-01-01'), embeddingWorkToken: token, embeddingAttempts: 0, commentMeta: null,
    memory: { id: 'm', organizationId: null, class: 'knowledge', vectorIndexEnabled: true, embeddingSource: 'abstract', isEncrypted: false } };
  db = { node: { findUnique: vi.fn(async () => row), updateMany: vi.fn(async () => ({ count: 1 })) } };
  client = { provider: 'fake', model: 'fake', dim: 1, embed: vi.fn(async () => [[1]]) };
});
it.each(['chat-message', 'record'])('never sends raw %s content, clears only the captured marker, and leaves existing vectors for the separate purge', async nodeType => {
  row.nodeType = nodeType;
  expect(await embedNode(db, 'n', { content: 'fresh turn', abstract: 'fresh turn' }, client)).toBe('skipped');
  expect(client.embed).not.toHaveBeenCalled();
  expect(db.node.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'n', embeddingWorkToken: token }, data: expect.objectContaining({ embeddingPendingAt: null, embeddingWorkToken: null }) }));
  expect(deleteNodeVectors).not.toHaveBeenCalled();
});
it('clears a raw encrypted turn without requiring plaintext or leaving a permanent pending obligation', async () => {
  row.memory.isEncrypted = true;
  expect(await embedNode(db, 'n', undefined, client)).toBe('skipped');
  expect(client.embed).not.toHaveBeenCalled();
  expect(db.node.updateMany).toHaveBeenCalled();
});
it.each([['record', 'records:invoice'], ['record', 'chats:example'], ['chat', 'chats:team'], ['abstract', 'chats:example:messages:001a-summary'], ['info', 'chats:example:summary']])('retains eligible %s at %s', async (nodeType, loc) => {
  Object.assign(row, { nodeType, loc });
  expect(await embedNode(db, 'n', undefined, client)).toBe('embedded');
  expect(client.embed).toHaveBeenCalledWith(['synthetic abstract'], 'document');
});

it('never clears a newer raw-turn obligation on behalf of a superseded prompt', async () => {
  expect(await embedNode(db, 'n', { abstract: 'old' }, client, { workToken: '00000000-0000-4000-8000-000000000002' })).toBe('skipped');
  expect(client.embed).not.toHaveBeenCalled(); expect(db.node.updateMany).not.toHaveBeenCalled();
});
it('clears an excluded future-dated marker without bypassing a normal node retry backoff', async () => {
  row.embeddingPendingAt = new Date(Date.now() + 3600000);
  expect(await embedNode(db, 'n', undefined, client)).toBe('skipped');
  expect(db.node.updateMany).toHaveBeenCalled();
  db.node.updateMany.mockClear(); row.nodeType = 'info';
  expect(await embedNode(db, 'n', undefined, client)).toBe('skipped');
  expect(db.node.updateMany).not.toHaveBeenCalled(); expect(client.embed).not.toHaveBeenCalled();
});
