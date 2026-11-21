/**
 * #3327 (test-only follow-up to #3316 / #3280): three pins, no production change.
 *
 * Governing rules (Vera's spec FIT on the issue, comment 6668615901):
 *  - hrn:node:hadronmemory.com:specs:cor:dmo:050:09 — an Agent item limits and never grants on its own; a user-backed
 *    run's item entries are intersected with the user's own authority (ruling 0105; the session form is ruling 0108).
 *  - hrn:node:hadronmemory.com:specs:cor:acl:010:01 — `userMemoryOfAgentId` is a discriminator the App's shared access
 *    never admits; a PUBLIC knowledge subscriber writes at its subscription's contributor level; revoked membership
 *    never authorizes.
 *  - hrn:node:hadronmemory.com:specs:cor:dmo:050:08.
 *
 * 1. An OWNED legacy knowledge holding (`userMemoryOfAgentId` set) with a stored Agent item: the intermediate ceiling
 *    (`independentUserItemAccess`) does carry it, yet no App-derived map may admit it.
 * 2. An item on a memory that an independent system path also reaches: refusing the item leaves the independent path.
 * 3. The direct GraphQL gate `requireMemoryWriteAccess`: a positive control for a PUBLIC knowledge subscriber, then its
 *    refusal after the membership (and, separately, the subscription) is revoked.
 */
import { beforeEach, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { getAppMemoryAccess, getMemoryAccess, getPrincipalAppMemoryAccess } from './access-control.js';
import { independentUserItemAccess } from '../lib/auth/independentUserItemAccess.js';
import { requireMemoryWriteAccess, type Context } from '../api/graphql/schema/resolvers.helpers.js';

const lower = () => generateId().toLowerCase();

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
  const org = await db.organization.create({ data: { name: 'Pins3327', urn: `pins3327-${lower()}.example` } });
  const user = await db.user.create({ data: { handle: `pins3327-${lower()}`, roles: ['READER'] } });
  const primary = await installedAgent(org, 'primary');
  const second = await installedAgent(org, 'second');
  const { app } = await createDbAppWithKey(db, 'pins3327', org.id);
  await db.appAgent.create({ data: { appId: app.id, agentId: primary.agent.id, createdAt: new Date(1700000000000) } });
  await db.appAgent.create({ data: { appId: app.id, agentId: second.agent.id, createdAt: new Date(1700000001000) } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  return { org, user, primary, second, app };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => { await cleanDb(db); f = await fixture(); });

it('#3327 case 1: an owned legacy holding is in the intermediate ceiling but in no App-derived map', async () => {
  // A user-owned App with the user's own Agent, so the Agent's tenant independently reaches everything the user owns:
  // the tenant cap and the foreign-owner exclusion cannot be what keeps the holding out, only the per-user-holding rules.
  const agent = await db.agent.create({ data: {
    urn: `@${f.user.handle}:own-agent`, name: 'Own agent', ownerUserId: f.user.id,
  } });
  const app = await db.app.create({ data: {
    id: generateId(), name: 'own-app', urn: `@${f.user.handle}:own-app`, ownerUserId: f.user.id,
  } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: f.user.id, role: 'member' } });
  // Deliberate legacy row (the attach API need not admit it): owned by the user, pointing at the Agent.
  const holding = await db.memory.create({ data: {
    urn: `@${f.user.handle}:legacy-holding`, name: 'Legacy holding', class: 'knowledge',
    ownerUserId: f.user.id, userMemoryOfAgentId: agent.id,
  } });
  // Same shape without the per-user pointer: honoured, so the fold is demonstrably live for this App.
  const control = await db.memory.create({ data: {
    urn: `@${f.user.handle}:control`, name: 'Owned control', class: 'knowledge', ownerUserId: f.user.id,
  } });
  await db.agentMemoryItem.createMany({ data: [holding, control].map(memory => ({
    agentId: agent.id, memoryId: memory.id, role: 'read-write',
  })) });

  // The ceiling really does carry the holding, so only the App-derived layers can be what keeps it out.
  const ceiling = await independentUserItemAccess(db, f.user.id);
  expect(ceiling.get(holding.id)).toBe('READ_WRITE');
  expect(ceiling.get(control.id)).toBe('READ_WRITE');

  const options = { callerUserId: f.user.id, memberAdmitted: true, loadItemUserAccess: () => Promise.resolve(ceiling) };
  const appMap = await getAppMemoryAccess(db, app.id, options);
  expect(appMap.get(control.id)).toBe('READ_WRITE');
  expect(appMap.has(holding.id)).toBe(false);

  // Only the App-derived maps: getMemoryAccess adds the owner's own rows through the owner rule, an independent path
  // that is not an item fold and is deliberately not asserted here.
  const principal = { userId: f.user.id, roles: ['READER' as const] };
  for (const access of [await getPrincipalAppMemoryAccess(db, principal),
    await getPrincipalAppMemoryAccess(db, { ...principal, appId: app.id })]) {
    expect(access.get(control.id)).toBe('READ_WRITE');
    expect(access.has(holding.id)).toBe(false);
  }
});

it('#3327 case 2: refusing an item on a system memory leaves the independently admitted system path', async () => {
  // The primary Agent holds items on (a) its OWN system memory and (b) the SECOND installed Agent's system memory, both
  // read-write. The user's ceiling lacks both (an App-only member), so both items are refused; each system memory is
  // still reached by its own rule, read-only. Also: an item on ordinary knowledge the user cannot reach is plainly
  // absent, so the refusal is real rather than an artefact of the fixture.
  const knowledge = await db.memory.create({ data: {
    urn: `${f.org.urn}:refused`, name: 'Refused knowledge', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: f.org.id,
  } });
  await db.agentMemoryItem.createMany({ data: [f.primary.system, f.second.system, knowledge].map(memory => ({
    agentId: f.primary.agent.id, memoryId: memory.id, role: 'read-write',
  })) });
  const ceiling = await independentUserItemAccess(db, f.user.id);
  for (const memory of [f.primary.system, f.second.system, knowledge]) expect(ceiling.has(memory.id)).toBe(false);

  const viaApp = await getAppMemoryAccess(db, f.app.id, {
    callerUserId: f.user.id, includeTeamSpace: false, loadItemUserAccess: () => Promise.resolve(ceiling),
  });
  expect(viaApp.has(knowledge.id)).toBe(false); // refused item contributes nothing
  expect(viaApp.get(f.primary.system.id)).toBe('READ_ONLY'); // the Agent's own system memory folds on its own rule
  expect(viaApp.get(f.second.system.id)).not.toBe('READ_WRITE'); // never a write from the refused item

  const principal = { userId: f.user.id, roles: ['READER' as const] };
  for (const access of [await getPrincipalAppMemoryAccess(db, principal), await getMemoryAccess(db, principal)]) {
    expect(access.has(knowledge.id)).toBe(false);
    expect(access.get(f.primary.system.id)).toBe('READ_ONLY');
    expect(access.get(f.second.system.id)).toBe('READ_ONLY');
  }
});

it('#3327 case 2: a read-only ceiling clamps a read-write item to read, it does not refuse it', async () => {
  const knowledge = await db.memory.create({ data: {
    urn: `${f.org.urn}:clamped`, name: 'Clamped knowledge', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: f.org.id,
  } });
  await db.orgMember.create({ data: { userId: f.user.id, organizationId: f.org.id, role: 'READER' } });
  await db.agentMemoryItem.create({ data: { agentId: f.primary.agent.id, memoryId: knowledge.id, role: 'read-write' } });
  const ceiling = await independentUserItemAccess(db, f.user.id);
  expect(ceiling.get(knowledge.id)).toBe('READ_ONLY');
  const access = await getAppMemoryAccess(db, f.app.id, {
    callerUserId: f.user.id, includeTeamSpace: false, loadItemUserAccess: () => Promise.resolve(ceiling),
  });
  expect(access.get(knowledge.id)).toBe('READ_ONLY');
});

async function publicSubscriber() {
  const owning = await db.organization.create({ data: { name: 'Owning3327', urn: `owning3327-${lower()}.example` } });
  const memory = await db.memory.create({ data: {
    urn: `${owning.urn}:public`, name: 'Public knowledge', class: 'knowledge', visibility: 'PUBLIC', organizationId: owning.id,
  } });
  const membership = await db.orgMember.create({ data: { userId: f.user.id, organizationId: f.org.id, role: 'CONTRIBUTOR' } });
  const subscription = await db.memorySubscription.create({ data: {
    id: generateId(), memoryId: memory.id, organizationId: f.org.id, role: 'CONTRIBUTOR',
  } });
  const canWrite = async () => {
    try { await requireMemoryWriteAccess({ db, userId: f.user.id, roles: [] } as Context, memory.id); return true; }
    catch (error) {
      const e = error as { extensions?: { code?: string } };
      if (e.extensions?.code !== 'FORBIDDEN') throw error;
      return false;
    }
  };
  return { memory, membership, subscription, canWrite };
}

it('#3327 case 3: requireMemoryWriteAccess admits a PUBLIC subscriber, then refuses once the membership is revoked', async () => {
  const s = await publicSubscriber();
  expect(await s.canWrite()).toBe(true); // positive control: the exact scenario is admitted before revocation
  await db.orgMember.update({ where: { id: s.membership.id }, data: { deletedAt: new Date() } });
  expect(await s.canWrite()).toBe(false);
});

it('#3327 case 3: requireMemoryWriteAccess refuses once the subscription is revoked, membership intact', async () => {
  const s = await publicSubscriber();
  expect(await s.canWrite()).toBe(true);
  await db.memorySubscription.update({ where: { id: s.subscription.id }, data: { deletedAt: new Date() } });
  expect(await s.canWrite()).toBe(false);
});
