/** #3204: raw mint stamps use UTC-naive timestamps under every connection zone. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/mirrorNodeMove.js', () => ({ mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined) }));

const clients = new Map<string, PrismaClient>();
let adminId: string;
let memoryId: string;
const as = (client: Context['db'] = db): Context => ({ db: client, userId: adminId, roles: [] });
function inZone(zone: string) {
  let client = clients.get(zone);
  if (!client) {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', `-c TimeZone=${zone}`);
    client = new PrismaClient({ datasourceUrl: url.toString() });
    clients.set(zone, client);
  }
  return as(client as Context['db']);
}
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Mint stamp', urn: `stamp-${generateId()}` } });
  adminId = (await db.user.create({ data: { handle: `stamp-${generateId()}`, roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { organizationId: org.id, name: 'stamps', urn: `${org.urn}:stamps`, class: 'knowledge' } })).id;
});
afterAll(async () => { await Promise.all([...clients.values()].map(client => client.$disconnect())); });

for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
  describe(`mint stamp under ${zone}`, () => {
    it('first mint stores a UTC instant inside the call interval, with the current minter and revision', async () => {
      const node = await db.node.create({ data: { memoryId, loc: 'pas:010', name: 'Stamp', content: 'Stamp body.', nodeType: 'info', role: 'spec', tags: ['spec'] } });
      await resolvers.Mutation.approveMemoryNodes(null, { memoryRef: memoryId }, as());
      const ctx = inZone(zone);
      const [setting] = await ctx.db.$queryRaw<Array<{ zone: string }>>`SELECT current_setting('TimeZone') AS zone`;
      expect(setting!.zone).toBe(zone);
      const before = Date.now();
      const result = await resolvers.Mutation.mintMemoryNodes(null, { memoryRef: memoryId }, ctx);
      const after = Date.now();
      expect(result).toMatchObject({ minted: true, mintedCount: 1, remintedCount: 0 });
      const row = await db.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(row.mintedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.mintedAt!.getTime()).toBeLessThanOrEqual(after);
      expect(row).toMatchObject({ mintedBy: adminId, mintedByInfo: null, mintedRevNo: row.revSeq, mintedHash: row.approvalHash });
    });

    it('a real re-mint preserves the original instant and legacy minter while certifying its revision', async () => {
      const firstMint = new Date('2026-01-02T03:04:05.678Z');
      const node = await db.node.create({ data: { memoryId, loc: 'pas:010', name: 'Stamp', content: 'Stamp body.', nodeType: 'info', role: 'spec', tags: ['spec'], mintedAt: firstMint, mintedByInfo: 'legacy-minter' } });
      await resolvers.Mutation.approveMemoryNodes(null, { memoryRef: memoryId }, as());
      const result = await resolvers.Mutation.mintMemoryNodes(null, { memoryRef: memoryId }, inZone(zone));
      expect(result).toMatchObject({ minted: true, mintedCount: 1, remintedCount: 1, remintLocs: ['pas:010'] });
      const row = await db.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(row.mintedAt).toEqual(firstMint);
      expect(row).toMatchObject({ mintedBy: null, mintedByInfo: 'legacy-minter', mintedRevNo: row.revSeq, mintedHash: row.approvalHash });
    });
  });
}
