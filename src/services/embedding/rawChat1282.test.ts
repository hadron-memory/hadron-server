import { expect, it, vi } from 'vitest';
import { isRawChatNode } from './rawChat.js';
import { stampEmbeddingObligation } from './obligation.js';
it.each([
  ['chat-message', 'anywhere', true], ['record', 'chats:one:messages:001-user', true],
  ['record', 'chats:one:messages:001-assistant', true], ['record', 'ledger:invoice', false],
  ['record', 'chats:one', false], ['record', 'chats:one:messages', false], ['chat', 'chats:team', false],
  ['abstract', 'chats:one:messages:001a-summary', false], ['info', 'chats:one:summary', false],
  ['record', 'chats:one:messages:001:attachment', false],
])('classifies only raw-turn %s at %s as %s', (nodeType, loc, expected) => {
  expect(isRawChatNode({ nodeType, loc })).toBe(expected);
});
it.each(['chat-message', 'record'])('does not stamp an excluded %s even on an encrypted indexed host', async nodeType => {
  const tx: any = { memory: { findUnique: vi.fn(async () => ({ class: 'knowledge', vectorIndexEnabled: true, isEncrypted: true, deletedAt: null })) },
    node: { findUnique: vi.fn(async () => ({ nodeType, loc: 'chats:one:messages:001-user' })), updateMany: vi.fn(async () => ({ count: 1 })) } };
  expect(await stampEmbeddingObligation(tx, 'n', 'm')).toBeNull();
  expect(tx.node.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ embeddingPendingAt: null, embeddingWorkToken: null, embeddingError: null }) }));
});
it('still stamps an unrelated record with the durable token', async () => {
  const tx: any = { memory: { findUnique: vi.fn(async () => ({ class: 'knowledge', vectorIndexEnabled: true, isEncrypted: false, deletedAt: null })) },
    node: { findUnique: vi.fn(async () => ({ nodeType: 'record', loc: 'ledger:invoice' })), updateMany: vi.fn(async () => ({ count: 1 })) } };
  const token = await stampEmbeddingObligation(tx, 'n', 'm');
  expect(token).toMatch(/^[0-9a-f-]{36}$/);
  expect(tx.node.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ embeddingWorkToken: token }) }));
});
