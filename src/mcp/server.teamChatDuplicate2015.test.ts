/**
 * #2015 — hadron_team_chat_post over MCP: a worker's identical repeat is refused with the earlier seq in the
 * TEXT (this tool renders only the message, never the typed fields), and a post as the human is not
 * judged. Fixtures follow server.teamChat.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';

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
let agentId: string;

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
  agentId = teamAgent.id;
});

function hybridAuth(userId: string): AuthContext {
  return { userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}` };
}


describe('hadron_team_chat_post duplicate refusal (#2015)', () => {
  it('refuses a worker\'s identical repeat, naming the earlier seq in the text; asMe is not judged', async () => {
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Iris', slug: 'iris', heldByUserId: admin.id, heldAt: new Date() }, select: { id: true } });
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: admin.id, workerId: worker.id, agentId, type: 'DEVELOPER', startedAt: new Date() } });
    const srv = createTestableMcpServer(hybridAuth(admin.id));
    const first = await srv.callToolText('hadron_team_chat_post', { session: session.id, body: 'deploy is green' });
    expect(first).toMatch(/Posted team-chat message #1/);
    const repeat = await srv.callToolText('hadron_team_chat_post', { session: session.id, body: 'deploy is green' });
    // this tool renders `Error: <message>` (no bracketed code), so the message alone must carry the earlier seq
    expect(repeat).toMatch(/^Error: Identical to your message #1 in this Channel, which was posted/);
    expect(repeat).toMatch(/do not retry/i);
    // nothing was stored for it: the next post takes seq 2
    expect(await srv.callToolText('hadron_team_chat_post', { session: session.id, body: 'something else' })).toMatch(/Posted team-chat message #2/);
    // a post as the human twice both land
    expect(await srv.callToolText('hadron_team_chat_post', { asMe: true, body: 'standup' })).toMatch(/Posted team-chat message #3/);
    expect(await srv.callToolText('hadron_team_chat_post', { asMe: true, body: 'standup' })).toMatch(/Posted team-chat message #4/);
  });
});
