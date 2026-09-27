/**
 * #939 — the hadron_team_chat_post / hadron_team_chat_read MCP tools: THIN
 * delegation to resolvers.Mutation.createTeamChatMessage /
 * resolvers.Query.teamChatMessages (findings:node-write-surface-invariants —
 * MCP tools delegate, never re-implement). Pins the delegation round trip,
 * the active-App default (same shape as hadron_cast_worker), and the
 * principal-shape behavior at the tool level: a pure App-key principal is
 * refused for post but reads its own team chat.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let app: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-teamchat-org', urn: `mcp-teamchat-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 93920, githubUsername: `mcp-tc-admin-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const ctx: Context = { db, userId: admin.id, roles: ['READER'] };
  const teamAgent = await M.createAgent({}, { orgId: org.id, name: 'MCP Team Agent 939' }, ctx);
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: teamAgent.systemMemoryId,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      content: 'You are {{name}}, a {{role}}.',
      data: { names: ['Iris'] },
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'MCP Team App 939', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
});

function hybridAuth(userId: string): AuthContext {
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}

describe('hadron_team_chat_post / hadron_team_chat_read (#939)', () => {
  it('posts via the active-App selection and reads it back with a watermark', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const posted = await srv.callToolText('hadron_team_chat_post', { body: 'hello @Iris' });
    expect(posted).toContain('Posted team-chat message #1');
    expect(posted).toContain('@iris');

    const readAll = await srv.callToolText('hadron_team_chat_read', {});
    expect(readAll).toContain('1 message(s) total');
    expect(readAll).toContain('hello @Iris');

    const afterWatermark = await srv.callToolText('hadron_team_chat_read', { sinceSeq: 1 });
    expect(afterWatermark).toContain('no matching messages');

    // The full operation ran server-side: a real chat-message node exists.
    const row = await db.node.findFirst({ where: { nodeType: 'chat-message' } });
    expect(row).not.toBeNull();
    expect(row!.seq).toBe(1);
  });

  /**
   * #1116 — the MCP tool is a THIN wrapper, and an argument it does not forward
   * fails in the worst possible way: MCP drops unknown arguments, so a caller
   * passing `beforeSeq` to a server that ignores it is handed the OLDEST page
   * in silence. Not an error, not an empty result — the wrong end of the
   * conversation, looking exactly like the right one. (Codex P2 on PR #1119.)
   */
  it('forwards beforeSeq, so a backward page is not silently the oldest one', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    for (let i = 1; i <= 6; i++) {
      await srv.callToolText('hadron_team_chat_post', { body: `msg-${i}` });
    }

    const page = await srv.callToolText('hadron_team_chat_read', { beforeSeq: 5, limit: 2 });
    // The two immediately BEFORE seq 5.
    expect(page).toContain('msg-3');
    expect(page).toContain('msg-4');
    // An unforwarded beforeSeq yields the oldest page, which is this:
    expect(page).not.toContain('msg-1');
    expect(page).not.toContain('msg-2');
    // And never the cursor itself, nor anything after it.
    expect(page).not.toContain('msg-5');
    expect(page).not.toContain('msg-6');
  });

  it('accepts an explicit app URN and a replyToSeq', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    await srv.callToolText('hadron_team_chat_post', { body: 'question?', app: app.urn });
    const out = await srv.callToolText('hadron_team_chat_post', {
      body: 'answer.',
      app: app.urn,
      replyToSeq: 1,
    });
    expect(out).toContain('Posted team-chat message #2');
    expect(out).toContain('in reply to #1');
  });

  it('a pure App-key principal is refused for post but reads its own team chat', async () => {
    const member = createTestableMcpServer(hybridAuth(admin.id));
    await member.callToolText('hadron_team_chat_post', { body: 'for the automation' });

    const appKey = createTestableMcpServer({ appId: app.id, clientId: `app:${app.id}` });
    const denied = await appKey.callToolText('hadron_team_chat_post', { body: 'as the App' });
    expect(denied).toContain('Error:');
    expect(denied).toContain('not authorized');

    const readBack = await appKey.callToolText('hadron_team_chat_read', {});
    expect(readBack).toContain('for the automation');
  });

  it('an App key bound to a session cannot widen its team-chat read with an explicit session', async () => {
    const member = createTestableMcpServer(hybridAuth(admin.id));
    await member.callToolText('hadron_team_chat_post', { body: 'team-only message' });
    const { agentId } = await db.appAgent.findFirstOrThrow({ where: { appId: app.id }, select: { agentId: true } });
    const sessionMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:session`,
        name: 'session', class: 'app', appId: app.id, userMemoryOfAgentId: agentId,
      },
    });
    const session = await db.session.create({
      data: { id: generateId(), appId: app.id, agentId, memoryId: sessionMemory.id },
    });
    const appKey = createTestableMcpServer({ appId: app.id, sessionId: session.id, clientId: `app:${app.id}` });

    for (const args of [{}, { session: session.id }]) {
      const readBack = await appKey.callToolText('hadron_team_chat_read', args);
      expect(readBack).toContain('no matching messages');
      expect(readBack).not.toContain('team-only message');
    }
  });

  it('surfaces typed refusals as tool text', async () => {
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const out = await srv.callToolText('hadron_team_chat_post', { body: 'reply', replyToSeq: 42 });
    expect(out).toContain('Error:');
    expect(out).toContain('42');
  });
});
