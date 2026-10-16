/**
 * #1331 / #1202 Slice 1 (cor:acl:130:07, D-2026-09-24-005, Holger #13078 "A"):
 * `NodeRoleRule.writers` ALL / ADMIN enforced in the authorization layer, on
 * BOTH the old and the new role of a write. Memory write access stays
 * necessary; ADMIN means the owning organization's ADMINs plus OWNERs and the
 * owning user. OWNER is not interpreted (never read as ALL).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let memoryId: string;
let memoryUrn: string;
let admin: { id: string };
let contrib: { id: string };
let reader: { id: string };
let platform: { id: string };

const as = (u: { id: string }, roles: Context['roles'] = []): Context => ({ db, userId: u.id, roles, clientId: `user:${u.id}` });
const REFUSED = 'ROLE_WRITER_LEVEL_REQUIRED';

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
}

async function rule(role: string, extra: Record<string, unknown> = {}) {
  const config = (await db.memoryConfig.findUnique({ where: { memoryId } }))
    ?? await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
  return db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role, ...extra } });
}
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: loc, content: 'body', ...extra },
});
const create = (u: { id: string }, input: Record<string, unknown>, roles: Context['roles'] = []) =>
  resolvers.Mutation.createNode(null, { input: { memoryId, name: String(input.loc), content: 'x', ...input } }, as(u, roles));
const update = (u: { id: string }, loc: string, input: Record<string, unknown>, roles: Context['roles'] = []) =>
  resolvers.Mutation.updateNode(null, { input: { memoryId, loc, ...input } }, as(u, roles));
const state = async (loc: string) => db.node.findFirst({ where: { memoryId, loc } });
const revisions = (id: string) => db.nodeRevision.count({ where: { nodeId: id } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'rw-org', urn: 'rw-org' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 133100, githubUsername: 'rw-admin', handle: 'rw-admin' } });
  contrib = await db.user.create({ data: { githubId: 133101, githubUsername: 'rw-contrib', handle: 'rw-contrib' } });
  reader = await db.user.create({ data: { githubId: 133102, githubUsername: 'rw-reader', handle: 'rw-reader' } });
  platform = await db.user.create({ data: { githubId: 133103, githubUsername: 'rw-platform', handle: 'rw-platform', roles: ['ADMIN'] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memoryUrn = `${org.urn}:mem`;
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: memoryUrn, name: 'mem', class: 'knowledge' },
  })).id;
});

describe('writers=ADMIN on a role (acceptance 1, 2)', () => {
  beforeEach(async () => { await rule('policy', { writers: 'ADMIN' }); });

  it('a contributor cannot create a node carrying the role; the org admin and a platform admin can', async () => {
    expect(await code(create(contrib, { loc: 'p1', role: 'policy' }))).toBe(REFUSED);
    expect(await state('p1')).toBeNull();
    expect(await code(create(admin, { loc: 'p2', role: 'policy' }))).toBe('OK');
    expect(await code(create(platform, { loc: 'p3', role: 'policy' }, ['ADMIN']))).toBe('OK');
  });

  it('a contributor cannot edit a node of the role, even without touching the role, and leaves no revision', async () => {
    const n = await node('p1', { role: 'policy' });
    const before = await revisions(n.id);
    expect(await code(update(contrib, 'p1', { content: 'changed' }))).toBe(REFUSED);
    expect(await code(update(contrib, 'p1', { tags: ['t'] }))).toBe(REFUSED);
    expect((await state('p1'))!.content).toBe('body');
    expect(await revisions(n.id)).toBe(before);
    expect(await code(update(admin, 'p1', { content: 'by admin' }))).toBe('OK');
  });

  it('clearing, ADMIN->ALL-role, and ADMIN->ordinary transitions all need the old role\'s level (the declassify-then-edit path is closed at step one)', async () => {
    await rule('notes', { writers: 'ALL' });
    await node('p1', { role: 'policy' });
    await node('p2', { role: 'policy' });
    await node('p3', { role: 'policy' });
    expect(await code(update(contrib, 'p1', { role: null }))).toBe(REFUSED);
    expect(await code(update(contrib, 'p2', { role: 'notes' }))).toBe(REFUSED);
    expect(await code(update(contrib, 'p3', { role: 'anything-else' }))).toBe(REFUSED);
    for (const loc of ['p1', 'p2', 'p3']) expect((await state(loc))!.role).toBe('policy');
    expect(await code(update(admin, 'p1', { role: null }))).toBe('OK');
    expect(await code(update(admin, 'p2', { role: 'notes' }))).toBe('OK');
  });

  it('a transition INTO the role needs its level', async () => {
    await node('o1', { role: 'notes' });
    await node('o2');
    expect(await code(update(contrib, 'o1', { role: 'policy' }))).toBe(REFUSED);
    expect(await code(update(contrib, 'o2', { role: 'policy' }))).toBe(REFUSED);
    expect((await state('o1'))!.role).toBe('notes');
    expect(await code(update(admin, 'o2', { role: 'policy' }))).toBe('OK');
  });

  it('a dotted sub-role inherits the rule; a disabled rule and an unrelated role govern nothing', async () => {
    await rule('memo', { writers: 'ADMIN', enabled: false });
    expect(await code(create(contrib, { loc: 's1', role: 'policy.security' }))).toBe(REFUSED);
    expect(await code(create(contrib, { loc: 's2', role: 'memo' }))).toBe('OK');
    expect(await code(create(contrib, { loc: 's3', role: 'policyholder' }))).toBe('OK');
    expect(await code(create(contrib, { loc: 's4' }))).toBe('OK');
  });

  it('changing the runnable signal of a node carrying the role is an edit of it', async () => {
    await node('p1', { role: 'policy' });
    expect(await code(update(contrib, 'p1', { isRunnable: true }))).toBe(REFUSED);
    expect(await code(update(contrib, 'p1', { isRunnable: false }))).toBe(REFUSED);
  });

  it('memory write access is still required: a reader is refused as before, ALL never admits them', async () => {
    await rule('open', { writers: 'ALL' });
    expect(await code(create(reader, { loc: 'r1', role: 'open' }))).not.toBe('OK');
    expect(await state('r1')).toBeNull();
  });

  it('a revoked admin (membership soft-deleted) is no longer in the audience', async () => {
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgId, userId: admin.id } },
      data: { deletedAt: new Date() },
    });
    expect(await code(create(admin, { loc: 'x1', role: 'policy' }))).not.toBe('OK');
  });

  it('the review door obeys a writer level on role "review" (the cor:acl:130:07 scenario)', async () => {
    await rule('review', { writers: 'ADMIN' });
    expect(await code(resolvers.Mutation.createReviewNode(null, {
      input: { memoryId, loc: 'rv1', name: 'check', content: 'x', role: 'review' },
    }, as(contrib)))).toBe(REFUSED);
    expect(await code(resolvers.Mutation.createReviewNode(null, {
      input: { memoryId, loc: 'rv2', name: 'check', content: 'x', role: 'review' },
    }, as(admin)))).toBe('OK');
    // the existing review's role cannot be cleared by the member through the door either
    expect(await code(resolvers.Mutation.updateReviewNode(null, {
      input: { memoryId, loc: 'rv2', role: null },
    }, as(contrib)))).toBe(REFUSED);
  });
});

describe('every writer path honors the level (the inventory)', () => {
  beforeEach(async () => { await rule('policy', { writers: 'ADMIN' }); });

  it('updateNodeData (merge) on a node of the role', async () => {
    await node('p1', { role: 'policy' });
    expect(await code(resolvers.Mutation.updateNodeData(null, { nodeRef: (await state('p1'))!.id, data: { a: 1 } }, as(contrib)))).toBe(REFUSED);
    expect(await code(resolvers.Mutation.updateNodeData(null, { nodeRef: (await state('p1'))!.id, data: { a: 1 } }, as(admin)))).toBe('OK');
  });

  it('searchReplaceInNodes writes no row of the role for a contributor, and does for an admin', async () => {
    await node('p1', { role: 'policy', content: 'alpha' });
    await node('o1', { content: 'alpha' });
    await resolvers.Mutation.searchReplaceInNodes(null, {
      input: { memoryIds: [memoryId], fields: ['content'], oldText: 'alpha', newText: 'beta', dryRun: false },
    }, as(contrib)).catch(() => null);
    expect((await state('p1'))!.content).toBe('alpha');
    expect((await state('o1'))!.content).toBe('beta');
    await resolvers.Mutation.searchReplaceInNodes(null, {
      input: { memoryIds: [memoryId], fields: ['content'], oldText: 'alpha', newText: 'beta', dryRun: false },
    }, as(admin));
    expect((await state('p1'))!.content).toBe('beta');
  });

  it('moveNode, cloneNode (copy carries the role) and mergeNodes', async () => {
    const p = await node('p1', { role: 'policy' });
    await node('p2', { role: 'policy' });
    expect(await code(resolvers.Mutation.moveNode(null, { sourceRef: p.id, targetUrn: `hrn:node:${memoryUrn}:moved` }, as(contrib)))).toBe(REFUSED);
    expect((await state('p1'))!.loc).toBe('p1');
    expect(await code(resolvers.Mutation.cloneNode(null, { sourceRef: p.id, targetUrn: `hrn:node:${memoryUrn}:copy` }, as(contrib)))).toBe(REFUSED);
    expect(await state('copy')).toBeNull();
    expect(await code(resolvers.Mutation.cloneNode(null, { sourceRef: p.id, targetUrn: `hrn:node:${memoryUrn}:copy` }, as(admin)))).toBe('OK');
  });

  it('restoreNodeRevision of a node of the role', async () => {
    const n = await node('p1', { role: 'policy' });
    await update(admin, 'p1', { content: 'v2' });
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id } });
    expect(await code(resolvers.Mutation.restoreNodeRevision(null, { revisionId: rev.id }, as(contrib)))).not.toBe('OK');
    expect((await state('p1'))!.content).toBe('v2');
  });

  it('MCP hadron_update_node and hadron_create_node (inline writers)', async () => {
    await node('p1', { role: 'policy' });
    const mcp = (u: { id: string }) => createTestableMcpServer({ userId: u.id, roles: [], clientId: `user:${u.id}` });
    const refused = await mcp(contrib).callToolText('hadron_update_node', { urn: `hrn:node:${memoryUrn}:p1`, content: 'mcp edit' });
    expect(refused).toContain(REFUSED);
    expect((await state('p1'))!.content).toBe('body');
    const created = await mcp(contrib).callToolText('hadron_create_node', { urn: `hrn:node:${memoryUrn}:p9`, name: 'p9', content: 'x', role: 'policy' });
    expect(created).toContain(REFUSED);
    expect(await state('p9')).toBeNull();
    const ok = await mcp(admin).callToolText('hadron_update_node', { urn: `hrn:node:${memoryUrn}:p1`, content: 'admin mcp edit' });
    expect(ok).not.toContain(REFUSED);
    expect((await state('p1'))!.content).toBe('admin mcp edit');
  });
});

describe('ALL, OWNER, and the user-owned audience', () => {
  it('ALL preserves the memory-write audience: a contributor writes', async () => {
    await rule('open', { writers: 'ALL' });
    expect(await code(create(contrib, { loc: 'a1', role: 'open' }))).toBe('OK');
  });

  it('OWNER is not read as ALL: it fails closed with a typed refusal, for everyone', async () => {
    await rule('vault', { writers: 'OWNER' });
    expect(await code(create(contrib, { loc: 'v1', role: 'vault' }))).toBe('ROLE_WRITERS_UNSUPPORTED');
    expect(await code(create(admin, { loc: 'v2', role: 'vault' }))).toBe('ROLE_WRITERS_UNSUPPORTED');
    expect(await state('v1')).toBeNull();
  });

  it('a user-owned memory: the owning user is the ADMIN audience', async () => {
    const owned = await db.memory.create({
      data: { id: generateId(), ownerUserId: contrib.id, urn: 'rw-contrib:mem', name: 'own', class: 'knowledge' },
    });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: owned.id } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'policy', writers: 'ADMIN' } });
    expect(await code(resolvers.Mutation.createNode(null, {
      input: { memoryId: owned.id, loc: 'u1', name: 'u1', content: 'x', role: 'policy' },
    }, as(contrib)))).toBe('OK');
  });
});

describe('races against the rulebook and the audience (acceptance 3)', () => {
  it('a write that waits behind a rule change ALL->ADMIN is judged on the committed rule', async () => {
    const r = await rule('policy', { writers: 'ALL' });
    await node('p1', { role: 'policy' });
    // The rule tightens before the write runs: the write must see ADMIN, never a stale ALL.
    await db.nodeRoleRule.update({ where: { id: r.id }, data: { writers: 'ADMIN' } });
    expect(await code(update(contrib, 'p1', { content: 'late' }))).toBe(REFUSED);
    expect((await state('p1'))!.content).toBe('body');
  });
});
