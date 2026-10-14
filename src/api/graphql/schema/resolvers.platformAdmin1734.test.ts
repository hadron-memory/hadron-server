/** #1734: platform roles reach user-owned Apps/non-strict memories, never strict holdings or secrets. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { participantAppIds } from '../../../lib/auth/appParticipation.js';
import { computeEffectiveAccess } from '../../../lib/auth/effectiveAccess.js';
import { globalSearch } from '../../../lib/global-search/index.js';
import { canReadMemory, canWriteToMemory } from '../../../mcp/access-control.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds, isAppParticipant, requireMemoryManageAccess, requireMemoryWriteAccess, requireOwnerOrOrgRole, isOwnerOrOrgMember } from './resolvers.helpers.js';
import { callerManagesAppMembers } from './resolvers.mutation.app.js';
import { composeWorkerPrompt } from './resolvers.worker.js';

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

async function memory(cls: 'knowledge' | 'group' | 'app' | 'system' | 'personal' | 'private') {
  return db.memory.create({ data: {
    id: generateId(), name: cls, urn: `owner1734:${cls}`, class: cls, ownerUserId: owner,
    ...(['personal', 'private'].includes(cls) ? { userId: owner } : {}),
    ...(cls === 'app' ? { appId: app.id } : {}),
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
  it('platform admins discover foreign user-owned Apps on the unscoped list', async () => {
    const page = await resolvers.Query.apps(null, {}, as(admin, ['ADMIN']));
    expect(page.items.map(row => row.id)).toContain(app.id);
  });
  it('the participation set matches the point gate for platform admins and impersonation', async () => {
    const ctx = as(admin, ['ADMIN']);
    expect(await isAppParticipant(ctx, app)).toBe(true);
    expect(await participantAppIds(db, ctx, { includeMemberships: true })).toContain(app.id);
    const impersonated = { ...ctx, impersonation: { orgId: generateId() } } as Context;
    expect(await isAppParticipant(impersonated, app)).toBe(false);
    expect(await participantAppIds(db, impersonated, { includeMemberships: true })).not.toContain(app.id);
  });
  it('platform admin App-key management survives the transaction role recheck', async () => {
    const ctx = as(admin, ['ADMIN']);
    const created = await M.createAppKey(null, { appRef: app.id, label: 'admin-managed' }, ctx);
    expect(created.key.appId).toBe(app.id);
    const keys = await resolvers.Query.appKeys(null, { appRef: app.id }, ctx);
    expect(keys.map(key => key.id)).toContain(created.key.id);
    await M.revokeAppKey(null, { id: created.key.id }, ctx);
    expect((await db.appKey.findUniqueOrThrow({ where: { id: created.key.id } })).revokedAt).not.toBeNull();
  });
  it('a platform admin staffs a user-owned App with a readable public Agent', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'Publisher', urn: 'publisher1734.com' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Published', urn: 'publisher1734.com:agent', visibility: 'PUBLIC' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await M.castWorker(null, { appRef: app.id, agentRef: agent.id, name: 'Admin staff' }, as(admin, ['ADMIN']));
    expect(worker.appId).toBe(app.id);
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
  it.each(['group', 'app', 'system'] as const)('platform authority also reaches user-owned %s rows', async cls => {
    const mem = await memory(cls);
    const ctx = as(admin, ['ADMIN']);
    await expect(requireMemoryManageAccess(ctx, mem)).resolves.toBeUndefined();
    await expect(requireMemoryWriteAccess(ctx, mem.id)).resolves.toBeUndefined();
    expect(await canReadMemory(db, ctx, mem.id)).toBe(true);
    expect(await canWriteToMemory(db, ctx, mem.id)).toBe(true);
    expect(await getAccessibleMemoryIds(ctx, mem.id)).toContain(mem.id);
  });
  it('global search discovers non-strict user-owned memories and nodes but conceals private nodes', async () => {
    const mem = await memory('knowledge');
    const hidden = await memory('private');
    const node = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'topic', name: 'needle1734' } });
    const privateNode = await db.node.create({ data: { id: generateId(), memoryId: hidden.id, loc: 'topic', name: 'needle1734' } });
    const result = await globalSearch(db, { query: 'needle1734', entityTypes: ['node'] }, {
      viewerUserId: admin, isPlatformAdmin: true, accessibleMemoryIds: null, orgIds: null, viewerOrgIds: [],
    });
    expect(result.hits.map(hit => hit.id)).toContain(node.id);
    expect(result.hits.map(hit => hit.id)).not.toContain(privateNode.id);
  });
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
    await expect(resolvers.Query.memory(null, { ref: mem.id }, ctx)).resolves.toMatchObject({ id: mem.id });
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
  it.each(['knowledge', 'group', 'app'] as const)('impersonating the owner does not admit a user-owned %s memory', async cls => {
    const mem = await memory(cls);
    const ctx = { ...as(owner), impersonation: { orgId: generateId() } } as Context;
    await expect(requireMemoryManageAccess(ctx, mem)).rejects.toThrow('Forbidden');
    await expect(requireMemoryWriteAccess(ctx, mem.id)).rejects.toThrow();
    expect(await canReadMemory(db, ctx, mem.id)).toBe(false);
    expect(await canWriteToMemory(db, ctx, mem.id)).toBe(false);
  });
  it('a run principal cannot turn inherited platform roles into this user-owned bypass', async () => {
    const mem = await memory('knowledge');
    const ctx = { ...as(admin, ['ADMIN']), clientId: 'run:1734' };
    await expect(requireMemoryManageAccess(ctx, mem)).rejects.toThrow('Forbidden');
    await expect(requireMemoryWriteAccess(ctx, mem.id)).rejects.toThrow();
    expect(await canReadMemory(db, ctx, mem.id)).toBe(false);
    expect(await canWriteToMemory(db, ctx, mem.id)).toBe(false);
  });
});

describe('#1734 categorical exceptions', () => {
  it.each([undefined, 'personal', 'private', 'unknown'])('the tenant helper cannot bypass memory privacy for class %s', async cls => {
    const entity = { organizationId: generateId(), ownerUserId: null, class: cls };
    const ctx = as(admin, ['ADMIN']);
    await expect(requireOwnerOrOrgRole(ctx, entity, 'ADMIN', 'memory')).rejects.toThrow('Forbidden');
    expect(await isOwnerOrOrgMember(ctx, entity, 'memory')).toBe(false);
  });
  it.each(['reader', 'writer'] as const)('a valid personal %s share retains its own capabilities without an admin management bypass', async role => {
    const mem = await memory('personal');
    await db.memoryShare.create({ data: { memoryId: mem.id, granteeId: admin, grantorId: owner, role } });
    const node = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'topic', name: 'Shared topic' } });
    const ctx = as(admin, ['ADMIN']);
    expect(await resolvers.Query.memory(null, { ref: mem.id }, ctx)).toMatchObject({ id: mem.id });
    expect(await getAccessibleMemoryIds(ctx, mem.id)).toContain(mem.id);
    await expect(requireMemoryManageAccess(ctx, mem)).rejects.toThrow('Forbidden');
    if (role === 'writer') {
      await expect(requireMemoryWriteAccess(ctx, mem.id)).resolves.toBeUndefined();
      await expect(M.createComment(null, { targetRef: node.id, body: 'shared writer' }, ctx)).resolves.toMatchObject({ body: 'shared writer' });
      const ownerComment = await M.createComment(null, { targetRef: node.id, body: 'owner comment' }, as(owner));
      await expect(M.deleteComment(null, { commentRef: ownerComment.id, expectedRevision: 1 }, ctx)).rejects.toThrow();
    } else {
      await expect(requireMemoryWriteAccess(ctx, mem.id)).rejects.toThrow();
      await expect(M.createComment(null, { targetRef: node.id, body: 'denied' }, ctx)).rejects.toThrow();
    }
  });
  it('Agent definition records follow #1818 while content and memory writes stay closed', async () => {
    const mem = await db.memory.create({ data: { id: generateId(), name: 'Agent definition', urn: 'owner1734:system', class: 'system', ownerUserId: owner } });
    await db.agent.create({ data: { id: generateId(), name: 'Owned agent', urn: 'owner1734:definition', ownerUserId: owner, systemMemoryId: mem.id } });
    const node = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'prompt', name: 'protected1734' } });
    const ctx = as(admin, ['ADMIN']);
    await expect(requireMemoryManageAccess(ctx, mem)).rejects.toThrow('Forbidden');
    await expect(requireMemoryWriteAccess(ctx, mem.id)).rejects.toThrow();
    await expect(requireMemoryWriteAccess({ ...ctx, appId: app.id }, mem.id)).rejects.toThrow();
    expect(await canReadMemory(db, ctx, mem.id)).toBe(false);
    expect(await canWriteToMemory(db, ctx, mem.id)).toBe(false);
    expect(await getAccessibleMemoryIds(ctx, mem.id)).not.toContain(mem.id);
    expect(await resolvers.Query.memory(null, { ref: mem.id }, ctx)).toMatchObject({ id: mem.id });
    const result = await globalSearch(db, { query: 'protected1734', entityTypes: ['node'] }, {
      viewerUserId: admin, isPlatformAdmin: true, accessibleMemoryIds: null, orgIds: null, viewerOrgIds: [],
    });
    expect(result.hits.map(hit => hit.id)).not.toContain(node.id);
    const access = await computeEffectiveAccess(db, { id: admin, roles: ['ADMIN'] }, { kind: 'memory', memory: { ...mem, workerOf: [] } });
    expect(access).toMatchObject({ canRead: true, canWrite: false, canManage: false });
    expect(await canReadMemory(db, as(owner), mem.id)).toBe(true);
    expect(await canWriteToMemory(db, as(owner), mem.id)).toBe(true);
  });
  // Main #1818 carries the Agent definition-management matrix; #10659 keeps
  // its separate provider-credential gate owner-only.
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

describe('#10659 user-owned App provider keys', () => {
  it.each(['impersonation', 'run'] as const)('both decrypted-key reads refuse the owner identity under %s', async principal => {
    await M.updateApp(null, { ref: app.id, aiProvider: 'openai', aiModel: 'gpt-4o', aiApiKey: 'sk-synthetic-owner-only' }, as(owner));
    const ctx: Context = principal === 'impersonation'
      ? { ...as(owner, ['ADMIN']), impersonation: { orgId: generateId() } } as Context
      : { ...as(owner), appId: app.id, clientId: 'run:synthetic' };
    for (const read of [resolvers.Query.appAIConfig, resolvers.Query.resolveAIConfig]) {
      await expect(read(null, { appRef: app.id }, ctx)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    }
    await expect(resolvers.Query.appAIConfig(null, { appRef: app.id }, as(owner))).resolves.toMatchObject({ apiKey: 'sk-synthetic-owner-only' });
  });
  it('an org-owned App clear removes only the default config', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'Org', urn: 'org1734.com' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: owner, role: 'ADMIN' } });
    const orgApp = await db.app.create({ data: { id: generateId(), name: 'Org App', urn: 'org1734.com:app', organizationId: org.id } });
    for (const name of ['default', 'backup']) await M.createAiServiceConfig(null, {
      ownerType: 'APP', ownerId: orgApp.id, name, provider: 'openai', model: 'gpt-4o', apiKey: 'sk-org-only',
    }, as(owner));
    const backup = await db.aiServiceConfig.findFirstOrThrow({ where: { appId: orgApp.id, name: 'backup' } });
    await expect(M.clearAppAIConfig(null, { appRef: orgApp.id }, as(owner))).resolves.toMatchObject({ id: orgApp.id });
    expect(await db.aiServiceConfig.findMany({ where: { appId: orgApp.id } })).toEqual([backup]);
  });

  it.each(['ADMIN', 'OWNER'] as const)('platform %s clears all named App configs without reaching another App (#10755)', async role => {
    for (const name of ['default', 'backup']) await M.createAiServiceConfig(null, {
      ownerType: 'APP', ownerId: app.id, name, provider: 'openai', model: 'gpt-4o', apiKey: 'sk-owner-only',
    }, as(owner));
    const other = await db.app.create({ data: { id: generateId(), name: 'Other', urn: 'owner1734:other', ownerUserId: owner } });
    const control = await M.createAiServiceConfig(null, {
      ownerType: 'APP', ownerId: other.id, name: 'backup', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-control',
    }, as(owner));
    const ctx = as(admin, [role]);
    await expect(M.clearAppAIConfig(null, { appRef: app.id }, ctx)).resolves.toMatchObject({ id: app.id });
    expect(await db.aiServiceConfig.count({ where: { appId: app.id } })).toBe(0);
    expect(await db.aiServiceConfig.findUnique({ where: { id: control.id } })).toBeTruthy();
    await expect(M.clearAppAIConfig(null, { appRef: app.id }, ctx)).resolves.toMatchObject({ id: app.id });
  });
  it('only ownerUserId manages credentials; owner-role members do not (#10752)', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: admin, role: 'owner' } });
    await expect(M.createAiServiceConfig(null, {
      ownerType: 'APP', ownerId: app.id, name: 'default', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-member',
    }, as(admin))).rejects.toThrow('Forbidden');
  });
  it('App clearing refuses an outsider, impersonated admin, run principal and stale platform role', async () => {
    const config = await M.createAiServiceConfig(null, {
      ownerType: 'APP', ownerId: app.id, name: 'backup', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-owner-only',
    }, as(owner));
    for (const ctx of [as(admin), { ...as(admin, ['ADMIN']), impersonation: { orgId: generateId() } },
      { ...as(admin, ['ADMIN']), clientId: 'run:synthetic' }]) {
      await expect(M.clearAppAIConfig(null, { appRef: app.id }, ctx as Context)).rejects.toThrow();
    }
    await db.user.update({ where: { id: admin }, data: { roles: [] } });
    await expect(M.clearAppAIConfig(null, { appRef: app.id }, as(admin, ['ADMIN']))).rejects.toThrow();
    expect(await db.aiServiceConfig.findUnique({ where: { id: config.id } })).toBeTruthy();
    await expect(M.clearAppAIConfig(null, { appRef: app.id }, as(owner))).resolves.toMatchObject({ id: app.id });
  });

  it.each(['ADMIN', 'OWNER'] as const)('a foreign platform %s cannot create, update or test App provider credentials', async role => {
    const config = await M.createAiServiceConfig(null, {
      ownerType: 'APP', ownerId: app.id, name: 'named', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-synthetic-owner-only',
    }, as(owner));
    const ctx = as(admin, [role]);
    await expect(M.createAiServiceConfig(null, {
      ownerType: 'APP', ownerId: app.id, name: 'foreign', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-foreign',
    }, ctx)).rejects.toThrow('Forbidden');
    await expect(M.updateAiServiceConfig(null, { id: config.id, apiKey: 'sk-foreign' }, ctx)).rejects.toThrow('Forbidden');
    // The test surface conceals an inaccessible config before any provider call.
    await expect(M.testAiServiceConfig(null, { id: config.id }, ctx)).rejects.toThrow('AI service config not found');
    expect((await db.aiServiceConfig.findUniqueOrThrow({ where: { id: config.id } })).updatedBy).not.toBe(admin);
    expect(await db.aiServiceConfig.count({ where: { appId: app.id } })).toBe(1);
  });
  it('owner config reads and changes survive; foreign admins only clear', async () => {
    await M.updateApp(null, { ref: app.id, aiProvider: 'openai', aiModel: 'gpt-4o', aiApiKey: 'sk-synthetic-owner-only' }, as(owner));
    for (const role of ['ADMIN', 'OWNER'] as const) {
      await expect(resolvers.Query.appAIConfig(null, { appRef: app.id }, as(admin, [role]))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      await expect(resolvers.Query.resolveAIConfig(null, { appRef: app.id }, as(admin, [role]))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      await expect(M.updateApp(null, { ref: app.id, aiModel: 'changed-model' }, as(admin, [role]))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      await expect(M.updateApp(null, { ref: app.id, aiApiKey: 'sk-other-key' }, as(admin, [role]))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    }
    await expect(resolvers.Query.appAIConfig(null, { appRef: app.id }, as(owner))).resolves.toMatchObject({ apiKey: 'sk-synthetic-owner-only' });
    await expect(M.updateApp(null, { ref: app.id, aiApiKey: '' }, as(admin, ['ADMIN']))).rejects.toThrow('Forbidden');
  });
});
