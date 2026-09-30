/**
 * #1503 — a strict owner keeps direct rights over their App-scoped
 * personal/private memory while ANOTHER App is selected, on every MCP surface.
 *
 * On MCP, `auth.appId` on a user credential is a SELECTION (connection state),
 * not a credential (findings:auth-appid-credential-vs-selection). #1500 taught
 * the GraphQL write gate that App selection does not remove direct ownership,
 * but the shared MCP gates (`canWriteToMemory`, `canReadMemoryRow`) still
 * demanded `memory.appId === auth.appId`. So for the same owner and memory:
 * `hadron_replace_text` (delegating to GraphQL) wrote, `hadron_update_node`
 * was refused, and `hadron_get_node` could not read it (cor:acl:010:02: the
 * direct owner needs no subscription; cor:acl:020:01: an explicit reference
 * outranks App selection).
 *
 * The negative controls pin what the fix must NOT grant: a pure App key (of
 * either App), a platform OWNER with the other App selected, and the owner
 * inside a bound session (a session must not become a way out of its scope).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { canReadMemory, canWriteToMemory } from './access-control.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let org: { id: string };
let owner: { id: string };
let admin: { id: string };
let appA: { id: string };
let appB: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'org-1503', urn: 'org-1503.example' } });
  owner = await db.user.create({ data: { githubId: 150301, githubUsername: 'owner-1503', roles: ['READER'] } });
  admin = await db.user.create({ data: { githubId: 150302, githubUsername: 'admin-1503', roles: ['OWNER'] } });
  for (const u of [owner, admin]) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: 'ADMIN' } });
  }
  appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App A', urn: 'org-1503.example:app-a' } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App B', urn: 'org-1503.example:app-b' } });
});

/** The owner's personal/private memory, scoped to App A, with one node. No AgentSubscription: direct ownership needs none. */
async function ownedAppScopedMemory(memoryClass: 'personal' | 'private') {
  const ownerCtx: Context = { db, userId: owner.id, roles: ['READER'] };
  const mem = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: `${memoryClass}-1503`, memoryClass } as never, ownerCtx);
  const agent = await db.agent.create({ data: {
    id: generateId(), organizationId: org.id, urn: `org-1503.example:${memoryClass}-agent`, name: `${memoryClass} agent`,
    type: 'CHATBOT', surfaces: ['api'],
  } });
  await db.memory.update({ where: { id: mem.id }, data: { appId: appA.id, userMemoryOfAgentId: agent.id } });
  const node = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'sentinel', name: 'sentinel', content: 'cat sentinel' } });
  return { mem, node, urn: `hrn:node:${mem.urn}:sentinel` };
}

const userSelecting = (userId: string, appId: string, extra: Partial<AuthContext> = {}): AuthContext => ({
  userId, appId, roles: userId === admin.id ? ['OWNER'] : ['READER'], clientId: `user:${userId}`, ...extra,
});
const content = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).content;

describe.each(['personal', 'private'] as const)('#1503 — %s memory scoped to App A, App B selected', (memoryClass) => {
  it('the owner can update_node, replace_text and get_node alike (parity)', async () => {
    const { mem, node, urn } = await ownedAppScopedMemory(memoryClass);
    const mcp = createTestableMcpServer(userSelecting(owner.id, appB.id));

    const read = await mcp.callToolText('hadron_get_node', { urn });
    expect(read).toContain('cat sentinel');
    // The read surfaces that go through the batch filter or GraphQL agree.
    expect(await mcp.callToolText('hadron_get_nodes', { refs: [urn] })).toContain('returned 1 node');
    expect(await mcp.callToolText('hadron_list_nodes', { memoryUrn: `hrn:mem:${mem.urn}` })).toContain(`${mem.urn}:sentinel`);
    expect(await mcp.callToolText('hadron_find_nodes', { query: 'sentinel', memoryUrn: `hrn:mem:${mem.urn}` } as never)).toContain('Found 1 node');

    const updated = await mcp.callToolText('hadron_update_node', { urn, content: 'dog sentinel' });
    expect(updated).not.toMatch(/forbidden|not found|denied/i);
    expect(await content(node.id)).toBe('dog sentinel');

    await mcp.callToolText('hadron_replace_text', { oldText: 'dog', newText: 'cow', nodeUrns: [urn], fields: ['content'] });
    expect(await content(node.id)).toBe('cow sentinel');
  });

  it('CONTROL: a pure App key of either App is refused, and nothing is written', async () => {
    const { node, urn } = await ownedAppScopedMemory(memoryClass);
    for (const appId of [appA.id, appB.id]) {
      const mcp = createTestableMcpServer({ appId, clientId: `app:${appId}` });
      await mcp.callToolText('hadron_update_node', { urn, content: 'app key wrote' });
    }
    expect(await content(node.id)).toBe('cat sentinel');
    const memId = (await db.node.findUniqueOrThrow({ where: { id: node.id } })).memoryId;
    expect(await canWriteToMemory(db, { appId: appB.id }, memId)).toBe(false);
    expect(await canReadMemory(db, { appId: appB.id }, memId)).toBe(false);
  });

  it('CONTROL: a platform OWNER with App B selected is refused on every surface', async () => {
    const { node, urn } = await ownedAppScopedMemory(memoryClass);
    const mcp = createTestableMcpServer(userSelecting(admin.id, appB.id));
    expect(await mcp.callToolText('hadron_get_node', { urn })).not.toContain('cat sentinel');
    await mcp.callToolText('hadron_update_node', { urn, content: 'admin wrote' });
    await mcp.callToolText('hadron_replace_text', { oldText: 'cat', newText: 'admin', nodeUrns: [urn], fields: ['content'] });
    expect(await content(node.id)).toBe('cat sentinel');
  });

  it('CONTROL: an impersonation of the owner gets no selection-independent shortcut', async () => {
    const { mem } = await ownedAppScopedMemory(memoryClass);
    const impersonating: AuthContext = {
      userId: owner.id, roles: [], appId: appB.id,
      impersonation: { sessionId: generateId(), actorUserId: admin.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) },
    };
    expect(await canWriteToMemory(db, impersonating, mem.id)).toBe(false);
    expect(await canReadMemory(db, impersonating, mem.id)).toBe(false);
  });

  it('CONTROL: inside a bound session the owner gets no selection-independent shortcut', async () => {
    const { mem } = await ownedAppScopedMemory(memoryClass);
    const inSession = userSelecting(owner.id, appB.id, { sessionId: generateId() });
    expect(await canWriteToMemory(db, inSession, mem.id)).toBe(false);
    expect(await canReadMemory(db, inSession, mem.id)).toBe(false);
  });
});
