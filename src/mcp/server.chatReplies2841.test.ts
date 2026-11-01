import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({
    writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
    syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));
let org: {
    id: string;
    urn: string;
};
let admin: {
    id: string;
};
let member: {
    id: string;
};
let app: {
    id: string;
    urn: string;
};
let release: {
    id: string;
};
beforeEach(async () => {
    await cleanDb(db);
    const t = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    org = await db.organization.create({ data: { id: generateId(), name: 'ccm', urn: `ccm-${t}.com` } });
    admin = await db.user.create({ data: { id: generateId(), githubId: 49701, githubUsername: `ccm-admin-${t}`, handle: `ccm-admin-${t}` } });
    member = await db.user.create({ data: { id: generateId(), githubId: 49702, githubUsername: `ccm-member-${t}`, handle: `ccm-member-${t}` } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } });
    await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'ag', urn: `${org.urn}:ag`, visibility: 'ORGANIZATION' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-shared`, name: 's', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
    await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id });
    release = (await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:release', name: 'release', createdBy: admin.id })).channel;
});
function server(userId: string) {
    const auth = { userId, roles: ['READER'], clientId: `user:${userId}`, appId: app.id, organizationId: org.id } as AuthContext;
    return createTestableMcpServer(auth, { sessionId: `ccm-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
}
import { buildSchema } from 'graphql';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { generateDataKey } from '../lib/crypto.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { encryptNodeFieldsWithKey } from '../lib/nodeCrypto.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
const Q = resolvers.Query as any;
const context = (userId = admin.id) => ({ db, userId, roles: ['READER'] });
async function fixture(encrypted: boolean) {
    const s = server(admin.id);
    await s.callToolText('hadron_team_chat_post', { asMe: true, body: 'target' });
    const author = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    await s.callToolText('hadron_team_chat_post', { asMe: true, body: `reply A @${author.handle}`, replyToSeq: 1 });
    await s.callToolText('hadron_team_chat_post', { asMe: true, body: 'unrelated' });
    await s.callToolText('hadron_team_chat_post', { asMe: true, body: 'reply B', replyToSeq: 1 });
    await s.callToolText('hadron_team_chat_post', { asMe: true, body: 'nested', replyToSeq: 2 });
    const channel = await db.channel.findFirstOrThrow({ where: { memory: { appId: app.id }, name: 'team' } });
    if (encrypted) {
        const key = generateDataKey();
        sessionKeyCache.set('reply2841', channel.memoryId, key);
        await db.memory.update({ where: { id: channel.memoryId }, data: { isEncrypted: true } });
        for (const m of await db.node.findMany({ where: { memoryId: channel.memoryId, nodeType: 'chat-message' } })) {
            const enc = encryptNodeFieldsWithKey({ content: m.content, data: m.data }, key);
            await db.node.update({ where: { id: m.id }, data: { content: enc.content, data: enc.data as never } });
        }
    }
    return { s, channel };
}
const seqs = (p: any) => p.items.map((m: any) => m.seq);
const code = async (p: Promise<unknown>) => { try {
    await p;
    return 'SUCCESS';
}
catch (e: any) {
    return e.extensions?.code;
} };
it('exposes the filter on both GraphQL read fields', () => {
    const query = buildSchema(typeDefs).getQueryType()!.getFields();
    for (const field of ['teamChatMessages', 'channelMessages'])
        expect(query[field].args.some(a => a.name === 'replyToSeq')).toBe(true);
});
for (const encrypted of [false, true])
    describe(`reply filter encrypted=${encrypted}`, () => {
        it('direct replies only, same total, AND cursors and untagged, paging and count', async () => {
            const { channel } = await fixture(encrypted);
            for (const [field, ref] of [['teamChatMessages', { appRef: app.id }], ['channelMessages', { channelRef: channel.id }]] as const) {
                const read = (args: any = {}) => Q[field]({}, { ...ref, replyToSeq: 1, ...args }, context());
                expect(await read()).toMatchObject({ total: 2 });
                expect(seqs(await read())).toEqual([2, 4]);
                expect(seqs(await read({ sinceSeq: 2, untagged: true }))).toEqual([4]);
                expect(await read({ untagged: false })).toMatchObject({ items: [], total: 0 });
                expect(seqs(await read({ beforeSeq: 4 }))).toEqual([2]);
                expect(seqs(await read({ mentionsRef: admin.id }))).toEqual([2]);
                expect(seqs(await read({ offset: 1, limit: 1 }))).toEqual([4]);
                expect(await read({ limit: 0 })).toMatchObject({ items: [], total: 2 });
                expect(await read({ replyToSeq: 3 })).toMatchObject({ items: [], total: 0 });
            }
        });
        it('validates canonical target outside cursor window; missing, deleted and off-road refuse', async () => {
            const { channel } = await fixture(encrypted);
            const read = (replyToSeq: number) => Q.channelMessages({}, { channelRef: channel.id, replyToSeq, sinceSeq: 3 }, context());
            expect(seqs(await read(1))).toEqual([4]);
            expect(await code(read(900))).toBe('TEAM_CHAT_REPLY_NOT_FOUND');
            await db.node.create({ data: { memoryId: channel.memoryId, loc: 'chats:team:messages:offroad', name: 'not a message', seq: 900, nodeType: 'info' } });
            expect(await code(read(900))).toBe('TEAM_CHAT_REPLY_NOT_FOUND');
            const target = await db.node.findFirstOrThrow({ where: { memoryId: channel.memoryId, seq: 1 } });
            await db.node.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
            expect(await code(read(1))).toBe('TEAM_CHAT_REPLY_NOT_FOUND');
        });


    });


it('envelope is authoritative, not the reply edge, and the target can never return itself', async () => {
    const { channel } = await fixture(false);
    const target = await db.node.findFirstOrThrow({ where: { memoryId: channel.memoryId, seq: 1 } });
    await db.node.update({ where: { id: target.id }, data: { data: { ...(target.data as object), replyToSeq: 1 } } });
    await db.edge.deleteMany({ where: { source: { memoryId: channel.memoryId }, name: 'replies-to' } });
    const page = await Q.channelMessages({}, { channelRef: channel.id, replyToSeq: 1 }, context());
    expect(seqs(page)).toEqual([2, 4]);
    expect(page.total).toBe(2);
});
it('a readable App with no canonical chat refuses a requested reply target without provisioning', async () => {
    const other = await db.app.create({ data: { organizationId: org.id, name: 'Empty', urn: `${org.urn}:empty` } });
    expect(await code(Q.teamChatMessages({}, { appRef: other.id, replyToSeq: 1 }, context()))).toBe('TEAM_CHAT_REPLY_NOT_FOUND');
    expect(await db.channel.count({ where: { memory: { appId: other.id } } })).toBe(0);
});
it('target existence is scoped to this Channel and memory, not a sibling or another tenant', async () => {
    const { channel } = await fixture(false);
    expect(await code(Q.channelMessages({}, { channelRef: release.id, replyToSeq: 3 }, context()))).toBe('TEAM_CHAT_REPLY_NOT_FOUND');
    const otherOrg = await db.organization.create({ data: { name: 'Other tenant', urn: `other-${generateId()}.com` } });
    const otherMemory = await db.memory.create({ data: { organizationId: otherOrg.id, name: 'Other memory', urn: `${otherOrg.urn}:chat`, class: 'knowledge' } });
    await ensureChannelWithRoot(db, { memoryId: otherMemory.id, loc: 'chats:team', name: 'team', createdBy: admin.id });
    await db.node.create({ data: { memoryId: otherMemory.id, loc: 'chats:team:messages:foreign', name: 'foreign target', nodeType: 'chat-message', seq: 900, content: 'other tenant', data: {} } });
    expect(await code(Q.channelMessages({}, { channelRef: channel.id, replyToSeq: 900 }, context()))).toBe('TEAM_CHAT_REPLY_NOT_FOUND');
});
// #3082: wrapper-only selector matrix retired; GraphQL selector cases remain above.
