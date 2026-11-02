/** #3233: runs reuse the installed/licensed own-definition fold, not install order or the user's participation. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { canReadMemory, canWriteToMemory, getPrincipalAppMemoryAccess } from './access-control.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let org: { id: string }; let app: { id: string }; let member: { id: string }; let admin: { id: string };
let agents: Array<{ id: string; systemMemoryId: string }>;
const makeUser = () => db.user.create({ data: { id: generateId(), handle: `run-${generateId().toLowerCase()}`, roles: ['READER'] } });
const ctx = (userId: string) => ({ db, userId, roles: ['READER'] }) as unknown as Context;
const run = (onBehalf: boolean) => ({ appId: app.id, ...(onBehalf ? { userId: member.id } : {}), roles: [], clientId: `run:${generateId()}` }) as AuthContext;
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Run folds', urn: `run-${generateId().toLowerCase()}.example` } });
  admin = await makeUser(); member = await makeUser();
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agents = [];
  for (const name of ['First', 'Second']) agents.push(await M.createAgent({}, { orgId: org.id, name }, ctx(admin.id)));
  ({ app } = await createDbAppWithKey(db, 'run-fold', org.id));
  for (const [i, a] of agents.entries()) await db.appAgent.create({ data: { appId: app.id, agentId: a.id, createdAt: new Date(1700000000000 + i * 1000) } });
  await createDbAppMember(db, app.id, member.id, 'member');
});
async function expectReadOnly(auth: AuthContext, id: string) {
  expect((await getPrincipalAppMemoryAccess(db, auth)).get(id)).toBe('READ_ONLY');
  expect(await canReadMemory(db, auth, id)).toBe(true);
  expect(await canWriteToMemory(db, auth, id)).toBe(false);
  expect(await getAccessibleMemoryIds({ ...auth, db } as unknown as Context)).toContain(id);
}
async function foreignAgent() {
  const foreign = await db.organization.create({ data: { id: generateId(), name: 'Foreign', urn: `foreign-${generateId().toLowerCase()}.example` } });
  await db.orgMember.create({ data: { organizationId: foreign.id, userId: admin.id, role: 'ADMIN' } });
  const a = await M.createAgent({}, { orgId: foreign.id, name: 'Licensed foreign' }, ctx(admin.id));
  await createDbAppAgent(db, app.id, a.id);
  return a as { id: string; systemMemoryId: string };
}
describe.each([false, true])('#3233 run on-behalf-of=%s', onBehalf => {
  it('reads both installed definitions read-only through point and list gates', async () => {
    const auth = run(onBehalf);
    for (const a of agents) await expectReadOnly(auth, a.systemMemoryId);
  });
  it('does not inherit the on-behalf user participation in another App', async () => {
    const { app: other } = await createDbAppWithKey(db, 'other-fold', org.id);
    const a = await M.createAgent({}, { orgId: org.id, name: 'Other app only' }, ctx(admin.id));
    await createDbAppAgent(db, other.id, a.id); await createDbAppMember(db, other.id, member.id, 'member');
    expect((await getPrincipalAppMemoryAccess(db, run(onBehalf))).has(a.systemMemoryId)).toBe(false);
  });
  it('reads a foreign definition only under its active install licence', async () => {
    const a = await foreignAgent(); const auth = run(onBehalf);
    expect(await canReadMemory(db, auth, a.systemMemoryId)).toBe(false);
    await db.agentOrgGrant.create({ data: { agentId: a.id, orgId: org.id, activatedAt: new Date() } });
    await expectReadOnly(auth, a.systemMemoryId);
    await db.agentOrgGrant.update({ where: { orgId_agentId: { agentId: a.id, orgId: org.id } }, data: { revokedAt: new Date() } });
    expect(await canReadMemory(db, auth, a.systemMemoryId)).toBe(false);
  });
  it.each(['uninstalled-agent', 'deleted-agent', 'deleted-memory', 'uninstalled-app', 'deleted-app', 'deleted-org'] as const)('refuses %s', async kind => {
    const a = agents[1]; const auth = run(onBehalf);
    if (kind === 'uninstalled-agent') await db.appAgent.delete({ where: { appId_agentId: { appId: app.id, agentId: a.id } } });
    if (kind === 'deleted-agent') await db.agent.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    if (kind === 'deleted-memory') await db.memory.update({ where: { id: a.systemMemoryId }, data: { deletedAt: new Date() } });
    if (kind === 'uninstalled-app') await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    if (kind === 'deleted-app') await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    if (kind === 'deleted-org') await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect((await getPrincipalAppMemoryAccess(db, auth)).has(a.systemMemoryId)).toBe(false);
    expect(await canReadMemory(db, auth, a.systemMemoryId)).toBe(false);
  });
  it.each([0, 1])('rejects wrong-class, foreign-tenant and install pointers even at install position %s', async position => {
    const a = agents[position]; const auth = run(onBehalf);
    const foreign = await db.organization.create({ data: { id: generateId(), name: 'Other', urn: `bad-${generateId().toLowerCase()}.example` } });
    const rows = [
      await db.memory.create({ data: { class: 'knowledge', name: 'wrong class', urn: `bad-${generateId().toLowerCase()}:class`, organizationId: org.id } }),
      await db.memory.create({ data: { class: 'system', name: 'wrong tenant', urn: `bad-${generateId().toLowerCase()}:tenant`, organizationId: foreign.id } }),
      await db.memory.create({ data: { class: 'system', name: 'wrong owner', urn: `bad-${generateId().toLowerCase()}:owner`, ownerUserId: member.id } }),
      await db.memory.create({ data: { class: 'system', name: 'install', urn: `bad-${generateId().toLowerCase()}:install`, organizationId: org.id, appId: app.id, isInstallMemory: true, installOfAgentId: a.id } }),
    ];
    for (const row of rows) {
      await db.agent.update({ where: { id: a.id }, data: { systemMemoryId: row.id } });
      expect((await getPrincipalAppMemoryAccess(db, auth)).has(row.id), row.name).toBe(false);
    }
  });
  it('rejects a user-owned Agent pointer to another owner in the same null-org tenant shape', async () => {
    const personalApp = await db.app.create({ data: { name: 'Personal', urn: `personal-${generateId().toLowerCase()}:app`, ownerUserId: member.id } });
    const memory = await db.memory.create({ data: { class: 'system', name: 'Other owner', urn: `personal-${generateId().toLowerCase()}:def`, ownerUserId: member.id } });
    const a = await db.agent.create({ data: { name: 'User Agent', urn: `personal-${generateId().toLowerCase()}:agent`, ownerUserId: admin.id, visibility: 'PERSONAL', systemMemoryId: memory.id } });
    await createDbAppAgent(db, personalApp.id, a.id);
    await db.agentSubscription.create({ data: { userId: member.id, agentId: a.id, activatedAt: new Date() } });
    expect((await getPrincipalAppMemoryAccess(db, { ...run(onBehalf), appId: personalApp.id })).has(memory.id)).toBe(false);
  });
  it('does not add the run fold to impersonated or session-bound shapes', async () => {
    const auth = run(onBehalf);
    for (const blocked of [{ ...auth, impersonation: { orgId: org.id } }, { ...auth, sessionId: generateId() }]) {
      expect((await getPrincipalAppMemoryAccess(db, blocked)).has(agents[1].systemMemoryId)).toBe(false);
    }
  });
  it('does not widen second-Agent items or keys/session-isolated principals', async () => {
    const a = agents[1];
    const item = await db.memory.create({ data: { class: 'knowledge', name: 'second item', urn: `item-${generateId().toLowerCase()}:second`, organizationId: org.id, appId: app.id } });
    await db.agentMemoryItem.create({ data: { agentId: a.id, memoryId: item.id, role: 'read-write' } });
    expect((await getPrincipalAppMemoryAccess(db, run(onBehalf))).has(item.id)).toBe(false);
    for (const auth of [{ appId: app.id, roles: [], clientId: 'app' }, { appId: app.id, sessionId: generateId(), roles: [], clientId: 'app' }] as AuthContext[]) {
      expect(await canReadMemory(db, auth, a.systemMemoryId)).toBe(false);
    }
    expect(await canReadMemory(db, { userId: member.id, roles: [], clientId: `user:${member.id}` } as AuthContext, a.systemMemoryId)).toBe(true);
  });
});
