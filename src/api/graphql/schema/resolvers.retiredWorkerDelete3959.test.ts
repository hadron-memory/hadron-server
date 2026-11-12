/**
 * #3959 / cli#1867: current delete-census bookkeeping keeps the retire receipt's
 * `worker rm` escape true. This pins a Tunable in cor:agt:020:02, not new law.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let context: Context;
let appId: string;
let agentId: string;

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: { handle: 'retired-delete-admin' } });
  const org = await db.organization.create({ data: { name: 'Retired delete', urn: 'retired-delete3959.test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  appId = app.id;
  context = { db, userId: user.id, roles: ['READER'] };
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Role', personaRole: 'server-engineer' }, context);
  agentId = agent.id;
  await db.appAgent.create({ data: { appId, agentId } });
});

it('deletes a just-retired, never-bound casting despite its own retirement event and frees its name', async () => {
  const args = { appRef: appId, agentRef: agentId, name: 'Miscast' };
  const worker = await M.castWorker({}, args, context);
  await M.retireWorker({}, { workerRef: worker.id }, context);

  // Prove the exemption is exercised, rather than going green because the act
  // forgot its event or because the fixture removed the history before delete.
  const retired = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
  expect(retired.retiredAt).not.toBeNull();
  expect(await db.session.count({ where: { workerId: worker.id } })).toBe(0);
  const bookkeeping = await db.agentTeamEvent.findMany({ where: { appId, subjectWorkerId: worker.id } });
  expect(bookkeeping.map(event => event.type).sort()).toEqual(['worker.cast', 'worker.retired']);
  const retirement = bookkeeping.find(event => event.type === 'worker.retired')!;
  expect(retirement.payload).toEqual({ workerId: worker.id });
  expect(retirement.actorWorkerId).toBeNull();

  // Removing worker.retired from SELF_BOOKKEEPING_EVENT_TYPES must turn this
  // admitted real delete into WORKER_IN_USE, not merely change a preview label.
  await expect(M.deleteWorker({}, { workerRef: worker.id, confirmNoExternalAttribution: true }, context)).resolves.toBe(true);
  expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
  expect(await db.agentTeamEvent.findUnique({ where: { id: retirement.id } })).toEqual(retirement);
  const replacement = await M.castWorker({}, args, context);
  expect(replacement.id).not.toBe(worker.id);
  expect(replacement.name).toBe('Miscast');
});
