/** #3197: exercise the real merge on connections with their own zone, never changing the shared database zone. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { PrismaClient } from '../../generated/prisma/index.js';
import { cleanDb } from '../../test/helpers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { generateId } from '../../lib/id.js';

const clients: PrismaClient[] = [];
beforeEach(async () => { await cleanDb(db); });
afterAll(async () => { await Promise.all(clients.map(c => c.$disconnect())); });

describe.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])('#3197 merge audit stamps in %s', zone => {
  it('writes UTC at all seven naive-column statements while retaining subscription instants', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', `-c TimeZone=${zone}`);
    const client = new PrismaClient({ datasourceUrl: url.toString() });
    clients.push(client);
    expect((await client.$queryRawUnsafe<Array<{ zone: string }>>('SELECT current_setting(\'TimeZone\') AS zone'))[0].zone).toBe(zone);
    const source = await db.user.create({ data: { handle: 'zone-source' } });
    const target = await db.user.create({ data: { handle: 'zone-target' } });
    const grantor = await db.user.create({ data: { handle: 'zone-grantor' } });
    const org = await db.organization.create({ data: { name: 'Zone', urn: 'zone3197.test' } });
    for (const user of [source, target]) await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'READER' } });
    const group = await db.memory.create({ data: { name: 'group', urn: 'zone3197.test:group', class: 'group', organizationId: org.id } });
    for (const user of [source, target]) await db.memoryMember.create({ data: { memoryId: group.id, userId: user.id, role: 'reader' } });
    const shared = await db.memory.create({ data: { name: 'shared', urn: 'zone3197.test:shared', class: 'knowledge', organizationId: org.id } });
    for (const user of [source, target]) await db.memoryShare.create({ data: { memoryId: shared.id, granteeId: user.id, grantorId: grantor.id, role: 'reader' } });
    const live = await db.memoryConfigTemplate.create({ data: { name: 'live', ownerUserId: source.id } });
    const deleted = await db.memoryConfigTemplate.create({ data: { name: 'deleted', ownerUserId: source.id, deletedAt: new Date() } });
    const signIn = await db.signIn.create({ data: { userId: source.id, method: 'email', expiresAt: new Date(Date.now() + 3600000) } });
    const key = await db.userApiKey.create({ data: { userId: source.id, keyHash: generateId(), keyPreview: 'test', oauthScopes: [], originSignInId: signIn.id } });
    const agent = await db.agent.create({ data: { name: 'Zone', urn: 'zone3197.test:agent', organizationId: org.id } });
    const activatedAt = new Date(Date.now() - 3600000);
    const expiresAt = new Date(Date.now() + 3600000);
    await db.agentSubscription.create({ data: { userId: source.id, agentId: agent.id, activatedAt, expiresAt } });
    await db.agentSubscription.create({ data: { userId: target.id, agentId: agent.id, activatedAt: new Date(Date.now() - 7200000), expiresAt: new Date(Date.now() - 60000) } });
    const before = Date.now();
    await mergeUsers(client, { sourceUserId: source.id, targetUserId: target.id });
    const after = Date.now();
    const stamps = {
      'live template': (await db.memoryConfigTemplate.findUniqueOrThrow({ where: { id: live.id } })).updatedAt,
      'deleted template': (await db.memoryConfigTemplate.findUniqueOrThrow({ where: { id: deleted.id } })).updatedAt,
      'org member': (await db.orgMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: target.id } } })).updatedAt,
      'memory member': (await db.memoryMember.findUniqueOrThrow({ where: { memoryId_userId: { memoryId: group.id, userId: target.id } } })).updatedAt,
      'memory share': (await db.memoryShare.findUniqueOrThrow({ where: { memoryId_granteeId: { memoryId: shared.id, granteeId: target.id } } })).updatedAt,
      'sign in': (await db.signIn.findUniqueOrThrow({ where: { id: signIn.id } })).endedAt,
      'API key': (await db.userApiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt,
    };
    for (const [label, stamp] of Object.entries(stamps)) {
      expect.soft(stamp, label).not.toBeNull();
      expect.soft(stamp?.getTime(), label).toBeGreaterThanOrEqual(before - 1000);
      expect.soft(stamp?.getTime(), label).toBeLessThanOrEqual(after + 1000);
    }
    const subscription = await db.agentSubscription.findUniqueOrThrow({ where: { userId_agentId: { userId: target.id, agentId: agent.id } } });
    expect(subscription.activatedAt).toEqual(activatedAt);
    expect(subscription.expiresAt).toEqual(expiresAt);
    expect(subscription.revokedAt).toBeNull();
    expect(subscription.updatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(subscription.updatedAt!.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(await db.agentSubscription.count({ where: { userId: source.id } })).toBe(0);
  });
});
