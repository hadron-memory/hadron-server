/**
 * #331 Part A — nodeType on the MCP read surface: an exact-match
 * `hadron_find_nodes` facet (pass-through to NodeFilter.nodeType) and the type
 * suffix on every real `hadron_list_nodes` tree row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let adminId: string;
let memUrn: string;
let memId: string;
let otherMemUrn: string;
let outsiderId: string;
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const call = (tool: string, args: Record<string, unknown>, auth: AuthContext = adminAuth()) =>
  createTestableMcpServer(auth).callToolText(tool, args);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'nt-org', urn: 'nt-org' } });
  const admin = await db.user.create({ data: { githubId: 9831, githubUsername: 'nt-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  adminId = admin.id;
  const ctx = { db, roles: ['ADMIN'], userId: admin.id } as Context;
  const mem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'typed' }, ctx);
  memUrn = mem.urn;
  memId = mem.id;
  const mk = (memoryId: string, loc: string, nodeType: string, extra: Record<string, unknown> = {}) =>
    db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType, ...extra } as any });
  await mk(memId, 'top', 'parent');
  await mk(memId, 'top:a', 'info', { objectType: 'competitor' });
  await mk(memId, 'top:t1', 'task', { isRunnable: true, objectType: 'competitor' });
  await mk(memId, 'top:t2', 'task');
  await mk(memId, 'top:sys', 'system');

  // A memory the outsider cannot read, holding a node of the probed type.
  const outsider = await db.user.create({ data: { githubId: 9832, githubUsername: 'nt-outsider' } });
  outsiderId = outsider.id;
  const other = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'hidden' }, ctx);
  otherMemUrn = other.urn;
  await mk(other.id, 'secret-task', 'task');
});

describe('hadron_find_nodes — nodeType facet (#331)', () => {
  it('survey mode returns only nodes of that type', async () => {
    const text = await call('hadron_find_nodes', { query: '*', memoryUrn: memUrn, nodeType: 'task' });
    expect(text).toContain('top:t1');
    expect(text).toContain('top:t2');
    expect(text).not.toContain('top:a');
    expect(text).not.toContain('top:sys');
  });

  it('composes with parentRel, isRunnable and objectType', async () => {
    const underTop = await call('hadron_find_nodes', { query: '*', memoryUrn: memUrn, parentRel: 'top', nodeType: 'task' });
    expect(underTop).toContain('top:t1');
    expect(underTop).not.toContain('top:a');
    const runnable = await call('hadron_find_nodes', { query: '*', memoryUrn: memUrn, nodeType: 'task', isRunnable: true });
    expect(runnable).toContain('top:t1');
    expect(runnable).not.toContain('top:t2');
    const coll = await call('hadron_find_nodes', { query: '*', memoryUrn: memUrn, nodeType: 'task', objectType: 'competitor' });
    expect(coll).toContain('top:t1');
    expect(coll).not.toContain('top:t2');
    expect(coll).not.toContain('top:a');
  });

  it('works in keyword mode too', async () => {
    const text = await call('hadron_find_nodes', { query: 't1', memoryUrn: memUrn, nodeType: 'task' });
    expect(text).toContain('top:t1');
    expect(text).not.toContain('top:a');
  });

  it('an unknown type returns zero nodes', async () => {
    const text = await call('hadron_find_nodes', { query: '*', memoryUrn: memUrn, nodeType: 'nonesuch' });
    expect(text).not.toContain('top:');
  });

  it('without nodeType the default system exclusion still holds', async () => {
    const text = await call('hadron_find_nodes', { query: '*', memoryUrn: memUrn });
    expect(text).toContain('top:a');
    expect(text).not.toContain('top:sys');
  });

  it('nodeType "comment" without nodeKind does not surface content nodes', async () => {
    const text = await call('hadron_find_nodes', { query: '*', memoryUrn: memUrn, nodeType: 'comment' });
    expect(text).not.toContain('top:t1');
    expect(text).not.toContain('top:a');
  });

  it('never leaks a node of that type from an unreadable memory', async () => {
    const outsiderAuth: AuthContext = { userId: outsiderId, roles: [], clientId: `user:${outsiderId}` };
    const scoped = await call('hadron_find_nodes', { query: '*', memoryUrn: otherMemUrn, nodeType: 'task' }, outsiderAuth);
    expect(scoped).not.toContain('secret-task');
    const broad = await call('hadron_find_nodes', { query: '*', allMemories: true, nodeType: 'task' }, outsiderAuth);
    expect(broad).not.toContain('secret-task');
  });
});

describe('hadron_list_nodes — type on every real row (#331)', () => {
  it('suffixes each real row with [nodeType] and keeps the child-count suffix', async () => {
    const text = await call('hadron_list_nodes', { memoryUrn: memUrn, depth: 2 });
    expect(text).toMatch(/:top — top \[parent\] \(\d+ children\)/);
    expect(text).toMatch(/:top:t1 — top:t1 \[task\]/);
    expect(text).toMatch(/:top:a — top:a \[info\]/);
  });

  it('leaves a synthesized missing-parent row without a type', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: memId, loc: 'gap:leaf', name: 'leaf', nodeType: 'info' } as any });
    const text = await call('hadron_list_nodes', { memoryUrn: memUrn, depth: 2 });
    expect(text).toMatch(/:gap — \(missing — use hadron_create_parent_node to materialize\)/);
    expect(text).not.toMatch(/\(missing[^\n]*\[\w+\]/);
  });
});
