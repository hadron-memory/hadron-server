/** #3289: compare the subscription domain, preserving independent doors and uncapped sentinels. */
import { beforeEach, expect, it } from 'vitest';
import type { Role } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { getOrgReadableMemoryIds } from './orgReadableMemory.js';
import { subscribedAgentMemoryAdmitted } from './memorySubscriptionAccess.js';
import {
  cappedLinkLevel, independentReach, LINK_CAP_MEMORY_SELECT,
  type LinkCapMemory, type LinkTenant,
} from './agentMemoryLinkCap.js';
import { requireMemoryWriteAccess, type Context } from '../../api/graphql/schema/resolvers.helpers.js';

let a: string, b: string, c: string, owner: string, consumer: string, memory: string, agent: string;
const tenant = (): LinkTenant => ({ organizationId: b, ownerUserId: null });
const subscription = (role: Role = 'CONTRIBUTOR', organizationId = b, extra = {}) =>
  db.memorySubscription.create({ data: { id: generateId(), memoryId: memory, organizationId, role, ...extra } });
const loaded = () => db.memory.findUniqueOrThrow({ where: { id: memory }, select: LINK_CAP_MEMORY_SELECT });
const link = (role: 'read' | 'read-write', org: string | null = b) =>
  db.$transaction(tx => subscribedAgentMemoryAdmitted(tx, org, memory, role));
async function canonicalWrite() {
  try { await requireMemoryWriteAccess({ db, userId: consumer, roles: [] } as Context, memory); return true; }
  catch (error) {
    if ((error as { extensions?: { code?: string } }).extensions?.code !== 'FORBIDDEN') throw error;
    return false;
  }
}
async function assertCommon(expected: 'READ_ONLY' | 'READ_WRITE' | null) {
  const row = await loaded();
  const read = (await getOrgReadableMemoryIds(db, consumer, memory)).includes(memory);
  const write = await canonicalWrite();
  expect({ read, write }).toEqual({ read: expected !== null, write: expected === 'READ_WRITE' });
  expect(await link('read')).toBe(read);
  expect(await link('read-write')).toBe(write);
  expect(independentReach(tenant(), row)).toBe(expected);
  expect(cappedLinkLevel(tenant(), row, 'read')).toBe(read ? 'READ_ONLY' : null);
  expect(cappedLinkLevel(tenant(), row, 'read-write')).toBe(expected);
}

beforeEach(async () => {
  await cleanDb(db);
  const org = async () => (await db.organization.create({
    data: { id: generateId(), name: 'Synthetic', urn: `o${generateId()}` },
  })).id;
  [a, b, c] = await Promise.all([org(), org(), org()]);
  owner = (await db.user.create({ data: { id: generateId(), handle: `u${generateId()}` } })).id;
  consumer = (await db.user.create({ data: { id: generateId(), handle: `u${generateId()}` } })).id;
  await db.orgMember.create({ data: { organizationId: b, userId: consumer, role: 'ADMIN' } });
  agent = (await db.agent.create({
    data: { id: generateId(), organizationId: b, name: 'Synthetic', urn: `a${generateId()}` },
  })).id;
  memory = (await db.memory.create({
    data: { id: generateId(), organizationId: a, class: 'knowledge', visibility: 'ORGANIZATION', name: 'Synthetic', urn: `m${generateId()}` },
  })).id;
});

for (const role of ['READER', 'CONTRIBUTOR', 'ADMIN', 'OWNER'] as const) {
  for (const activated of [false, true]) {
    it(`${role}, activated=${activated}: canonical access, link admission and runtime cap agree`, async () => {
      await subscription(role, b, { activated });
      // No license row: a link adds no license check beyond canonical read (0089 A).
      await db.memory.update({ where: { id: memory }, data: { requiresLicense: true } });
      await assertCommon(role === 'READER' ? 'READ_ONLY' : 'READ_WRITE');
    });
  }
}
for (const state of ['missing', 'deleted', 'wrong-org'] as const) {
  it(`${state} subscription gives no independent reach or link`, async () => {
    if (state !== 'missing') await subscription('CONTRIBUTOR', state === 'wrong-org' ? c : b,
      state === 'deleted' ? { deletedAt: new Date() } : {});
    await assertCommon(null);
    if (state === 'missing') {
      const { subscriptions: _absent, ...withoutSubscriptions } = await loaded();
      expect(independentReach(tenant(), withoutSubscriptions)).toBeNull();
    }
  });
}
for (const kind of ['group', 'system', 'app-scoped', 'user-memory'] as const) {
  it(`${kind} remains outside the shared subscription domain`, async () => {
    if (kind === 'group') await db.memory.update({ where: { id: memory }, data: { class: 'group', visibility: 'GROUP' } });
    if (kind === 'system') await db.memory.update({ where: { id: memory }, data: { class: 'system', visibility: null } });
    if (kind === 'app-scoped') {
      const app = await db.app.create({ data: { id: generateId(), organizationId: a, name: 'Synthetic', urn: `p${generateId()}` } });
      await db.memory.update({ where: { id: memory }, data: { appId: app.id } });
    }
    if (kind === 'user-memory') await db.memory.update({ where: { id: memory }, data: { userMemoryOfAgentId: agent, createdBy: owner } });
    await subscription();
    await assertCommon(null);
  });
}
for (const kind of ['personal', 'private', 'app'] as const) {
  it(`${kind}: downstream-gated sentinel is not subscription admission`, async () => {
    if (kind === 'app') {
      const app = await db.app.create({ data: { id: generateId(), organizationId: a, name: 'Synthetic', urn: `p${generateId()}` } });
      await db.memory.update({ where: { id: memory }, data: { class: 'app', visibility: null, appId: app.id } });
    } else {
      await db.memory.update({ where: { id: memory }, data: { class: kind, visibility: null, organizationId: null, ownerUserId: owner, userId: owner } });
    }
    await subscription();
    const row = await loaded();
    expect(await getOrgReadableMemoryIds(db, consumer, memory)).not.toContain(memory);
    expect(await canonicalWrite()).toBe(false);
    expect(await link('read')).toBe(false);
    expect(await link('read-write')).toBe(false);
    // undefined delegates strict/App access checks downstream; it is deliberately not a reach grant.
    expect(independentReach(tenant(), row)).toBeUndefined();
    expect(cappedLinkLevel(tenant(), row, 'read-write')).toBe('READ_WRITE');
  });
}
it('downgrade, soft-revoke and hard-unsubscribe cap an existing item at use time', async () => {
  const sub = await subscription();
  await db.agentMemoryItem.create({ data: { agentId: agent, memoryId: memory, role: 'read-write' } });
  const stored = await db.agentMemoryItem.findUniqueOrThrow({ where: { agentId_memoryId: { agentId: agent, memoryId: memory } } });
  await assertCommon('READ_WRITE');
  await db.memorySubscription.update({ where: { id: sub.id }, data: { role: 'READER' } });
  await assertCommon('READ_ONLY');
  await db.memorySubscription.update({ where: { id: sub.id }, data: { deletedAt: new Date() } });
  await assertCommon(null);
  await db.memorySubscription.delete({ where: { id: sub.id } });
  await assertCommon(null);
  expect(await db.agentMemoryItem.findUnique({ where: { agentId_memoryId: { agentId: agent, memoryId: memory } } })).toEqual(stored);
});
it('org-less Agent has no subscription route, although the member caller independently reads', async () => {
  await subscription();
  const row = await loaded();
  expect(await getOrgReadableMemoryIds(db, consumer, memory)).toContain(memory);
  expect(await link('read', null)).toBe(false);
  expect(independentReach({ organizationId: null, ownerUserId: owner }, row)).toBeNull();
  expect(cappedLinkLevel({ organizationId: null, ownerUserId: owner }, row, 'read-write')).toBeNull();
});
it('independent own-org, user-owner, same-App and PUBLIC doors keep their separate meanings', async () => {
  const row = await loaded();
  expect(independentReach(tenant(), { ...row, organizationId: b })).toBe('READ_WRITE');
  const owned: LinkCapMemory = { ...row, organizationId: null, ownerUserId: owner };
  expect(independentReach({ organizationId: null, ownerUserId: owner }, owned)).toBe('READ_WRITE');
  expect(independentReach({ ...tenant(), userId: owner }, owned)).toBe('READ_WRITE');
  expect(independentReach(tenant(), owned)).toBeNull();
  expect(independentReach({ ...tenant(), appId: 'same' }, { ...row, appId: 'same' })).toBeUndefined();
  expect(independentReach(tenant(), { ...row, visibility: 'PUBLIC' })).toBe('READ_ONLY');
  await db.memory.update({ where: { id: memory }, data: { visibility: 'PUBLIC' } });
  expect(await getOrgReadableMemoryIds(db, consumer, memory)).toContain(memory);
  expect(await link('read')).toBe(false); // helper is only the subscription door; full attach also has PUBLIC.
  expect(cappedLinkLevel(tenant(), await loaded(), 'read-write')).toBe('READ_ONLY');
});
