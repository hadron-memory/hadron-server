/** #3501 / rulings 0202,0208,0209. Synthetic engine edits under the real chat-root lock; no model invocation. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { encryptNodeFields, decryptNodeFields } from './nodeCrypto.js';
import { generateDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { generateId } from './id.js';
import { updateChatRootData, withChatRootLock } from './chatRoot.js';
import { ensureCurrentNodeRevisionInTransaction } from './nodeRevisionSnapshot.js';
import { chatMutations } from '../api/graphql/schema/resolvers.mutation.chat.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let root: { id: string; loc: string; memoryId: string }, userId: string, ctx: Context;
beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
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
  expect(await db.chatRootEngineState.count()).toBe(0);
  expect(await db.chatRootCounter.count()).toBe(0);
});
it('12: stale pre-transaction plaintext encryption metadata refuses before any root write', async () => {
  const before = await raw();
  await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
  await expect(updateChatRootData(db, root, enc(), d => ({ ...d, stageName: 'plaintext-leak' }))).rejects.toMatchObject({ extensions: { code: 'CHAT_AUTHORITY_SCOPE_CHANGED' } });
  expect(await raw()).toEqual(before);
});

it('7a: row wins after a legacy restore and every locked write resyncs the mirror', async () => {
  await updateChatRootData(db, root, enc(), d => ({ ...d, stageName: 'live-stage', routeHistory: [{ action: 'ENTER', timestamp: '2026-11-06T00:00:00Z' }] }));
  const engine = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } });
  await db.node.update({ where: { id: root.id }, data: { data: { scope: 'private', title: 'Restored', stageName: 'snapshot-stage', conversationName: 'intake', routeHistory: [{ action: 'ENTER', timestamp: '2025-01-01T00:00:00Z' }] }, revisionContentHash: 'refresh' } });
  const before = await raw();
  await updateChatRootData(db, root, enc(), d => d);
  expect((await raw()).data).toEqual({ scope: 'private', title: 'Restored', stageName: 'live-stage', conversationName: 'intake' });
  expect((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).state).toEqual(engine.state);
  await reconcile(); expect((await raw()).revSeq).toBe(before.revSeq + 1);
  await reconcile(); expect((await raw()).revSeq).toBe(before.revSeq + 1);
});
it('14: outside-memory root identity refuses without touching state', async () => {
  await expect(updateChatRootData(db, { ...root, loc: 'chats:other' }, enc(), d => d)).rejects.toMatchObject({ extensions: { code: 'CHAT_AUTHORITY_SCOPE_CHANGED' } });
  expect(await db.chatRootEngineState.count()).toBe(0);
});
it('14: extra state keys are dropped on a real state write, without moving other data', async () => {
  await db.chatRootEngineState.create({ data: { chatRootNodeId: root.id, state: { conversationName: 'intake', stageName: 'first', surprise: 'discard' } } });
  await updateChatRootData(db, root, enc(), d => ({ ...d, lastOffTrackReason: 'changed' }));
  expect((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).state).toEqual({ conversationName: 'intake', stageName: 'first', lastOffTrackReason: 'changed' });
});
it.each([42, null, '', ['bad']])('13: malformed existing stage %j refuses without write or legacy reseed', async stageName => {
  await db.chatRootEngineState.create({ data: { chatRootNodeId: root.id, state: { conversationName: 'intake', stageName } } });
  const before = await raw(), state = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } });
  await expect(updateChatRootData(db, root, enc(), d => ({ ...d, stageName: 'overwrite' }))).rejects.toMatchObject({ extensions: { code: 'CHAT_STATE_INVALID' } });
  expect(await raw()).toEqual(before);
  expect(await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).toEqual(state);
});
it('5a: governed token rename refuses without title, revision or stamp change; portal is HUMAN', async () => {
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: root.memoryId } });
  await db.node.update({ where: { id: root.id }, data: { role: 'guide' } });
  await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskRequired: true } });
  await fingerprint(); const before = await raw();
  await expect(chatMutations.updateChatTitle(null, { chatId: root.loc, title: 'Token' }, { ...ctx, portalHumanUserId: undefined })).rejects.toMatchObject({ extensions: { code: 'AUTHOR_TASK_BROKEN' } });
  expect(await raw()).toEqual(before);
  expect(await db.nodeRevision.count({ where: { nodeId: root.id } })).toBe(0);
  await chatMutations.updateChatTitle(null, { chatId: root.loc, title: 'Portal' }, ctx);
  expect(await raw()).toMatchObject({ revSeq: before.revSeq + 1, authorshipKind: 'HUMAN', authoredByHuman: userId });
});
it('5: ungoverned token rename revisions but never fabricates HUMAN from userId', async () => {
  await fingerprint(); const before = await raw();
  await chatMutations.updateChatTitle(null, { chatId: root.loc, title: 'Token' }, { ...ctx, portalHumanUserId: undefined });
  expect(await raw()).toMatchObject({ revSeq: before.revSeq + 1, authorshipKind: null, authoredByHuman: null });
});
it('malformed non-name legacy values stay in data while valid state edits proceed', async () => {
  await db.node.update({ where: { id: root.id }, data: { data: { scope: 'private', conversationName: 'intake', stageName: 'first', goalStack: 42 } } });
  await updateChatRootData(db, root, enc(), d => ({ ...d, lastOffTrackReason: 'changed' }));
  expect((await raw()).data).toHaveProperty('goalStack', 42);
  expect((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).state).not.toHaveProperty('goalStack');
});

it('4/16: state AND mirrors are encrypted, row-only edits preserve ciphertext root and stamp', async () => {
  const info = { id: root.memoryId, isEncrypted: true }, key = generateDataKey();
  sessionKeyCache.set(generateId(), root.memoryId, key);
  await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
  await db.node.update({ where: { id: root.id }, data: { data: encryptNodeFields({ data: (await raw()).data }, info).data! } });
  await updateChatRootData(db, root, info, d => ({ ...d, stageName: 'secret-stage' }));
  await fingerprint(); const before = await raw();
  await updateChatRootData(db, root, info, d => ({ ...d, lastOffTrackReason: 'private-model-reason' }));
  const state = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } });
  expect(JSON.stringify(state.state)).not.toContain('secret-stage');
  expect(JSON.stringify(state.state)).not.toContain('private-model-reason');
  expect(JSON.stringify((await raw()).data)).not.toContain('secret-stage');
  expect(decryptNodeFields({ data: state.state }, info).data).toMatchObject({ stageName: 'secret-stage', lastOffTrackReason: 'private-model-reason' });
  await reconcile(); expect(await raw()).toMatchObject({ revSeq: before.revSeq, authoredByHuman: userId });
  expect((await raw()).data).toEqual(before.data);
});
it.each(['wrong-key', 'tampered'])('13: %s state refuses before callback, no writes or reseed', async kind => {
  const info = { id: root.memoryId, isEncrypted: true }, key = generateDataKey();
  sessionKeyCache.set(generateId(), root.memoryId, key);
  await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
  await db.node.update({ where: { id: root.id }, data: { data: encryptNodeFields({ data: (await raw()).data }, info).data! } });
  await updateChatRootData(db, root, info, d => d);
  const encrypted = encryptNodeFields({ data: { conversationName: 'intake', stageName: 'first' } }, info).data as unknown as { __enc: string };
  if (kind === 'wrong-key') { sessionKeyCache.clear(); sessionKeyCache.set(generateId(), root.memoryId, generateDataKey()); }
  else encrypted.__enc = encrypted.__enc.slice(0, -4) + 'AAAA';
  await db.chatRootEngineState.update({ where: { chatRootNodeId: root.id }, data: { state: encrypted } });
  const before = await raw(), state = await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } });
  const callback = vi.fn(d => d);
  await expect(updateChatRootData(db, root, info, callback)).rejects.toMatchObject({ extensions: { code: 'CHAT_STATE_INVALID' } });
  expect(callback).not.toHaveBeenCalled(); expect(await raw()).toEqual(before);
  expect(await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).toEqual(state);
});
it('4: keyless write keeps the existing SESSION_EXPIRED refusal and writes nothing', async () => {
  await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } }); const before = await raw();
  await expect(updateChatRootData(db, root, { id: root.memoryId, isEncrypted: true }, d => d)).rejects.toThrow('SESSION_EXPIRED');
  expect(await raw()).toEqual(before); expect(await db.chatRootEngineState.count()).toBe(0);
});
it('11: encryptMemory converts state on live AND tombstoned roots in its real conversion path', async () => {
  const { memoryMutations } = await import('../api/graphql/schema/resolvers.mutation.memory.js');
  await updateChatRootData(db, root, enc(), d => d);
  const dead = await db.node.create({ data: { id: generateId(), memoryId: root.memoryId, loc: 'chats:dead', name: 'dead', nodeType: 'record', deletedAt: new Date(), data: {} } });
  await db.chatRootEngineState.create({ data: { chatRootNodeId: dead.id, state: { conversationName: 'tombstone-private-name', stageName: 'old-stage' } } });
  await db.memory.update({ where: { id: root.memoryId }, data: { class: 'private' } });
  const key = generateDataKey();
  await memoryMutations.encryptMemory(null, { memoryId: root.memoryId, dataKey: key.raw.toString('base64') }, ctx);
  const rows = await db.chatRootEngineState.findMany({ where: { chatRootNodeId: { in: [root.id, dead.id] } } });
  expect(rows).toHaveLength(2);
  for (const row of rows) { expect(row.state).toHaveProperty('__enc'); expect(JSON.stringify(row.state)).not.toContain('stage'); }
  sessionKeyCache.set(generateId(), root.memoryId, key);
  await updateChatRootData(db, root, { id: root.memoryId, isEncrypted: true }, d => ({ ...d, lastOffTrackReason: 'still works' }));
});
it('10: plaintext clone carries operational state through the node-id map', async () => {
  const { cloneMemoryGraphInTx } = await import('../controller/operations/cloneMemory.js');
  await updateChatRootData(db, root, enc(), d => ({ ...d, stageName: 'live-stage' }));
  const memory = await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } });
  const copy = await db.$transaction(tx => cloneMemoryGraphInTx(tx, { sourceMemoryId: root.memoryId, name: 'copy', newUrn: `engine3501:copy-${generateId()}`, targetOrganizationId: memory.organizationId!, ownerUserId: userId, groupOwnerUserId: null, actorId: userId, copierReadableMemoryIds: null }));
  expect((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: copy.nodeIdMap.get(root.id)! } })).state).toMatchObject({ stageName: 'live-stage' });
});
it('read-only list overlay prefers live row, never seeds, and keeps encrypted names null', async () => {
  const { readChatEngineStates } = await import('./chatRootEngineState.js');
  await db.chatRootEngineState.create({ data: { chatRootNodeId: root.id, state: { conversationName: 'live', stageName: 'live-stage' } } });
  expect((await readChatEngineStates(db, [await raw()])).get(root.id)).toEqual({ conversationName: 'live', stageName: 'live-stage' });
  await db.chatRootEngineState.deleteMany(); await readChatEngineStates(db, [await raw()]); expect(await db.chatRootEngineState.count()).toBe(0);
  await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
  expect((await readChatEngineStates(db, [await raw()])).get(root.id)).toEqual({});
});
it.each(['encrypt', 'promote'])('12/11: real %s commits on a second connection between observed flag and anchor; both writes refuse or are ciphertext', async method => {
  const { memoryMutations } = await import('../api/graphql/schema/resolvers.mutation.memory.js');
  const { withTestOperationKey } = await import('../test/operationKey.js');
  await updateChatRootData(db, root, enc(), d => d);
  const dead = await db.node.create({ data: { id: generateId(), memoryId: root.memoryId, loc: 'chats:dead', name: 'dead', nodeType: 'record', deletedAt: new Date(), data: {} } });
  await db.chatRootEngineState.create({ data: { chatRootNodeId: dead.id, state: { conversationName: 'tombstone-private-name', stageName: 'old-stage' } } });
  const key = generateDataKey();
  let flip: () => Promise<unknown>;
  if (method === 'encrypt') {
    await db.memory.update({ where: { id: root.memoryId }, data: { class: 'private' } });
    flip = () => memoryMutations.encryptMemory(null, { memoryId: root.memoryId, dataKey: key.raw.toString('base64') }, ctx);
  } else {
    const memory = await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } });
    const app = await db.app.create({ data: { id: generateId(), name: 'promotion3501', urn: `promotion3501:${generateId()}`, organizationId: memory.organizationId!, identifyUserMethod: 'SECRET', createUserPermission: 'IMPLICIT' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: memory.userMemoryOfAgentId! } });
    await db.memory.update({ where: { id: memory.id }, data: { class: 'app', appId: app.id, userId: null, createdBy: null, anonymousExpiresAt: new Date(Date.now() + 86400000) } });
    flip = () => withTestOperationKey(key.raw.toString('base64'), app.id, () => memoryMutations.linkMemoryToUser(null, { memoryId: memory.id, externalUserId: '3501-synthetic' }, { db, appId: app.id, roles: [] } as Context));
  }
  let observedPid = 0;
  // This transaction occupies one pool connection before the real flip uses another.
  const inTx = <T>(fn: (tx: import('../generated/prisma/index.js').Prisma.TransactionClient) => Promise<T>) => db.$transaction(async tx => {
    const [row] = await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`; observedPid = row.pid;
    await flip(); return fn(tx);
  }, { timeout: 30000 });
  await expect(updateChatRootData(db, root, enc(), d => ({ ...d, stageName: 'must-not-write' }), { inTx })).rejects.toMatchObject({ extensions: { code: 'CHAT_AUTHORITY_SCOPE_CHANGED' } });
  expect(observedPid).toBeGreaterThan(0);
  expect((await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } })).isEncrypted).toBe(true);
  const rows = await db.chatRootEngineState.findMany(); expect(rows).toHaveLength(2);
  for (const row of rows) { expect(row.state).toHaveProperty('__enc'); expect(JSON.stringify(row.state)).not.toContain('stage'); }
  expect((await raw()).data).toHaveProperty('__enc');
  expect(JSON.stringify((await raw()).data)).not.toContain('intake');
});
it('7: actual revision restore rewinds title, but myChats and the next turn retain live state', async () => {
  const { nodeMutations } = await import('../api/graphql/schema/resolvers.mutation.node.js');
  const { chatQueries } = await import('../api/graphql/schema/resolvers.query.chat.js');
  await fingerprint();
  await chatMutations.updateChatTitle(null, { chatId: root.loc, title: 'Renamed' }, ctx);
  const revision = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: root.id }, orderBy: { revNo: 'asc' } });
  await updateChatRootData(db, root, enc(), d => ({ ...d, stageName: 'live-stage' }));
  await reconcile();
  await nodeMutations.restoreNodeRevision(null, { revisionId: revision.id }, ctx);
  expect((await raw()).data).toMatchObject({ title: 'Before', stageName: 'first' });
  const memory = await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } });
  const list = await chatQueries.myChats(null, { agentRef: memory.userMemoryOfAgentId! }, ctx);
  expect(list.find((chat: {loc:string}) => chat.loc === root.loc)).toMatchObject({ title: 'Before', stageName: 'live-stage', conversationName: 'intake' });
  await updateChatRootData(db, root, enc(), d => d);
  expect((await raw()).data).toMatchObject({ title: 'Before', stageName: 'live-stage' });
});

it('15: shared root lock serializes state edits; every held turn is drained even on assertion failure', async () => {
  await updateChatRootData(db, root, enc(), d => d); // seed both tables before the controlled lock wait
  let enter!: () => void, release!: () => void, secondEntered = false;
  const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
  const first = withChatRootLock(db, root, enc(), async ({ chatData }) => {
    enter(); await gate; return { chatData: { ...chatData, lastOffTrackReason: 'first' }, value: null };
  });
  await entered;
  const second = withChatRootLock(db, root, enc(), async ({ chatData }) => {
    secondEntered = true; expect(chatData.lastOffTrackReason).toBe('first');
    return { chatData: { ...chatData, lastOffTrackReason: 'second' }, value: null };
  });
  // Capture rejection immediately so a mutant cannot leak an unhandled promise during the observation.
  const drained = Promise.allSettled([first, second]);
  try { await new Promise(r => setTimeout(r, 60)); expect(secondEntered).toBe(false); }
  finally { release(); await drained; }
  const results = await drained;
  for (const result of results) expect(result.status).toBe('fulfilled');
  expect((await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).state).toHaveProperty('lastOffTrackReason', 'second');
});
it('15: lazy strip never certifies an unrelated pending drift', async () => {
  await fingerprint(); const before = await raw();
  await db.node.update({ where: { id: root.id }, data: { name: 'unrevisioned drift' } });
  await updateChatRootData(db, root, enc(), d => ({ ...d, lastOffTrackReason: 'new' }));
  await reconcile(); expect(await raw()).toMatchObject({ revSeq: before.revSeq + 1, authoredByHuman: null });
});
it('5: a real on-behalf-of run rename records a revision without HUMAN', async () => {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: root.memoryId } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: memory.organizationId!, name: 'run3501', urn: `run3501:${generateId()}` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: memory.userMemoryOfAgentId! } });
  await db.agentSubscription.create({ data: { userId, agentId: memory.userMemoryOfAgentId!, activatedAt: new Date() } });
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: memory.organizationId!, appId: app.id, userId, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:example.com:synthetic:entry' } });
  await db.memory.update({ where: { id: memory.id }, data: { appId: app.id } });
  await fingerprint(); const before = await raw();
  await chatMutations.updateChatTitle(null, { chatId: root.loc, title: 'Run title' }, { ...ctx, appId: app.id, clientId: `run:${run.id}`, portalHumanUserId: undefined });
  expect(await raw()).toMatchObject({ revSeq: before.revSeq + 1, authorshipKind: null, authoredByHuman: null });
});

it('1a encrypted FIRST unchanged-mirror turn strips legacy state without ciphertext-order drift or lost stamp', async () => {
  const info = { id: root.memoryId, isEncrypted: true };
  sessionKeyCache.set(generateId(), root.memoryId, generateDataKey());
  await db.memory.update({ where: { id: root.memoryId }, data: { isEncrypted: true } });
  // Deliberately not the object-property order the engine overlay constructs.
  const data = { conversationName: 'intake', title: 'Before', stageName: 'first', scope: 'private', userId, goalStack: [], routeHistory: [] };
  await db.node.update({ where: { id: root.id }, data: { data: encryptNodeFields({ data }, info).data } });
  await fingerprint(); const before = await raw();
  await updateChatRootData(db, root, info, d => ({ ...d, lastOffTrackReason: 'off track' }));
  await reconcile(); expect(await raw()).toMatchObject({ revSeq: before.revSeq, authoredByHuman: userId });
});
it('11/13: conversion never nests an undecryptable existing envelope as fresh plaintext', async () => {
  const { encryptChatEngineStateWithKey } = await import('./chatRootEngineState.js');
  const row = await db.chatRootEngineState.create({ data: { chatRootNodeId: root.id, state: { __enc: 'tampered' } } });
  await expect(db.$transaction(tx => encryptChatEngineStateWithKey(tx, root.id, generateDataKey()))).rejects.toMatchObject({ extensions: { code: 'CHAT_STATE_INVALID' } });
  expect(await db.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: root.id } })).toEqual(row);
});
