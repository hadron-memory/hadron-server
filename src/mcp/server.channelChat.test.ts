/**
 * Spec 049 Phase 8 — Channel-addressed chat on the MCP surface: the new
 * hadron_channel_post / hadron_channel_read tools, and the `channel` selector
 * on hadron_team_chat_post / hadron_team_chat_read, all through the one
 * Channel core; refusals come back as `[code]` text envelopes.
 */

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

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let app: { id: string; urn: string };
let release: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
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

describe('Channel-addressed chat tools', () => {
  it('post → read on a Channel by id, and the team-chat tools route through `channel`', async () => {
    const s = server(admin.id);
    const posted = await s.callToolText('hadron_channel_post', { channel: release.id, body: 'cut the release @nobody', asMe: true });
    expect(posted).toContain('Posted message #1 in Channel release (chats:release)');
    expect(posted).toContain('mentions: @nobody');
    const viaTeam = await s.callToolText('hadron_team_chat_post', { body: 'second', channel: release.id, replyToSeq: 1 });
    expect(viaTeam).toContain('Posted message #2 in Channel release (chats:release)');
    expect(viaTeam).toContain('in reply to #1');
    const read = await s.callToolText('hadron_channel_read', { channel: release.id });
    expect(read).toContain('2 message(s) total');
    expect(read).toContain('#2 [');
    expect(await s.callToolText('hadron_team_chat_read', { channel: release.id, sinceSeq: 1 })).toContain('1 message(s) total');
    // The default team Channel is untouched by the release traffic.
    expect(await s.callToolText('hadron_team_chat_read', {})).toContain('no matching messages');
  });

  it('a Channel the caller may not read is [channel_not_found]; a bad ref too', async () => {
    const s = server(member.id);
    expect(await s.callToolText('hadron_channel_read', { channel: release.id })).toMatch(/^\[channel_not_found\]/);
    expect(await s.callToolText('hadron_channel_post', { channel: release.id, body: 'x', asMe: true })).toMatch(/^\[channel_not_found\]/);
    expect(await server(admin.id).callToolText('hadron_channel_read', { channel: 'nope' })).toMatch(/^\[channel_not_found\]/);
  });

  it('an App key with a bound session keeps that memory scope when read names a Worker session', async () => {
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    const sessionMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:session`,
        name: 'session', class: 'app', appId: app.id, userMemoryOfAgentId: agent.id,
      },
    });
    const ownChannel = (await ensureChannelWithRoot(db, {
      memoryId: sessionMemory.id, loc: 'chats:session', name: 'session', createdBy: admin.id,
    })).channel;
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, agentId: agent.id, memoryId: sessionMemory.id },
    });
    const appKey = createTestableMcpServer(
      { appId: app.id, sessionId: session.id, roles: [] } as AuthContext,
      { sessionId: `ccm-app-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } },
    );

    expect(await appKey.callToolText('hadron_channel_read', { channel: ownChannel.id, session: session.id }))
      .toContain('no matching messages');
    expect(await appKey.callToolText('hadron_channel_read', { channel: release.id, session: session.id }))
      .toMatch(/^\[channel_not_found\]/);
  });
});

describe('#1171 — the address on the MCP channel tools', () => {
  it('lists the address, posts and reads by it, and names the Channel in the receipt', async () => {
    const s = server(admin.id);
    const mem = await db.memory.findFirstOrThrow({ where: { appId: app.id }, select: { urn: true } });
    const address = `hrn:node:${mem.urn}:chats:release`;
    // The listing PRINTS the address, so an agent never composes one.
    const listed = await s.callToolText('hadron_list_channels', {});
    expect(listed).toContain(`address: ${address}`);
    // …and the tools take back exactly what was printed. The receipt naming
    // the Channel is the part that regresses silently: the display lookup used
    // to be by id, so an address-addressed post would have echoed the ref.
    expect(await s.callToolText('hadron_channel_post', { channel: address, body: 'by address', asMe: true })).toContain(
      'Posted message #1 in Channel release (chats:release)',
    );
    expect(await s.callToolText('hadron_channel_read', { channel: address })).toContain('1 message(s) total');
    expect(await s.callToolText('hadron_team_chat_post', { channel: address, body: 'again' })).toContain('Posted message #2');
    expect(await s.callToolText('hadron_channel_read', { channel: `hrn:node:${mem.urn}:chats:absent` })).toMatch(/^\[channel_not_found\]/);
  });
});
