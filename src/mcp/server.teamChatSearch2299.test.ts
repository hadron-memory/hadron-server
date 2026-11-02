/**
 * #2299 — hadron_team_chat_search answers the SAME contract as the GraphQL fields (cor:agt:020:04, "Searching a chat's
 * history"): the same matches, the same bounds and refusals, no read-state effect. Driven through the real tool, with the
 * posts coming from the real post tool.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { generateDataKey } from '../lib/crypto.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { encryptNodeFieldsWithKey } from '../lib/nodeCrypto.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
let org: { id: string; urn: string };
let admin: { id: string };
let stranger: { id: string };
let app: { id: string; urn: string };
let memoryId: string;
let teamChannelId: string;

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'tcs', urn: `tcs-${t}.com` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 49801, githubUsername: `tcs-a-${t}`, handle: `tcs-a-${t}` } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 49802, githubUsername: `tcs-s-${t}`, handle: `tcs-s-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'ag', urn: `${org.urn}:ag`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-shared`, name: 's', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  memoryId = mem.id;
  teamChannelId = (await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id })).channel.id;
});

function server(userId: string, appId: string | undefined = app.id) {
  const auth = { userId, roles: ['READER'], clientId: `user:${userId}`, appId, organizationId: org.id } as AuthContext;
  return createTestableMcpServer(auth, { sessionId: `tcs-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
}
const post = (s: ReturnType<typeof server>, body: string) => s.callToolText('hadron_team_chat_post', { asMe: true, body });

describe('hadron_team_chat_search', () => {
  it('is a registered, actor-neutral read tool', async () => {
    const s = server(admin.id);
    const out = await s.callToolText('hadron_team_chat_search', { query: 'nothing', app: app.id });
    expect(out).toContain('No matches');
  });

  it('finds the messages the GraphQL search finds, newest first, by team chat and by channel, references only', async () => {
    const s = server(admin.id);
    await post(s, 'Deploy the Staging build');
    await post(s, 'unrelated');
    await post(s, 'DEPLOY again');
    const gql = await Q.teamChatSearch({}, { appRef: app.id, query: 'deploy' }, { db, userId: admin.id, roles: ['READER'] });
    expect(gql.items.map((m: any) => m.seq)).toEqual([3, 1]);
    for (const args of [{ query: 'deploy' }, { query: 'deploy', channel: teamChannelId }]) {
      const out = await s.callToolText('hadron_team_chat_search', args);
      expect(out).toContain('2 match(es)');
      expect(out.indexOf('#3')).toBeLessThan(out.indexOf('#1'));
      expect(out).toContain('reached the start of the history');
      expect(out).not.toMatch(/Staging build|again|unrelated/);
      expect(out).toContain(`channel ${teamChannelId} incarnation`);
    }
  });

  it('keeps the node id when the host memory URN cannot be emitted, so a match is never a bare seq', async () => {
    const s = server(admin.id);
    await post(s, 'Deploy the Staging build');
    const gql = await Q.teamChatSearch({}, { appRef: app.id, query: 'deploy' }, { db, userId: admin.id, roles: ['READER'] });
    expect(gql.items[0].urn).not.toBeNull();
    // A pre-v2 COMPOUND memory urn: the message urn is null, the node id is the only handle left.
    await db.memory.update({ where: { id: memoryId }, data: { urn: `${org.urn}:team:agent-${generateId().slice(0, 8)}:shared` } });
    const nullUrn = await Q.teamChatSearch({}, { appRef: app.id, query: 'deploy' }, { db, userId: admin.id, roles: ['READER'] });
    expect(nullUrn.items[0].urn).toBeNull();
    const out = await s.callToolText('hadron_team_chat_search', { query: 'deploy' });
    expect(out).toContain('#1');
    expect(out).toContain(nullUrn.items[0].nodeId);
  });

  it('refuses the bounds and a bad limit with the typed codes, the same for a stranger', async () => {
    for (const who of [admin.id, stranger.id]) {
      const out = await server(who).callToolText('hadron_team_chat_search', { query: 'x', app: app.id });
      expect(out).toContain('[team_chat_search_query_length]');
    }
    const s = server(admin.id);
    expect(await s.callToolText('hadron_team_chat_search', { query: 'abc', app: app.id, limit: 0 })).toContain('[bad_user_input]');
    expect(await s.callToolText('hadron_team_chat_search', { query: 'abc', app: app.id, cursor: 'junk' })).toContain('[team_chat_search_cursor_invalid]');
  });

  it('continues with the cursor it prints, with no repeat or skip, and says when it stopped early', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: generateId(), memoryId, loc: `chats:team:messages:b${i + 1}`, name: `b${i + 1}`, nodeType: 'chat-message', seq: i + 1, messageChannelId: teamChannelId, content: `needle ${i + 1}`, data: { authorUserId: admin.id, mentions: [] } }));
    await db.node.createMany({ data: rows as never });
    const s = server(admin.id);
    const p1 = await s.callToolText('hadron_team_chat_search', { query: 'needle', limit: 10 });
    expect(p1).toContain('10 match(es)');
    expect(p1).toContain('stopped before the start of the history');
    const cursor = /cursor: (\S+)/.exec(p1)![1]!;
    const p2 = await s.callToolText('hadron_team_chat_search', { query: 'needle', limit: 10, cursor });
    expect(p2).toContain('#20');
    expect(p2).not.toContain('#21');
  });

  it('answers a stranger as the read does, and an encrypted host with the typed refusal', async () => {
    await post(server(admin.id), 'secret needle');
    const denied = await server(stranger.id).callToolText('hadron_team_chat_search', { query: 'needle', app: app.id });
    expect(denied).toContain('[forbidden]');
    const key = generateDataKey();
    sessionKeyCache.set('tcs-2299', memoryId, key);
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    for (const m of await db.node.findMany({ where: { memoryId, nodeType: 'chat-message' } })) {
      const enc = encryptNodeFieldsWithKey({ content: m.content, data: m.data }, key);
      await db.node.update({ where: { id: m.id }, data: { content: enc.content, data: enc.data as never } });
    }
    expect(await server(admin.id).callToolText('hadron_team_chat_search', { query: 'needle', app: app.id })).toContain('[team_chat_search_encrypted]');
    sessionKeyCache.evict('tcs-2299');
  });

  it('moves no read position', async () => {
    const s = server(admin.id);
    await post(s, 'needle one');
    const snap = async () => JSON.stringify({ states: await db.channelReadState.findMany({ orderBy: { id: 'asc' } }), channel: await db.channel.findUnique({ where: { id: teamChannelId } }) });
    const before = await snap();
    await s.callToolText('hadron_team_chat_search', { query: 'needle', app: app.id });
    await s.callToolText('hadron_team_chat_search', { query: 'needle', channel: teamChannelId });
    expect(await snap()).toBe(before);
  });
});
