/** #1734: platform roles reach user-owned Apps/non-strict memories, never strict holdings or secrets. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { computeEffectiveAccess } from '../../../lib/auth/effectiveAccess.js';
import { canReadMemory, canWriteToMemory } from '../../../mcp/access-control.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds, isAppParticipant, requireMemoryManageAccess, requireMemoryWriteAccess } from './resolvers.helpers.js';
import { callerManagesAppMembers } from './resolvers.mutation.app.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let owner: string;
let admin: string;
let app: Awaited<ReturnType<typeof db.app.create>>;
const as = (userId: string, roles: Context['roles'] = []): Context => ({ db, userId, roles });
const M = resolvers.Mutation;

beforeEach(async () => {
  await cleanDb(db);
  owner = (await db.user.create({ data: { id: generateId(), handle: 'owner1734', roles: [] } })).id;
  admin = (await db.user.create({ data: { id: generateId(), handle: 'admin1734', roles: ['ADMIN'] } })).id;
  app = await db.app.create({ data: { id: generateId(), name: 'Owner App', urn: 'owner1734:app', ownerUserId: owner } });
});

async function memory(cls: 'knowledge' | 'personal' | 'private') {
  return db.memory.create({ data: {
    id: generateId(), name: cls, urn: `owner1734:${cls}`, class: cls, ownerUserId: owner,
    ...(cls === 'knowledge' ? {} : { userId: owner }),
  } });
}

describe('#1734 shared App management and read surfaces', () => {
  it.each(['ADMIN', 'OWNER'] as const)('platform %s manages a foreign user-owned App on both shared predicates', async role => {
    const ctx = as(admin, [role]);
    expect(await managesApp(ctx, app)).toBe(true);
    expect(await callerManagesAppMembers(ctx, app, app.id)).toBe(true);
    expect(await isAppParticipant(ctx, app)).toBe(true);
    await expect(resolvers.Query.app(null, { ref: app.id }, ctx)).resolves.toMatchObject({ id: app.id });
    await expect(resolvers.Query.appKeys(null, { appRef: app.id }, ctx)).resolves.toEqual([]);
  });
  it('ordinary users gain no access, and the owner remains entitled', async () => {
    expect(await managesApp(as(admin), app)).toBe(false);
    expect(await managesApp(as(owner), app)).toBe(true);
    await expect(resolvers.Query.appKeys(null, { appRef: app.id }, as(admin))).rejects.toThrow('Forbidden');
  });
  it('effectiveAccess reports platform App management consistently with the gates', async () => {
    const access = await computeEffectiveAccess(db, { id: admin, roles: ['ADMIN'] }, { kind: 'app', app });
    expect(access).toMatchObject({ canRead: true, canWrite: true, canManage: true, canDelete: true });
  });
  it('impersonation gains neither App-management nor App-read authority', async () => {
    const ctx = { ...as(admin, ['ADMIN']), impersonation: { orgId: generateId() } } as Context;
    expect(await managesApp(ctx, app)).toBe(false);
    expect(await callerManagesAppMembers(ctx, app, app.id)).toBe(false);
    expect(await isAppParticipant(ctx, app)).toBe(false);
    await expect(resolvers.Query.appKeys(null, { appRef: app.id }, ctx)).rejects.toThrow('Forbidden');
  });
});

describe('#1734 non-strict memory management, reads and writes', () => {
  it('effectiveAccess reports full platform access to a user-owned non-strict memory', async () => {
    const mem = await memory('knowledge');
    const access = await computeEffectiveAccess(db, { id: admin, roles: ['ADMIN'] }, {
      kind: 'memory', memory: { ...mem, workerOf: [] },
    });
    expect(access).toMatchObject({ canRead: true, canWrite: true, canManage: true, canDelete: true });
  });
  it.each(['ADMIN', 'OWNER'] as const)('platform %s has the same memory reach on discovery, MCP and GraphQL', async role => {
    const mem = await memory('knowledge');
    const ctx = as(admin, [role]);
    await expect(requireMemoryManageAccess(ctx, mem)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctx, mem.id)).resolves.toBeUndefined();
    expect(await canReadMemory(db, ctx, mem.id)).toBe(true);
    expect(await canWriteToMemory(db, ctx, mem.id)).toBe(true);
    expect(await getAccessibleMemoryIds(ctx, mem.id)).toContain(mem.id);
    await expect(requireMemoryWriteAccess({ ...ctx, appId: app.id }, mem.id)).resolves.toBeUndefined();
  });
  it('a platform admin can comment and manage another author’s comment in a user-owned knowledge memory', async () => {
    const mem = await memory('knowledge');
    const node = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'topic', name: 'Topic', content: 'body' } });
    const existing = await M.createComment(null, { targetRef: node.id, body: 'owner comment' }, as(owner));
    const ctx = as(admin, ['ADMIN']);
    const added = await M.createComment(null, { targetRef: node.id, body: 'admin comment' }, ctx);
    expect(added.body).toBe('admin comment');
    await expect(M.deleteComment(null, { commentRef: existing.id, expectedRevision: 1 }, ctx)).resolves.toBeTruthy();
  });
  it('ordinary users and impersonation gain no non-strict memory authority', async () => {
    const mem = await memory('knowledge');
    for (const ctx of [as(admin), { ...as(admin, ['ADMIN']), impersonation: { orgId: generateId() } } as Context]) {
      await expect(requireMemoryManageAccess(ctx, mem)).rejects.toThrow('Forbidden');
      await expect(requireMemoryWriteAccess(ctx, mem.id)).rejects.toThrow();
      expect(await canReadMemory(db, ctx, mem.id)).toBe(false);
      expect(await canWriteToMemory(db, ctx, mem.id)).toBe(false);
    }
  });
});

describe('#1734 categorical exceptions', () => {
  it.each(['personal', 'private'] as const)('platform roles never bypass %s owner gates', async cls => {
    const mem = await memory(cls);
    for (const role of ['ADMIN', 'OWNER'] as const) {
      const ctx = as(admin, [role]);
      await expect(requireMemoryManageAccess(ctx, mem)).rejects.toThrow('Forbidden');
      await expect(requireMemoryWriteAccess(ctx, mem.id)).rejects.toThrow();
      expect(await canReadMemory(db, ctx, mem.id)).toBe(false);
      expect(await canWriteToMemory(db, ctx, mem.id)).toBe(false);
      expect(await getAccessibleMemoryIds(ctx, mem.id)).not.toContain(mem.id);
    }
    expect(await canReadMemory(db, as(owner), mem.id)).toBe(true);
    expect(await canWriteToMemory(db, as(owner), mem.id)).toBe(true);
  });
  it('admin read, comment and comment deletion on another owner’s personal memory remain refused', async () => {
    const mem = await memory('personal');
    const node = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'topic', name: 'Topic', content: 'body' } });
    const existing = await M.createComment(null, { targetRef: node.id, body: 'owner comment' }, as(owner));
    const before = await db.node.findUniqueOrThrow({ where: { id: existing.id } });
    const ctx = as(admin, ['ADMIN']);
    await expect(M.createComment(null, { targetRef: node.id, body: 'denied' }, ctx)).rejects.toThrow();
    await expect(M.deleteComment(null, { commentRef: existing.id, expectedRevision: 1 }, ctx)).rejects.toThrow();
    expect(await db.node.findUniqueOrThrow({ where: { id: existing.id } })).toEqual(before);
  });
  it('a private memory refuses comments even for its owner, and conceals the target from admins', async () => {
    const mem = await memory('private');
    const node = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'topic', name: 'Topic', content: 'body' } });
    await expect(M.createComment(null, { targetRef: node.id, body: 'denied' }, as(owner))).rejects.toThrow('private memory');
    await expect(M.createComment(null, { targetRef: node.id, body: 'denied' }, as(admin, ['ADMIN']))).rejects.toThrow('Node not found');
  });
  it('user-owned secrets remain unreadable to a platform admin', async () => {
    const secret = await M.createSecret(null, { ownerType: 'user', ownerRef: owner, name: 'token', kind: 'generic', value: 'synthetic-secret' }, as(owner));
    expect(await resolvers.Query.secret(null, { ref: secret.id }, as(admin, ['ADMIN']))).toBeNull();
  });
});
