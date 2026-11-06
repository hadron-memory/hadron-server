import { beforeEach, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

beforeEach(async () => { await cleanDb(db); });
it('admits the report with the shared memory-record gate and conceals a forged unreadable parent', async () => {
  const { org, graph } = await createDbOrgAndGraph(db);
  const owner = await db.user.create({ data: { handle: 'report-owner', roles: ['READER'] } });
  const stranger = await db.user.create({ data: { handle: 'report-stranger', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  const report = JSON.stringify({ version: 1, outcome: 'partial', recordedAt: '2026-10-24T00:00:00.000Z', entries: [{ kind: 'protected', loc: 'private-file', code: 'PROTECTED_LOC' }] });
  await db.memory.update({ where: { id: graph.id }, data: { lastSyncReport: report } });
  const field = resolvers.Memory.lastSyncReport;
  const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
  expect(await field({ id: graph.id }, {}, ctx(owner.id))).toBe(report);
  expect(await field({ id: graph.id, lastSyncReport: report } as { id: string }, {}, ctx(stranger.id))).toBeNull();
  await db.memory.update({ where: { id: graph.id }, data: { deletedAt: new Date() } });
  expect(await field({ id: graph.id }, {}, ctx(owner.id))).toBeNull();
});
