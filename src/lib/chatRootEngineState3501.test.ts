/** #3501 / rulings 0202,0208,0209. Synthetic engine edits under the real chat-root lock; no model invocation. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { updateChatRootData } from './chatRoot.js';
import { ensureCurrentNodeRevisionInTransaction } from './nodeRevisionSnapshot.js';
import { chatMutations } from '../api/graphql/schema/resolvers.mutation.chat.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let root: { id: string; loc: string; memoryId: string }, userId: string, ctx: Context;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'engine3501', urn: `engine3501-${generateId()}` } });
  const user = await db.user.create({ data: { id: generateId(), handle: `engine3501-${generateId()}` } }); userId = user.id;
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'engine', urn: `engine3501:${generateId()}` } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `engine3501:${generateId()}`, name: 'engine', class: 'personal', userId, createdBy: userId, userMemoryOfAgentId: agent.id } });
  root = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'chats:engine', name: 'engine', nodeType: 'record', createdBy: userId,
    data: { scope: 'private', title: 'Before', conversationName: 'intake', stageName: 'first', goalStack: [], routeHistory: [] } } });
  ctx = { db, userId, roles: ['ADMIN'], portalHumanUserId: userId } as Context;
});
const raw = () => db.node.findUniqueOrThrow({ where: { id: root.id } });
const enc = () => ({ id: root.memoryId, isEncrypted: false });
async function fingerprint() { await db.node.update({ where: { id: root.id }, data: { revisionContentHash: 'refresh', authorshipKind: 'HUMAN', authoredByHuman: userId, authoredAt: new Date() } }); }
const reconcile = () => db.$transaction(tx => ensureCurrentNodeRevisionInTransaction(tx, root.id, { expectedMemoryId: root.memoryId }));
it('1a: an off-track edit with unchanged mirror preserves revision and stamp through exposed reconcile', async () => {
  await fingerprint(); const before = await raw(); const revisions = await db.nodeRevision.count({ where: { nodeId: root.id } });
  await updateChatRootData(db, root, enc(), data => ({ ...data, lastOffTrackReason: 'synthetic reason', lastOffTrackAt: '2026-11-06T00:00:00.000Z' }));
  await reconcile(); const after = await raw();
  expect(after.revSeq).toBe(before.revSeq);
  expect(after.authoredByHuman).toBe(userId);
  expect(await db.nodeRevision.count({ where: { nodeId: root.id } })).toBe(revisions);
  expect(after.data).not.toHaveProperty('lastOffTrackReason');
});
it('1b control: changed stage mirror gets exactly one honest reconcile and clears stamp', async () => {
  await fingerprint(); const before = await raw();
  await updateChatRootData(db, root, enc(), data => ({ ...data, stageName: 'second' }));
  await reconcile(); expect((await raw()).revSeq).toBe(before.revSeq + 1);
  expect((await raw()).authoredByHuman).toBeNull();
  await reconcile(); expect((await raw()).revSeq).toBe(before.revSeq + 1);
});
it('5: changed portal title is one revision with HUMAN, without waiting for a reconcile', async () => {
  await fingerprint(); const before = await raw();
  await chatMutations.updateChatTitle(null, { chatId: root.loc, title: 'After' }, ctx);
  const after = await raw(); expect(after.revSeq).toBe(before.revSeq + 1);
  expect(after.authoredByHuman).toBe(userId); expect(after.authorshipKind).toBe('HUMAN');
  expect(await db.nodeRevision.count({ where: { nodeId: root.id } })).toBe(1);
  await reconcile(); expect((await raw()).revSeq).toBe(after.revSeq);
});
it('6: same trimmed title writes no root, revision or stamp', async () => {
  await fingerprint(); const before = await raw();
  await chatMutations.updateChatTitle(null, { chatId: root.loc, title: ' Before ' }, ctx);
  expect(await raw()).toEqual(before);
  expect(await db.nodeRevision.count({ where: { nodeId: root.id } })).toBe(0);
});
it('12: stale pre-transaction plaintext encryption metadata refuses before any root write', async () => {
  const before = await raw();
  await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
  await expect(updateChatRootData(db, root, enc(), d => ({ ...d, stageName: 'plaintext-leak' }))).rejects.toMatchObject({ extensions: { code: 'CHAT_AUTHORITY_SCOPE_CHANGED' } });
  expect(await raw()).toEqual(before);
});
