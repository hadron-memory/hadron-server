/**
 * Spec 049 Phase 2 — the scope tools on the MCP surface.
 *
 * The rules are pinned in resolvers.scope.test.ts; this covers the SURFACE:
 * the tools go through the same resolvers (create → list → explain round-trip
 * under the active App), a refusal comes back as a `[code] message` text
 * envelope rather than a thrown error, and the hidden-memory count is a count.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
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
let mem1: { id: string; urn: string };
let mem2: { id: string; urn: string };
let personal: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'scm', urn: `scm-${t}.com` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 48201, githubUsername: `scm-admin-${t}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 48202, githubUsername: `scm-member-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'ag', urn: `${org.urn}:ag`, visibility: 'ORGANIZATION' } });
  const mem = (slug: string) =>
    db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, class: 'knowledge', visibility: 'ORGANIZATION' } });
  mem1 = await mem('one');
  mem2 = await mem('two');
  personal = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:admin-personal`, name: 'p', class: 'personal', userId: admin.id, appId: app.id, userMemoryOfAgentId: agent.id },
  });
});

function server(userId: string) {
  const auth = { userId, roles: ['READER'], clientId: `user:${userId}`, appId: app.id, organizationId: org.id } as AuthContext;
  return createTestableMcpServer(auth, { sessionId: `scm-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
}

describe('scope tools', () => {
  it('create under the active App → list → explain, with the hidden count for another member', async () => {
    const asAdmin = server(admin.id);
    const created = await asAdmin.callToolText('hadron_create_scope', {
      name: 'research',
      memoryUrns: [`hrn:mem:${personal.urn}`, `hrn:mem:${mem1.urn}`, mem2.id],
      description: 'what I read first',
    });
    expect(created).toContain('Created.');
    expect(created).toContain('**research** — app-owned by');
    expect(created).toContain(`1. hrn:mem:${personal.urn}`);
    expect(created).toContain(`3. hrn:mem:${mem2.urn}`);

    const listed = await asAdmin.callToolText('hadron_list_scopes', {});
    expect(listed).toContain("1 scope(s) in this App's context");
    expect(listed).toContain('what I read first');

    // The reader-role member cannot read the admin's personal memory: it is
    // dropped and COUNTED, never named.
    const asMember = server(member.id);
    const explained = await asMember.callToolText('hadron_scope_explain', { name: 'research' });
    expect(explained).toContain('resolved via app owner');
    expect(explained).toContain(`1. hrn:mem:${mem1.urn}`);
    expect(explained).toContain('(1 memory dropped — not readable by you)');
    expect(explained).not.toContain(personal.urn);
  });

  it('a refusal is a [code] text envelope, not a thrown error', async () => {
    const asMember = server(member.id);
    const out = await asMember.callTool('hadron_create_scope', { name: 'nope', memoryUrns: [mem1.id] });
    expect(out.content[0]?.text).toBe('[forbidden] Forbidden.');
    const reserved = await server(admin.id).callTool('hadron_create_scope', { name: 'global', memoryUrns: [mem1.id] });
    expect(reserved.content[0]?.text.startsWith('[bad_user_input]')).toBe(true);
    const none = await asMember.callToolText('hadron_scope_explain', { name: 'missing' });
    expect(none).toContain('No readable scope matches "missing"');
  });

  it('update replaces the order and delete frees the name', async () => {
    const asAdmin = server(admin.id);
    await asAdmin.callToolText('hadron_create_scope', { name: 'r', memoryUrns: [mem1.id, mem2.id] });
    const id = (await db.scope.findFirstOrThrow({ where: { name: 'r' } })).id;
    const updated = await asAdmin.callToolText('hadron_update_scope', { scope: id, memoryUrns: [mem2.id, mem1.id] });
    expect(updated).toContain(`1. hrn:mem:${mem2.urn}`);
    expect(await asAdmin.callToolText('hadron_delete_scope', { scope: id })).toContain('deleted');
    expect(await asAdmin.callToolText('hadron_create_scope', { name: 'r', memoryUrns: [mem1.id] })).toContain('Created.');
  });
});
