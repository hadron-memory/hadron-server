/**
 * #1503, Holger's ruling (c) of 2026-10-01: an explicit reference to the
 * caller's OWN personal/private memory that belongs to App A, made while App B
 * is selected, is evaluated as App A. An explicit reference outranks the
 * selection (`cor:acl:020:01`). App isolation and the FR-019 subscription
 * check then run against App A, so:
 *
 * - the owner can read and write it by naming it, and every MCP surface agrees
 *   (before the fix `hadron_replace_text` wrote through GraphQL's #1500
 *   shortcut while `hadron_update_node` and `hadron_get_node` refused);
 * - listings stay confined to the selected App;
 * - the substitution needs exactly what selecting App A would need (a live
 *   AppMember row on a live App), plus the active subscription;
 * - a bound session, an impersonation, a pure App key and a platform OWNER get
 *   nothing from it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { canReadMemory, canWriteToMemory, filterReadableMemoryIds } from './access-control.js';

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
  // The owner could select either App.
  for (const app of [appA, appB]) {
    await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'owner' } });
  }
});

/** The owner's personal/private memory in App A (with an active subscription to its Agent), holding one node. */
async function ownedAppAMemory(memoryClass: 'personal' | 'private') {
  const ownerCtx: Context = { db, userId: owner.id, roles: ['READER'] };
  const mem = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: `${memoryClass}-1503`, memoryClass } as never, ownerCtx);
  const agent = await db.agent.create({ data: {
    id: generateId(), organizationId: org.id, urn: `org-1503.example:${memoryClass}-agent`, name: `${memoryClass} agent`,
    type: 'CHATBOT', surfaces: ['api'],
  } });
  await db.memory.update({ where: { id: mem.id }, data: { appId: appA.id, userMemoryOfAgentId: agent.id } });
  await db.agentSubscription.create({ data: { userId: owner.id, agentId: agent.id, activatedAt: new Date() } });
  const node = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'sentinel', name: 'sentinel', content: 'cat sentinel' } });
  return { mem, agent, node, urn: `hrn:node:${mem.urn}:sentinel`, memUrn: `hrn:mem:${mem.urn}` };
}

const userSelecting = (userId: string, appId: string, extra: Partial<AuthContext> = {}): AuthContext => ({
  userId, appId, roles: userId === admin.id ? ['OWNER'] : ['READER'], clientId: `user:${userId}`, ...extra,
});
const content = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).content;

/** Both write tools try; returns the node's content afterwards. */
async function tryBothWrites(auth: AuthContext, urn: string, nodeId: string): Promise<string | null> {
  const mcp = createTestableMcpServer(auth);
  await mcp.callToolText('hadron_update_node', { urn, content: 'update_node wrote' });
  await mcp.callToolText('hadron_replace_text', { oldText: 'cat', newText: 'replace_text', nodeUrns: [urn], fields: ['content'] });
  return content(nodeId);
}

describe.each(['personal', 'private'] as const)('#1503 (c): own %s memory in App A, App B selected', (memoryClass) => {
  it('an explicit reference is evaluated as App A: every read and write surface agrees', async () => {
    const { mem, node, urn, memUrn } = await ownedAppAMemory(memoryClass);
    const mcp = createTestableMcpServer(userSelecting(owner.id, appB.id));

    expect(await mcp.callToolText('hadron_get_node', { urn })).toContain('cat sentinel');
    expect(await mcp.callToolText('hadron_get_nodes', { refs: [urn] })).toContain('returned 1 node');
    expect(await mcp.callToolText('hadron_list_nodes', { memoryUrn: memUrn })).toContain(`${mem.urn}:sentinel`);
    expect(await mcp.callToolText('hadron_find_nodes', { query: 'sentinel', memoryUrn: memUrn } as never)).toContain('Found 1 node');

    const updated = await mcp.callToolText('hadron_update_node', { urn, content: 'dog sentinel' });
    expect(updated).not.toMatch(/forbidden|not found|denied/i);
    expect(await content(node.id)).toBe('dog sentinel');

    await mcp.callToolText('hadron_replace_text', { oldText: 'dog', newText: 'cow', nodeUrns: [urn], fields: ['content'] });
    expect(await content(node.id)).toBe('cow sentinel');
  });

  it('a listing stays with the selected App: hadron_list_memories under App B omits it, under App A shows it', async () => {
    const { mem } = await ownedAppAMemory(memoryClass);
    const underB = await createTestableMcpServer(userSelecting(owner.id, appB.id)).callToolText('hadron_list_memories', {});
    expect(underB).not.toContain(mem.urn);
    const underA = await createTestableMcpServer(userSelecting(owner.id, appA.id)).callToolText('hadron_list_memories', {});
    expect(underA).toContain(mem.urn);
  });

  it('discovery stays with the selected App: the batch gate and an unscoped hadron_list_nodes omit it', async () => {
    const { mem } = await ownedAppAMemory(memoryClass);
    const auth = userSelecting(owner.id, appB.id);
    expect([...await filterReadableMemoryIds(db, auth, [mem.id])]).toEqual([]);
    expect([...await filterReadableMemoryIds(db, userSelecting(owner.id, appA.id), [mem.id])]).toEqual([mem.id]);
    const browse = await createTestableMcpServer(auth).callToolText('hadron_list_nodes', {});
    expect(browse).not.toContain(`${mem.urn}:sentinel`);
  });

  it('the gates expose the listing mode: selectionOnly keeps the selected App', async () => {
    const { mem } = await ownedAppAMemory(memoryClass);
    const auth = userSelecting(owner.id, appB.id);
    expect(await canReadMemory(db, auth, mem.id)).toBe(true);
    expect(await canWriteToMemory(db, auth, mem.id)).toBe(true);
    expect(await canReadMemory(db, auth, mem.id, { selectionOnly: true })).toBe(false);
    expect(await canWriteToMemory(db, auth, mem.id, { selectionOnly: true })).toBe(false);
  });

  it('REFUSED when the owner could not select App A (no AppMember row): both write tools and the read agree', async () => {
    const { node, urn } = await ownedAppAMemory(memoryClass);
    await db.appMember.delete({ where: { appId_userId: { appId: appA.id, userId: owner.id } } });
    expect(await createTestableMcpServer(userSelecting(owner.id, appB.id)).callToolText('hadron_get_node', { urn }))
      .not.toContain('cat sentinel');
    expect(await tryBothWrites(userSelecting(owner.id, appB.id), urn, node.id)).toBe('cat sentinel');
  });

  it('REFUSED when App A is uninstalled', async () => {
    const { node, urn } = await ownedAppAMemory(memoryClass);
    await db.app.update({ where: { id: appA.id }, data: { uninstalledAt: new Date() } });
    expect(await tryBothWrites(userSelecting(owner.id, appB.id), urn, node.id)).toBe('cat sentinel');
  });

  it('REFUSED when the subscription to App A\'s Agent is revoked (FR-019 still applies, against App A)', async () => {
    const { agent, node, urn, mem } = await ownedAppAMemory(memoryClass);
    await db.agentSubscription.update({
      where: { userId_agentId: { userId: owner.id, agentId: agent.id } },
      data: { revokedAt: new Date() },
    });
    expect(await tryBothWrites(userSelecting(owner.id, appB.id), urn, node.id)).toBe('cat sentinel');
    expect(await canReadMemory(db, userSelecting(owner.id, appB.id), mem.id)).toBe(false);
  });

  it('CONTROL: a pure App key of either App is refused, and nothing is written', async () => {
    const { mem, node, urn } = await ownedAppAMemory(memoryClass);
    for (const appId of [appA.id, appB.id]) {
      expect(await tryBothWrites({ appId, clientId: `app:${appId}` }, urn, node.id)).toBe('cat sentinel');
      expect(await canWriteToMemory(db, { appId }, mem.id)).toBe(false);
      expect(await canReadMemory(db, { appId }, mem.id)).toBe(false);
    }
  });

  it('CONTROL: a platform OWNER with App B selected is refused on every surface', async () => {
    const { node, urn } = await ownedAppAMemory(memoryClass);
    await db.appMember.create({ data: { appId: appA.id, userId: admin.id, role: 'owner' } });
    expect(await createTestableMcpServer(userSelecting(admin.id, appB.id)).callToolText('hadron_get_node', { urn }))
      .not.toContain('cat sentinel');
    expect(await tryBothWrites(userSelecting(admin.id, appB.id), urn, node.id)).toBe('cat sentinel');
  });

  it('CONTROL: an impersonation of the owner is not substituted', async () => {
    const { mem } = await ownedAppAMemory(memoryClass);
    const impersonating: AuthContext = {
      userId: owner.id, roles: [], appId: appB.id,
      impersonation: { sessionId: generateId(), actorUserId: admin.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) },
    };
    expect(await canWriteToMemory(db, impersonating, mem.id)).toBe(false);
    expect(await canReadMemory(db, impersonating, mem.id)).toBe(false);
  });

  it('CONTROL: inside a bound session the owner is not substituted (a session must not leave its App)', async () => {
    const { mem } = await ownedAppAMemory(memoryClass);
    const inSession = userSelecting(owner.id, appB.id, { sessionId: generateId() });
    expect(await canWriteToMemory(db, inSession, mem.id)).toBe(false);
    expect(await canReadMemory(db, inSession, mem.id)).toBe(false);
  });
});
