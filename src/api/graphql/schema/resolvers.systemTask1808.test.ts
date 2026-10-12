import type { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { getManagedSystemMemoryIds } from '../../../lib/auth/managedSystemMemory.js';
import { getOrgReadableMemoryIds } from '../../../lib/auth/orgReadableMemory.js';

const Q = resolvers.Query;
const M = resolvers.Mutation;
let orgId: string, foreignOrgId: string, memoryId: string, agentId: string, appId: string;
const users: Record<string, string> = {};
const context = (who: string): Context => ({ db, userId: users[who], roles: ['READER'] });
const search = (ctx: Context, ids = [memoryId]) => Q.findNodes({}, { filter: { memoryIds: ids, isRunnable: true } }, ctx);
const scope = (ctx: Context, ref = memoryId) => M.createScope({}, { input: { name: 'export-tasks', organizationRef: orgId, memoryRefs: [ref] } }, ctx);

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), urn: 'task1808.example', name: 'Tasks' } })).id;
  foreignOrgId = (await db.organization.create({ data: { id: generateId(), urn: 'foreign1808.example', name: 'Foreign' } })).id;
  for (const [who, role, organizationId] of [['admin', 'ADMIN', orgId], ['owner', 'OWNER', orgId], ['contributor', 'CONTRIBUTOR', orgId], ['reader', 'READER', orgId], ['foreign', 'ADMIN', foreignOrgId]] as const) {
    users[who] = (await db.user.create({ data: { id: generateId(), handle: `task1808-${who}`, roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { userId: users[who], organizationId, role } });
  }
  memoryId = (await db.memory.create({ data: { id: generateId(), urn: 'task1808.example:system', name: 'Definition', class: 'system', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), urn: 'task1808.example:agent', name: 'Agent', organizationId: orgId, systemMemoryId: memoryId } })).id;
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'tasks:run', name: 'Task', content: '# Run me', isRunnable: true, properties: { exports: { claudeSkill: { name: 'system-task', description: 'Run the system task. Use when requested.', enable: true } } } } });
  appId = (await db.app.create({ data: { id: generateId(), urn: 'foreign1808.example:app', name: 'Installed', organizationId: foreignOrgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
});

describe('#1808 ruled system task audience', () => {
  const userOwned = async () => {
    const memory = await db.memory.create({ data: { id: generateId(), urn: 'task1808-owner:system', name: 'Owned definition', class: 'system', ownerUserId: users.owner } });
    await db.agent.create({ data: { id: generateId(), urn: 'task1808-owner:agent', name: 'Owned Agent', ownerUserId: users.owner, systemMemoryId: memory.id } });
    return memory.id;
  };

  it('the helper admits a user-owned Agent only to its matching owner, with null org tenants', async () => {
    const ownedId = await userOwned();
    expect(await getManagedSystemMemoryIds(db, users.owner, ownedId)).toEqual([ownedId]);
    expect(await getManagedSystemMemoryIds(db, users.foreign, ownedId)).toEqual([]);
    await db.memory.update({ where: { id: ownedId }, data: { ownerUserId: users.foreign } });
    expect(await getManagedSystemMemoryIds(db, users.owner, ownedId)).toEqual([]);
  });

  it('the helper excludes user-owned Agents from an impersonation org view', async () => {
    const ownedId = await userOwned();
    expect(await getManagedSystemMemoryIds(db, users.owner, ownedId, orgId)).toEqual([]);
    // The same support view retains the accepted, in-org managed definition.
    expect(await getManagedSystemMemoryIds(db, users.owner, memoryId, orgId)).toEqual([memoryId]);
  });

  it.each(['org-to-user', 'user-to-org'])('the helper refuses %s tenant-null mismatches', async (direction) => {
    const ownedId = await userOwned();
    if (direction === 'org-to-user') {
      await db.agent.update({ where: { id: agentId }, data: { systemMemoryId: ownedId } });
      expect(await getManagedSystemMemoryIds(db, users.admin, ownedId)).toEqual([]);
    } else {
      await db.agent.updateMany({ where: { ownerUserId: users.owner }, data: { systemMemoryId: memoryId } });
      expect(await getManagedSystemMemoryIds(db, users.owner, memoryId)).toEqual([memoryId]);
      // Remove the independent org-management grant to isolate the bad pointer.
      await db.orgMember.delete({ where: { organizationId_userId: { organizationId: orgId, userId: users.owner } } });
      expect(await getManagedSystemMemoryIds(db, users.owner, memoryId)).toEqual([]);
    }
  });

  it('the helper refuses a live non-system row behind a system-memory pointer', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { class: 'knowledge', visibility: 'ORGANIZATION' } });
    expect(await getManagedSystemMemoryIds(db, users.admin, memoryId)).toEqual([]);
  });

  it('a manager-query rejection propagates instead of returning a partial readable set', async () => {
    await db.memory.create({ data: { id: generateId(), urn: 'task1808.example:ordinary', name: 'Ordinary', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgId } });
    const failure = new Error('synthetic manager query failure');
    const mock = vi.spyOn(db.agent, 'findMany').mockRejectedValueOnce(failure);
    try {
      await expect(getOrgReadableMemoryIds(db, users.admin)).rejects.toBe(failure);
    } finally { mock.mockRestore(); }
  });
  it('the shared manager arm is scoped and fails closed without a user', async () => {
    expect(await getManagedSystemMemoryIds(db, '')).toEqual([]);
    expect(await getManagedSystemMemoryIds(db, users.admin, memoryId)).toEqual([memoryId]);
    expect(await getManagedSystemMemoryIds(db, users.admin, generateId())).toEqual([]);
    expect(await getManagedSystemMemoryIds(db, users.admin, memoryId, foreignOrgId)).toEqual([]);
    expect((await search({ ...context('admin'), impersonation: { orgId: foreignOrgId } as Context['impersonation'] })).hits).toEqual([]);
  });
  it.each(['admin', 'owner'])('%s can independently select a system memory for export', async (who) => {
    const created = await scope(context(who));
    expect((await Q.scopeExplain({}, { scopeRef: created.id }, context(who)))?.memories.map(memory => memory.id)).toEqual([memoryId]);
  });
  it.each(['admin', 'owner'])('%s can find named tasks and create a usable export scope', async (who) => {
    const ctx = context(who);
    expect((await search(ctx)).hits.map(hit => hit.node.loc)).toEqual(['tasks:run']);
    const created = await scope(ctx);
    const explained = await Q.scopeExplain({}, { scopeRef: created.id }, ctx);
    expect(explained?.memories.map(memory => memory.id)).toEqual([memoryId]);
    const exported = await Q.skillPlan({}, { input: { intent: 'EXPORT', host: 'claudeSkill', scopeRef: created.id } }, ctx);
    expect(exported.entries.map(entry => entry.urn)).toEqual([expect.stringContaining('tasks:run')]);
    expect(exported.entries[0].renderedBody).toContain('Run me');
    expect(exported.entries[0].exportPlan).not.toBeNull();
    expect(await canReadMemory(db, { userId: users[who], roles: ['READER'] }, memoryId)).toBe(true);
    expect((await search(ctx, ['task1808.example:system'])).hits).toHaveLength(1);
    // A stored scope never grants its hidden memory to another org member.
    const hidden = await Q.scopeExplain({}, { scopeRef: created.id }, context('contributor'));
    expect(hidden?.memories).toEqual([]);
    await expect(Q.skillPlan({}, { input: { intent: 'EXPORT', scopeRef: created.id } }, context('contributor'))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it.each(['contributor', 'reader', 'foreign'])('%s sees the same empty search for denied and missing ids', async (who) => {
    expect((await search(context(who))).hits).toEqual([]);
    expect((await search(context(who), [generateId()])).hits).toEqual([]);
    expect(await canReadMemory(db, { userId: users[who], roles: ['READER'] }, memoryId)).toBe(false);
  });

  it('scope memoryRefs conceal a denied system memory exactly like a missing memory', async () => {
    const refusal = async (ref: string) => scope(context('contributor'), ref).then(() => null, (error: GraphQLError) => ({ message: error.message, code: error.extensions?.code }));
    const denied = await refusal(memoryId);
    const missingId = generateId();
    const missing = await refusal(missingId);
    expect(denied?.code).toBe('BAD_USER_INPUT');
    expect(denied?.message.replace(memoryId, 'REF')).toEqual(missing?.message.replace(missingId, 'REF'));
    expect(await db.scope.count()).toBe(0);
  });

  it.each(['membership', 'agent', 'memory', 'organization'])('manager access ends when %s is revoked/deleted', async (kind) => {
    if (kind === 'membership') await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: users.admin } }, data: { deletedAt: new Date() } });
    if (kind === 'agent') await db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } });
    if (kind === 'memory') await db.memory.update({ where: { id: memoryId }, data: { deletedAt: new Date() } });
    if (kind === 'organization') await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    expect((await search(context('admin'))).hits).toEqual([]);
  });

  it('an org admin cannot gain a foreign system memory through a mismatched Agent pointer', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { organizationId: foreignOrgId } });
    expect((await search(context('admin'))).hits).toEqual([]);
    await expect(scope(context('admin'))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('manager revocation removes an existing scope selection and its export', async () => {
    const created = await scope(context('admin'));
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: users.admin } }, data: { role: 'CONTRIBUTOR' } });
    expect((await Q.scopeExplain({}, { scopeRef: created.id }, context('admin')))?.memories).toEqual([]);
    await expect(Q.skillPlan({}, { input: { intent: 'EXPORT', scopeRef: created.id } }, context('admin'))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('an installed foreign App needs a live license, and loses access when it is revoked', async () => {
    const appContext = (): Context => ({ db, appId });
    expect((await search(appContext())).hits).toEqual([]);
    await db.agentOrgGrant.create({ data: { orgId: foreignOrgId, agentId, activatedAt: new Date() } });
    expect((await search(appContext())).hits).toHaveLength(1);
    // The App's org admin can build its scope from licensed App-derived reach.
    const selected = { ...context('foreign'), appId };
    const created = await M.createScope({}, { input: { name: 'installed-tasks', organizationRef: foreignOrgId, memoryRefs: [memoryId] } }, selected);
    expect((await Q.scopeExplain({}, { scopeRef: created.id }, selected))?.memories).toHaveLength(1);
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: foreignOrgId, agentId } }, data: { revokedAt: new Date() } });
    expect((await search(appContext())).hits).toEqual([]);
    expect((await Q.scopeExplain({}, { scopeRef: created.id }, { ...context('foreign'), appId }))?.memories).toEqual([]);
  });
});
