/** #4181: an org-scoped memories page must not union in other orgs' install records. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
let userId: string;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { handle: 'reader4181' } })).id;
  orgA = (await db.organization.create({ data: { name: 'A', urn: 'scope-a4181.test' } })).id;
  orgB = (await db.organization.create({ data: { name: 'B', urn: 'scope-b4181.test' } })).id;
  await db.orgMember.create({ data: { userId, organizationId: orgA, role: 'READER' } });
});

/** Real install-memory rows, with an App that determines the record's org scope. */
async function install(organizationId: string | null, ownerUserId: string | null = null) {
  const id = generateId();
  const agent = await db.agent.create({ data: { name: 'Agent', urn: `scope4181:${id}`, organizationId, ownerUserId } });
  const app = await db.app.create({ data: { name: 'App', urn: `scope4181:app-${id}`, organizationId, ownerUserId } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const memory = await db.memory.create({ data: { class: 'system', isInstallMemory: true,
    appId: app.id, installOfAgentId: agent.id, organizationId, ownerUserId, name: 'Install', urn: `scope4181:install-${id}` } });
  return { app, memory };
}

async function page(roles: string[] = ['READER'], orgId: string | null = orgA, classes = ['system']) {
  const ctx = { db, userId, roles } as Context;
  return Q.memories({}, { orgId, filter: { memoryClasses: classes }, limit: 100 }, ctx);
}
const ids = (result: { items: { id: string }[] }) => result.items.map((m) => m.id);

describe('#4181 scoped install-memory union', () => {
  it.each(['org-admin', 'app-owner', 'platform-admin'] as const)('keeps B out of A for %s, without making the test unreadable', async (who) => {
    const { app, memory } = await install(orgB);
    if (who === 'org-admin') await db.orgMember.create({ data: { userId, organizationId: orgB, role: 'ADMIN' } });
    if (who === 'app-owner') await db.appMember.create({ data: { appId: app.id, userId, role: 'owner' } });
    const roles = who === 'platform-admin' ? ['ADMIN'] : ['READER'];
    // Positive control: the caller really reaches B through today's install audience.
    expect(ids(await page(roles, null)), 'unscoped reach control').toContain(memory.id);
    const scoped = await page(roles);
    expect(ids(scoped), 'org A page must exclude org B install memory').not.toContain(memory.id);
    expect(scoped.total, 'foreign installs must not inflate the scoped total').toBe(0);
  });

  it('still lists an A install to its audience, but not an ordinary org reader', async () => {
    const { app, memory } = await install(orgA);
    expect(ids(await page())).not.toContain(memory.id);
    await db.appMember.create({ data: { appId: app.id, userId, role: 'member' } });
    expect(ids(await page())).toContain(memory.id);
  });

  it('retains the caller-owned App install in every valid org context', async () => {
    await db.orgMember.create({ data: { userId, organizationId: orgB, role: 'READER' } });
    const { memory } = await install(null, userId);
    expect(ids(await page())).toContain(memory.id);
    expect(ids(await page(['READER'], orgB))).toContain(memory.id);
  });

  it('does not pull another person-owned App install into A through App membership', async () => {
    const other = await db.user.create({ data: { handle: 'other4181' } });
    const { app, memory } = await install(null, other.id);
    await db.appMember.create({ data: { appId: app.id, userId, role: 'owner' } });
    expect(ids(await page(['READER'], null))).toContain(memory.id);
    expect(ids(await page())).not.toContain(memory.id);
  });

  it('keeps own user-owned rows and A subscriptions, without B-only subscriptions', async () => {
    await db.orgMember.create({ data: { userId, organizationId: orgB, role: 'READER' } });
    const own = await db.memory.create({ data: { class: 'knowledge', ownerUserId: userId, name: 'Own', urn: 'scope4181:own' } });
    const external = await db.organization.create({ data: { name: 'Publisher', urn: 'publisher4181.test' } });
    const subscribed = async (to: string, tag: string) => {
      const m = await db.memory.create({ data: { class: 'knowledge', organizationId: external.id, visibility: 'PUBLIC', name: tag, urn: `publisher4181.test:${tag}` } });
      await db.memorySubscription.create({ data: { memoryId: m.id, organizationId: to, createdBy: userId, activated: true } });
      return m;
    };
    const a = await subscribed(orgA, 'a');
    const b = await subscribed(orgB, 'b');
    const out = ids(await page(['READER'], orgA, ['knowledge']));
    expect(out).toContain(own.id);
    expect(out).toContain(a.id);
    expect(out).not.toContain(b.id);
    expect(ids(await page(['READER'], orgB, ['knowledge']))).toContain(own.id);
  });
});
