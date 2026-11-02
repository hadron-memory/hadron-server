/**
 * App-Key WITHOUT an active session — hadron_find_nodes must return the App's
 * agent-linked nodes, not an empty envelope.
 *
 * Regression (2026-08-14): resolvers' getAccessibleMemoryIds kept a
 * Station-era "management-only context, no memory access" branch that
 * returned [] for an App key with no session. The MCP pre-scope gates
 * (canReadMemory / getAppMemoryAccess) DO grant that key its agent's
 * memories, so hadron_get_node / hadron_list_nodes / hadron_search all
 * worked while every findNodes-delegating search (#403) intersected its
 * scope to empty: hadron_find_nodes answered "No nodes found" for EVERY
 * query — keyword, survey mode ("*"), memoryUrn-scoped, allMemories.
 *
 * This file pins the parity: the same key that can hadron_get_node a node
 * can find it via hadron_find_nodes, in every scope shape — and still never
 * sees a memory outside its agent's reach.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode, createDbAppMember } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Fixture {
  appId: string;
  userId: string;
  linkedMemory: { id: string; urn: string };
  foreignMemory: { id: string; urn: string };
}

let fx: Fixture;

function appKeyAuth(): AuthContext {
  // App-Key, NO session — no userId, no roles. (#1376: a bare key no longer folds item-linked org knowledge.)
  return { appId: fx.appId, organizationId: undefined };
}

// A principal with a user behind it (an AppMember) keeps the item fold — the reach semantics under test.
function memberAuth(): AuthContext {
  return { appId: fx.appId, userId: fx.userId, organizationId: undefined };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'aknoses-org', urn: 'aknoses-org' },
  });
  const otherOrg = await db.organization.create({
    data: { id: generateId(), name: 'aknoses-other', urn: 'aknoses-other' },
  });

  const mkMemory = async (orgRow: { id: string; urn: string }, slug: string) =>
    db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgRow.id,
        urn: `${orgRow.urn}::${slug}`,
        name: slug,
        class: 'knowledge' as never,
      },
    });

  // A memory the App's agent is linked to, and a foreign memory in another
  // org that must stay invisible in every scope shape.
  const linkedMemory = await mkMemory(org, 'linked-mem');
  const foreignMemory = await mkMemory(otherOrg, 'foreign-mem');

  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}::aknoses-agent`,
      name: 'aknoses agent',
      memoryItems: { create: [{ memoryId: linkedMemory.id, role: 'read' }] },
    },
  });

  const app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}::aknoses-app`,
      name: 'aknoses app',
      appAgents: { create: { agentId: agent.id } },
    },
  });

  const user = await db.user.create({ data: { id: generateId(), name: 'aknoses-member' } });
  await createDbAppMember(db, app.id, user.id, 'member');

  await createDbNode(db, {
    memoryId: linkedMemory.id,
    loc: 'alpha-linked',
    name: 'alpha in the linked memory',
  });
  await createDbNode(db, {
    memoryId: foreignMemory.id,
    loc: 'alpha-foreign',
    name: 'alpha in the foreign memory',
  });

  fx = {
    appId: app.id,
    userId: user.id,
    linkedMemory: { id: linkedMemory.id, urn: linkedMemory.urn },
    foreignMemory: { id: foreignMemory.id, urn: foreignMemory.urn },
  };
});

describe('hadron_find_nodes — App-Key without a session sees its agent-linked memories', () => {
  it('keyword query scoped to the linked memory finds its nodes', async () => {
    const srv = createTestableMcpServer(memberAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      memoryUrn: fx.linkedMemory.urn,
    });
    expect(text).not.toContain('Memory not found');
    expect(text).toContain('alpha-linked');
  });

  it('survey mode ("*") scoped to the linked memory lists its nodes', async () => {
    const srv = createTestableMcpServer(memberAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: '*',
      memoryUrn: fx.linkedMemory.urn,
    });
    expect(text).toContain('alpha-linked');
  });

  it('a broad (unscoped) keyword search surfaces linked nodes and never foreign ones', async () => {
    const srv = createTestableMcpServer(memberAuth());
    const text = await srv.callToolText('hadron_find_nodes', { query: 'alpha' });
    expect(text).toContain('alpha-linked');
    expect(text).not.toContain('alpha-foreign');
  });

  it('allMemories surfaces linked nodes and never foreign ones', async () => {
    const srv = createTestableMcpServer(memberAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      allMemories: true,
    });
    expect(text).toContain('alpha-linked');
    expect(text).not.toContain('alpha-foreign');
  });

  it('a bare App key (no user) is refused the item-linked ORGANIZATION memory (#1376)', async () => {
    const srv = createTestableMcpServer(appKeyAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      memoryUrn: fx.linkedMemory.urn,
    });
    expect(text).toContain('Memory not found or invalid');
    expect(text).not.toContain('alpha-linked');
  });

  it('memoryUrn scoped to a foreign memory returns "Memory not found" (no oracle)', async () => {
    const srv = createTestableMcpServer(appKeyAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      memoryUrn: fx.foreignMemory.urn,
    });
    expect(text).toContain('Memory not found or invalid');
    expect(text).not.toContain('alpha-foreign');
  });
});
