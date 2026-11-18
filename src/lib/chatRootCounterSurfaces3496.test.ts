/** #3496 — actual reader/writer surfaces keep the operational counter contract. */
import { beforeEach, it, expect, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { appendChatMessage } from './chatRoot.js';
import { readChatCounters } from './chatRootCounters.js';
import { chatQueries } from '../api/graphql/schema/resolvers.query.chat.js';
import { chatMutations } from '../api/graphql/schema/resolvers.mutation.chat.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { ensureChannelWithRoot } from './channels.js';
import { cloneMemoryGraphInTx } from '../controller/operations/cloneMemory.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { generateDataKey } from './crypto.js';
import { encryptNodeFields } from './nodeCrypto.js';
import { requestKeyStorage } from './requestKeys.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
let orgId: string, userId: string, agentId: string, memoryId: string, ctx: Context;
beforeEach(async () => {
    await cleanDb(db);
    sessionKeyCache.clear();
    orgId = (await db.organization.create({ data: { id: generateId(), name: 'surface', urn: `surface-${generateId()}` } })).id;
    userId = (await db.user.create({ data: { id: generateId(), githubId: 4713496, githubUsername: 'counter-author' } })).id;
    agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'counter', urn: `surface:agent-${generateId()}` } })).id;
    memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, name: 'counter', urn: `surface:mem-${generateId()}`, class: 'personal', userId, createdBy: userId, userMemoryOfAgentId: agentId } })).id;
    ctx = { db, userId, roles: ['ADMIN'] } as Context;
});
async function root(loc: string, n = 0) { return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType: 'record', createdBy: userId, data: { messageCount: n } } }); }
async function post(r: {
    id: string;
    loc: string;
    memoryId: string;
}) { return appendChatMessage(db, r, { id: memoryId, isEncrypted: false }, async () => { }); }
it('myChats and myChatsPage keep order and counter values after alternating posts', async () => {
    const a = await root('chats:a'), b = await root('chats:b');
    await post(b);
    await post(a);
    await post(a);
    const simple = await chatQueries.myChats(null, { agentRef: agentId }, ctx);
    const page = await chatQueries.myChatsPage(null, { agentRef: agentId }, ctx);
    expect(simple.map(c => [c.id, c.messageCount])).toEqual([[a.id, 2], [b.id, 1]]);
    expect(page.items.map(c => [c.id, c.messageCount])).toEqual([[a.id, 2], [b.id, 1]]);
    expect(simple.every(c => typeof c.lastMessageAt === 'string')).toBe(true);
});
it.each([false, true])('encrypted chat without a key reads 0/null and does not fail its page, seeded=%s', async (seeded) => {
    const r = await root('chats:encrypted', 40);
    const key = generateDataKey();
    sessionKeyCache.set('s', memoryId, key);
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    await db.node.update({ where: { id: r.id }, data: encryptNodeFields({ data: { messageCount: 40, lastMessageAt: '2026-01-01T00:00:00Z' } }, { id: memoryId, isEncrypted: true }) });
    if (seeded)
        await db.chatRootCounter.create({ data: { chatRootNodeId: r.id, messageCount: 57, lastMessageAt: new Date('2026-02-02T00:00:00Z') } });
    ctx.sessionId = 'without-key';
    const locked = await chatQueries.myChatsPage(null, { agentRef: agentId }, ctx);
    expect(locked.items[0]).toMatchObject({ messageCount: 0, lastMessageAt: null });
    ctx.sessionId = 's';
    const open = await chatQueries.myChats(null, { agentRef: agentId }, ctx);
    expect(open[0]).toMatchObject(seeded
        ? { messageCount: 57, lastMessageAt: '2026-02-02T00:00:00.000Z' }
        : { messageCount: 40, lastMessageAt: '2026-01-01T00:00:00.000Z' });
    sessionKeyCache.clear();
    ctx.sessionId = 'request-only';
    const requested = await requestKeyStorage.run(new Map([[memoryId, key]]), () =>
        chatQueries.myChatsPage(null, { agentRef: agentId }, ctx));
    expect(requested.items[0]).toMatchObject(seeded
        ? { messageCount: 57, lastMessageAt: '2026-02-02T00:00:00.000Z' }
        : { messageCount: 40, lastMessageAt: '2026-01-01T00:00:00.000Z' });
    const outside = await chatQueries.myChatsPage(null, { agentRef: agentId }, ctx);
    expect(outside.items[0]).toMatchObject({ messageCount: 0, lastMessageAt: null });
});
it('counter reads are batched across a page, not one query per row', async () => {
    const roots = await Promise.all([root('chats:a'), root('chats:b')]);
    await Promise.all(roots.map(post));
    const spy = vi.spyOn(db, '$queryRaw');
    await readChatCounters(db, roots);
    expect(spy.mock.calls.filter(([query]) => String((query as {strings?:string[]}).strings?.join('')).includes('FROM chat_root_counters')).length).toBe(1);
    spy.mockRestore();
});
it('cloneMemory copies counter rows through the new root ids', async () => {
    const r = await root('chats:a', 42);
    await post(r);
    await db.$executeRaw`UPDATE chat_root_counters SET last_message_at='280000-01-01'::timestamp WHERE chat_root_node_id=${r.id}`;
    const copy = await db.$transaction(tx => cloneMemoryGraphInTx(tx, { sourceMemoryId: memoryId, name: 'copy', newUrn: `surface:copy-${generateId()}`, targetOrganizationId: orgId, ownerUserId: userId, groupOwnerUserId: null, actorId: userId, copierReadableMemoryIds: null }));
    expect(await db.chatRootCounter.findUnique({ where: { chatRootNodeId: copy.nodeIdMap.get(r.id)! }, select:{messageCount:true} })).toMatchObject({ messageCount: 43 });
    const [time]=await db.$queryRaw<Array<{value:string}>>`SELECT last_message_at::text AS value FROM chat_root_counters WHERE chat_root_node_id=${copy.nodeIdMap.get(r.id)!}`;
    expect(time.value).toContain('280000-01-01');
});
it('channel address reuse seeds a row-less tombstone, keeps count and resets activity and lastSeq', async () => {
    const r = await db.node.create({ data: { id: generateId(), memoryId, loc: 'chats:team', name: 'team', nodeType: 'chat', data: { messageCount: 57, lastMessageAt: '2026-01-01T00:00:00Z' }, deletedAt: new Date() } });
    const reused = await ensureChannelWithRoot(db, { memoryId, loc: r.loc, name: 'team', createdBy: userId });
    expect(reused.rootId).toBe(r.id);
    expect(reused.channel.lastSeq).toBe(0);
    expect(await db.chatRootCounter.findUnique({ where: { chatRootNodeId: r.id } })).toMatchObject({ messageCount: 57, lastMessageAt: null });
    const n = await appendChatMessage(db, { ...r }, { id: memoryId, isEncrypted: false }, async () => { }, { asChannel: true });
    expect(n.seq).toBe(58);
});
it('summary naming and seq use the locked counter without consuming a message slot', async () => {
    const r = await root('chats:summary', 40);
    await post(r);
    await chatMutations.saveChatSummary(null, { chatId: r.loc, summary: 'summary' }, ctx);
    const summary = await db.node.findFirstOrThrow({ where: { memoryId, nodeType: 'abstract' } });
    expect(summary.name).toBe('041a-summary');
    expect(summary.seq).toBe(42);
    expect((await db.chatRootCounter.findUniqueOrThrow({ where: { chatRootNodeId: r.id } })).messageCount).toBe(41);
});
it('restoring an actual legacy revision cannot roll back the counter; real content still revisions', async () => {
    const { nodeMutations } = await import('../api/graphql/schema/resolvers.mutation.node.js');
    const r = await root('chats:restore', 40);
    await nodeMutations.updateNode(null, { input: { id: r.id, content: 'authored edit' } }, ctx);
    expect((await db.node.findUniqueOrThrow({where:{id:r.id}})).revSeq).toBe(r.revSeq+1);
    const revision = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: r.id }, orderBy: { revNo: 'asc' } });
    expect(revision.data).toMatchObject({ messageCount: 40 });
    expect((await post(r)).seq).toBe(41);
    await nodeMutations.restoreNodeRevision(null, { revisionId: revision.id }, ctx);
    expect((await readChatCounters(db, [await db.node.findUniqueOrThrow({ where: { id: r.id } })])).get(r.id)?.messageCount).toBe(41);
    expect((await post(r)).seq).toBe(42);
    expect((await db.node.findUniqueOrThrow({ where: { id: r.id } })).data).not.toHaveProperty('messageCount');
});
it('adopting fingerprinted legacy message flags preserves authorship without hiding prior drift', async () => {
    const root = await db.node.create({ data: { id: generateId(), memoryId, loc: 'chats:adopt', name: 'adopt', nodeType: 'chat' } });
    const child = await db.node.create({ data: { id: generateId(), memoryId, loc: `${root.loc}:messages:001-old`, name: 'old', nodeType: 'chat-message', data: { broadcastWakes: true, managerPost: true } } });
    const drifted = await db.node.create({data:{id:generateId(),memoryId,loc:`${root.loc}:messages:002-old`,name:'old',nodeType:'chat-message',data:{broadcastWakes:true}}});
    await db.node.update({where:{id:drifted.id},data:{name:'unrevisioned change'}});
    const { computeRevisionStateHash } = await import('./nodeRevisionSnapshot.js');
    await ensureChannelWithRoot(db, { memoryId, loc: root.loc, name: 'adopt', createdBy: userId });
    const after = await db.node.findUniqueOrThrow({ where: { id: child.id } });
    expect(after.data).toEqual({});
    expect(after.revSeq).toBe(child.revSeq);
    expect(after.revisionContentHash).toBe(await computeRevisionStateHash(db, child.id));
    const {ensureCurrentNodeRevisionInTransaction}=await import('./nodeRevisionSnapshot.js');
    await db.$transaction(tx=>ensureCurrentNodeRevisionInTransaction(tx,drifted.id,{expectedMemoryId:memoryId}));
    expect((await db.node.findUniqueOrThrow({where:{id:drifted.id}})).revSeq).toBe(drifted.revSeq+1);

});
