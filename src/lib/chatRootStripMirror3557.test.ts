/** #3557 (contract step of ruling 0209): the two names live ONLY in the state row. Synthetic edits under the real chat-root lock. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { encryptNodeFields, decryptNodeFields } from './nodeCrypto.js';
import { generateDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { generateId } from './id.js';
import { updateChatRootData, withChatRootLock } from './chatRoot.js';
import { readChatEngineStates } from './chatRootEngineState.js';
import { ensureCurrentNodeRevisionInTransaction } from './nodeRevisionSnapshot.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let root: { id: string; loc: string; memoryId: string }, userId: string;
beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const org = await db.organization.create({ data: { id: generateId(), name: 'strip3557', urn: `strip3557-${generateId()}` } });
  const user = await db.user.create({ data: { id: generateId(), handle: `strip3557-${generateId()}` } }); userId = user.id;
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'strip', urn: `strip3557:${generateId()}` } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `strip3557:${generateId()}`, name: 'strip', class: 'personal', userId, createdBy: userId, userMemoryOfAgentId: agent.id } });
  root = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'chats:strip', name: 'strip', nodeType: 'record', createdBy: userId, data: { scope: 'private', title: 'T' } } });
  await db.chatRootEngineState.create({ data: { chatRootNodeId: root.id, state: { conversationName: 'intake', stageName: 'first' } } });
});
const raw = () => db.node.findUniqueOrThrow({ where: { id: root.id } });
const rowState = async () => (await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).state;
const plain = () => ({ id: root.memoryId, isEncrypted: false });
const reconcile = () => db.$transaction(tx => ensureCurrentNodeRevisionInTransaction(tx, root.id, { expectedMemoryId: root.memoryId }));
async function fingerprint() { await db.node.update({ where: { id: root.id }, data: { revisionContentHash: 'refresh', authorshipKind: 'HUMAN', authoredByHuman: userId, authoredAt: new Date() } }); }

it('1: a stage-changing turn on a stripped root writes the row only: no root rewrite, revision or stamp change', async () => {
  await fingerprint(); const before = await raw();
  await updateChatRootData(db, root, plain(), d => ({ ...d, stageName: 'second' }));
  expect(await rowState()).toEqual({ conversationName: 'intake', stageName: 'second' });
  await reconcile();
  expect(await raw()).toEqual(before);
});
it('2: a locked write scrubs a plaintext mirror the migration missed, once, and never re-adds it', async () => {
  await db.node.update({ where: { id: root.id }, data: { data: { scope: 'private', title: 'T', conversationName: 'intake', stageName: 'first' } } });
  await updateChatRootData(db, root, plain(), d => ({ ...d, stageName: 'second' }));
  expect((await raw()).data).toEqual({ scope: 'private', title: 'T' });
  expect(await rowState()).toEqual({ conversationName: 'intake', stageName: 'second' });
});
it('3: row/data DISAGREEMENT: the row wins in the callback and neither name is written back', async () => {
  await db.node.update({ where: { id: root.id }, data: { data: { scope: 'private', title: 'T', conversationName: 'stale', stageName: 'stale' } } });
  let seen: Record<string, unknown> = {};
  await updateChatRootData(db, root, plain(), d => { seen = { ...d }; return d; });
  expect(seen).toMatchObject({ conversationName: 'intake', stageName: 'first' });
  expect((await raw()).data).not.toHaveProperty('stageName');
  expect((await raw()).data).not.toHaveProperty('conversationName');
  expect(await rowState()).toEqual({ conversationName: 'intake', stageName: 'first' });
});
it('4: a malformed legacy name beside a valid row value is preserved, not stripped', async () => {
  await db.node.update({ where: { id: root.id }, data: { data: { scope: 'private', title: 'T', stageName: 42 } } });
  await updateChatRootData(db, root, plain(), d => ({ ...d, lastOffTrackReason: 'r' }));
  expect((await raw()).data).toHaveProperty('stageName', 42);
});
it('5: a counter-only append on a stripped root does not rewrite the root', async () => {
  const before = await raw();
  await withChatRootLock(db, root, plain(), async () => ({ value: null }));
  expect((await raw()).data).toEqual(before.data);
});
it('6: encrypted root: first keyed write scrubs the mirror, raw data carries no plaintext, reads change nothing', async () => {
  const info = { id: root.memoryId, isEncrypted: true }, key = generateDataKey();
  sessionKeyCache.set(generateId(), root.memoryId, key);
  await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
  await db.node.update({ where: { id: root.id }, data: { data: encryptNodeFields({ data: { scope: 'private', title: 'T', conversationName: 'secret-conv', stageName: 'secret-stage' } }, info).data! } });
  await db.chatRootEngineState.update({ where: { chatRootNodeId: root.id }, data: { state: encryptNodeFields({ data: { conversationName: 'secret-conv', stageName: 'secret-stage' } }, info).data as never } });
  const before = await raw();
  await readChatEngineStates(db, [{ id: root.id, memoryId: root.memoryId, data: before.data }]);
  expect(await raw()).toEqual(before);
  await updateChatRootData(db, root, info, d => ({ ...d, lastOffTrackReason: 'r' }));
  const after = await raw();
  expect(JSON.stringify(after.data)).not.toContain('secret');
  expect(decryptNodeFields({ data: after.data }, info).data).toEqual({ scope: 'private', title: 'T' });
  expect(decryptNodeFields({ data: await rowState() }, info).data).toMatchObject({ conversationName: 'secret-conv', stageName: 'secret-stage' });
});
it('7: later engine-only turns after the first scrub leave the encrypted root ciphertext untouched', async () => {
  const info = { id: root.memoryId, isEncrypted: true }, key = generateDataKey();
  sessionKeyCache.set(generateId(), root.memoryId, key);
  await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
  await db.node.update({ where: { id: root.id }, data: { data: encryptNodeFields({ data: { scope: 'private', title: 'T' } }, info).data! } });
  await db.chatRootEngineState.update({ where: { chatRootNodeId: root.id }, data: { state: encryptNodeFields({ data: { conversationName: 'c', stageName: 's' } }, info).data as never } });
  await updateChatRootData(db, root, info, d => d);
  const before = await raw();
  await updateChatRootData(db, root, info, d => ({ ...d, stageName: 'next' }));
  expect(await raw()).toEqual(before);
});
