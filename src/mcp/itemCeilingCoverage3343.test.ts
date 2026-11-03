/** #3343: intermediate item-ceiling contracts and query budgets; no eligibility change. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { getAppMemoryAccess, getPrincipalAppMemoryAccess } from './access-control.js';
import { independentUserItemAccess } from '../lib/auth/independentUserItemAccess.js';
import { systemMemoryReadGrants } from '../lib/auth/systemMemoryRead.js';

async function installedAgent(org: { id: string; urn: string }, slug: string) {
  const system = await db.memory.create({ data: {
    urn: `${org.urn}:${slug}-system`, name: `${slug} system`, class: 'system', organizationId: org.id,
  } });
  const agent = await db.agent.create({ data: {
    urn: `${org.urn}:${slug}`, name: slug, organizationId: org.id, systemMemoryId: system.id,
  } });
  return { agent, system };
}

async function fixture() {
  const org = await db.organization.create({ data: { name: 'Pins3343', urn: `pins-${generateId().toLowerCase()}.example` } });
  const user = await db.user.create({ data: { handle: `pins-${generateId().toLowerCase()}`, roles: ['READER'] } });
  const { agent, system } = await installedAgent(org, 'primary');
  const knowledge = await db.memory.create({ data: {
    urn: `${org.urn}:knowledge`, name: 'Item-only knowledge', class: 'knowledge', organizationId: org.id, visibility: 'ORGANIZATION',
  } });
  const publicMemory = await db.memory.create({ data: {
    urn: `${org.urn}:public`, name: 'Public control', class: 'knowledge', organizationId: org.id, visibility: 'PUBLIC',
  } });
  await db.agentMemoryItem.createMany({ data: [knowledge, publicMemory].map(memory => ({
    agentId: agent.id, memoryId: memory.id, role: 'read-write',
  })) });
  const addApp = async (name: string, agentId = agent.id) => {
    const { app } = await createDbAppWithKey(db, name, org.id);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
    return app;
  };
  const app = await addApp('first');
  return { org, user, agent, system, knowledge, publicMemory, app, addApp };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { await cleanDb(db); f = await fixture(); });

it('#3343 rejects ordinary item-only knowledge before any system-candidate lookup, preserving installed-system attribution', async () => {
  expect(await db.orgMember.count({ where: { userId: f.user.id } })).toBe(0); // App-only member, no independent org authority.
  const appLookup = vi.spyOn(db.app, 'findUnique');
  const agentLookup = vi.spyOn(db.agent, 'findFirst');
  try {
    const principal = { userId: f.user.id, roles: ['READER'] };
    expect(await systemMemoryReadGrants(db, principal, f.knowledge.id)).toEqual([]);
    expect(agentLookup).not.toHaveBeenCalled(); // Stored class is checked before even resolving a definition pointer.
    expect(appLookup).not.toHaveBeenCalled(); // In particular, no trusted candidate/provenance fold.

    const grants = await systemMemoryReadGrants(db, principal, f.system.id);
    expect(grants).toContainEqual(expect.objectContaining({ source: 'APP_MEMBER', role: 'member', via: f.app.urn }));
    expect(grants.every(grant => grant.caps.read && !grant.caps.write)).toBe(true);
    expect(agentLookup).toHaveBeenCalled();
    expect(appLookup.mock.calls.some(([args]) => args.where.id === f.app.id && args.select?.appAgents)).toBe(true);
  } finally { appLookup.mockRestore(); agentLookup.mockRestore(); }
});

it('#3343 computes one independent-user ceiling across three unselected App folds', async () => {
  const apps = [f.app, await f.addApp('second'), await f.addApp('third')];
  const memoryReads = vi.spyOn(db.memory, 'findMany');
  const appReads = vi.spyOn(db.app, 'findUnique');
  try {
    const access = await getPrincipalAppMemoryAccess(db, { userId: f.user.id });
    expect(access.has(f.knowledge.id)).toBe(false);
    expect(access.get(f.publicMemory.id)).toBe('READ_ONLY');
    expect(access.get(f.system.id)).toBe('READ_ONLY');
    // This is the owned-memory query within the real independentUserItemAccess loader, not a mocked authority map.
    expect(memoryReads.mock.calls.filter(([args]) => args?.where?.ownerUserId === f.user.id &&
      args.where.isInstallMemory === false && args.select?.id === true)).toHaveLength(1);
    const foldedAppIds = appReads.mock.calls.filter(([args]) => args.select?.appAgents).map(([args]) => args.where.id);
    expect(foldedAppIds.sort()).toEqual(apps.map(app => app.id).sort());
  } finally { memoryReads.mockRestore(); appReads.mockRestore(); }
});

it('#3343 does not load the independent ceiling for an unlicensed Agent with a live item', async () => {
  const foreignOrg = await db.organization.create({ data: { name: 'Foreign', urn: `foreign-${generateId().toLowerCase()}.example` } });
  const foreign = await installedAgent(foreignOrg, 'foreign');
  const knowledge = await db.memory.create({ data: {
    urn: `${foreignOrg.urn}:knowledge`, name: 'Foreign knowledge', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: foreignOrg.id,
  } });
  await db.agentMemoryItem.create({ data: { agentId: foreign.agent.id, memoryId: knowledge.id, role: 'read-write' } });
  await db.orgMember.create({ data: { userId: f.user.id, organizationId: foreignOrg.id, role: 'CONTRIBUTOR' } });
  const app = await f.addApp('unlicensed', foreign.agent.id); // Installed in our org, but no cross-org AgentOrgGrant.
  const loadItemUserAccess = vi.fn(() => independentUserItemAccess(db, f.user.id));
  const options = { callerUserId: f.user.id, includeTeamSpace: false, loadItemUserAccess };
  expect(await getAppMemoryAccess(db, app.id, options)).toEqual(new Map());
  expect(loadItemUserAccess).not.toHaveBeenCalled();

  // Calibrate the same spy and live item: granting the install license makes its real user ceiling load once.
  await db.agentOrgGrant.create({ data: { orgId: f.org.id, agentId: foreign.agent.id, activatedAt: new Date() } });
  const licensed = await getAppMemoryAccess(db, app.id, options);
  expect(loadItemUserAccess).toHaveBeenCalledTimes(1);
  expect(licensed.get(foreign.system.id)).toBe('READ_ONLY');
  expect(licensed.get(knowledge.id)).toBe('READ_WRITE');
});

it.each(['personal', 'private'] as const)('#3343 M12: an owned %s stays out of the intermediate item map despite a legacy item', async memoryClass => {
  const ownedKnowledge = await db.memory.create({ data: {
    urn: `@${f.user.handle}:owned-knowledge`, name: 'Owned knowledge control', class: 'knowledge', ownerUserId: f.user.id,
  } });
  const personal = await db.memory.create({ data: {
    urn: `@${f.user.handle}:${memoryClass}`, name: memoryClass, class: memoryClass,
    ownerUserId: f.user.id, userId: f.user.id, userMemoryOfAgentId: f.agent.id,
  } });
  // Deliberate legacy rows: the attach API need not admit these for the intermediate helper's class contract to hold.
  await db.agentMemoryItem.createMany({ data: [ownedKnowledge, personal].map(memory => ({
    agentId: f.agent.id, memoryId: memory.id, role: 'read-write',
  })) });
  const access = await independentUserItemAccess(db, f.user.id);
  expect(access.get(ownedKnowledge.id)).toBe('READ_WRITE');
  expect(access.get(f.publicMemory.id)).toBe('READ_ONLY');
  expect(access.has(personal.id)).toBe(false);
});
