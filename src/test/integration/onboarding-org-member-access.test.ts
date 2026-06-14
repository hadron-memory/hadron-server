/**
 * Onboarding e2e (PR #270): a user who has been added to the platform AND to
 * an organization — but has NOT installed any Agent / has no AppMember row —
 * can discover and read that org's knowledge memory over MCP, matching what
 * the portal shows.
 *
 * This is the exact "Micromentor onboarding incident" (2026-06-13): before the
 * fix, h-list-memories returned nothing and h-find-nodes/h-read-node answered
 * "Memory not found" for a freshly-onboarded org member until they installed
 * an Agent. The test drives the real MCP tool closures (auth → getMemoryAccess
 * → canReadMemory → render) via createTestableMcpServer — no HTTP transport.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import type { AuthContext } from '../../middleware/auth.js';
import { generateId } from '../../lib/id.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Fx {
  member: { id: string };
  outsider: { id: string };
  memory: { id: string; urn: string };
  nodeLoc: string;
}
let fx: Fx;

// Org member, NO AppMember, NO platform roles, NO active App — the
// freshly-onboarded shape. appId/sessionId intentionally absent.
function memberAuth(): AuthContext {
  return { userId: fx.member.id, roles: [], clientId: `user:${fx.member.id}` };
}
// A user on the platform but NOT in the org — the negative control.
function outsiderAuth(): AuthContext {
  return { userId: fx.outsider.id, roles: [], clientId: `user:${fx.outsider.id}` };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'micromentor.org', urn: 'micromentor.org' },
  });
  const member = await db.user.create({ data: { id: generateId(), handle: 'new-hire' } });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' },
  });
  const outsider = await db.user.create({ data: { id: generateId(), handle: 'outsider' } });

  // Org-owned knowledge memory with one readable node. Created by an ADMIN ctx
  // so the mutation's own authz passes; access under test is the MEMBER's.
  const adminCtx: Context = { db, roles: ['ADMIN'], userId: member.id };
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'mmdata' },
    adminCtx,
  );
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc: 'preflight',
      name: 'Preflight',
      nodeType: 'info',
      content: 'Onboarding preflight checklist.',
      tags: [],
    },
  });

  fx = { member, outsider, memory, nodeLoc: 'preflight' };
});

describe('onboarding: org member (no App) has read access to the org memory over MCP', () => {
  it('h-list-memories surfaces the org memory for a bare org member', async () => {
    const srv = createTestableMcpServer(memberAuth());
    const text = await srv.callToolText('h-list-memories', {});
    // The URN renders in canonical form (hrn:memory:micromentor.org::mmdata);
    // assert on the org + slug rather than the stored bare separator.
    expect(text).toContain('micromentor.org');
    expect(text).toContain('mmdata');
    expect(text).not.toMatch(/^0 accessible memories/);
  });

  it('h-find-nodes returns the memory contents (not "Memory not found")', async () => {
    const srv = createTestableMcpServer(memberAuth());
    const text = await srv.callToolText('h-find-nodes', { query: '*', memoryUrn: fx.memory.urn });
    expect(text).not.toContain('Memory not found');
    expect(text).toContain(fx.nodeLoc);
  });

  it('h-read-node reads a node in the org memory', async () => {
    const srv = createTestableMcpServer(memberAuth());
    const text = await srv.callToolText('h-read-node', {
      urn: `hrn:node:${fx.memory.urn}:${fx.nodeLoc}`,
    });
    expect(text).toContain('Onboarding preflight checklist.');
  });

  it('negative control: a non-member is still denied (no over-grant)', async () => {
    const srv = createTestableMcpServer(outsiderAuth());
    const text = await srv.callToolText('h-find-nodes', { query: '*', memoryUrn: fx.memory.urn });
    expect(text).toContain('Memory not found');
    expect(text).not.toContain(fx.nodeLoc);
  });
});
