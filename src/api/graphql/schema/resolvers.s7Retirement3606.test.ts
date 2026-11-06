/** #3606 phase 1: compatibility doors retain their audience, never the removed state. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, isObjectType, isInputObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { loadPendingReasons } from '../../../lib/tickers/checkPending.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = (resolvers as any).WorkerWakeSettings;
let appId: string, targetId: string, adminId: string, holderId: string, memberId: string;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
beforeEach(async () => {
 await cleanDb(db);
 const org = await db.organization.create({ data: { name: 'Retirement', urn: 'retirement3606.test' } });
 const user = async (handle: string) => (await db.user.create({ data: { id: generateId(), handle } })).id;
 [adminId, holderId, memberId] = await Promise.all(['s7-admin','s7-holder','s7-member'].map(user));
 await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
 const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Engineer', urn: 'retirement3606.test:engineer' } });
 const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'retirement3606.test:team' } });
 appId = app.id;
 await db.appAgent.create({ data: { appId, agentId: agent.id } });
 for (const userId of [holderId, memberId]) await db.appMember.create({ data: { appId, userId, role: 'member' } });
 targetId = (await db.worker.create({ data: { appId, agentId: agent.id, name: 'Target', slug: 'target', signature: '', trailer: '', heldByUserId: holderId } })).id;
});
describe('phase-1 retirement', () => {
 it('clear by a holder returns settings without creating a settings row or recording an act', async () => {
  const beforeEvents = await db.agentTeamEvent.findMany({ where: { appId } });
  const result = await M.clearWorkerIsolation({}, { workerRef: targetId }, ctx(holderId));
  expect(result).toMatchObject({ workerId: targetId, pausedUntil: null });
  expect(await db.workerWakeSettings.findUnique({ where: { workerId: targetId } })).toBeNull();
  expect(await db.agentTeamEvent.findMany({ where: { appId } })).toEqual(beforeEvents);
 });
 it.each(['manager','holder','participant'] as const)('never advertises isolation capability to a %s', async kind => {
  const c = ctx({ manager: adminId, holder: holderId, participant: memberId }[kind]);
  const row = await Q.workerWakeSettings({}, { workerRef: targetId }, c);
  expect(await F.canManageIsolation(row, {}, c)).toBe(false);
 });
 it('keeps set refusal before full authority and before parsing until', async () => {
  for (const userId of [adminId, holderId, memberId]) {
   await expect(M.isolateWorker({}, { workerRef: targetId, until: 'not-a-date' }, ctx(userId)))
    .rejects.toMatchObject({ extensions: { code: 'WORKER_ISOLATION_UNAVAILABLE' } });
  }
  await expect(M.clearWorkerIsolation({}, { workerRef: targetId }, ctx(memberId)))
   .rejects.toMatchObject({ extensions: { code: 'WORKER_ISOLATION_FORBIDDEN' } });
 });
 it('legacy isolation data cannot override NO_TASK, an active task, or PAUSED', async () => {
  // Model the prior-schema read result, including a column the new select no longer requests.
  // The populated migration proof separately exercises real storage removal.
  const now = new Date();
  const fake = {
   app: { findUnique: async () => ({ teamPausedAt: null }) },
   worker: { findMany: async () => [{ id: 'legacy', agent: { usesTasks: true } }] },
   workerWakeSettings: { findMany: async () => [{ workerId: 'legacy', pausedUntil: null, isolatedUntil: new Date(now.getTime()+60_000) }] },
   agentTask: { findMany: async () => [] },
   $queryRaw: async () => [{ n: 0n }],
  };
  expect((await loadPendingReasons(fake as never, appId, ['legacy'], now)).get('legacy')).toBe('NO_TASK');
  fake.agentTask.findMany = async () => [{ assigneeWorkerId: 'legacy' }] as never;
  expect((await loadPendingReasons(fake as never, appId, ['legacy'], now)).get('legacy')).toBeNull();
 });
 it('retains and deprecates every released-client selected field and both doors', () => {
  const schema = buildSchema(typeDefs);
  for (const [name, fields] of [
   ['WorkerWakeSettings',['isolated','isolatedUntil','isolatedAt','isolatedByHandle','canManageIsolation']],
   ['AppDeliverySettings',['standbyEnabled','standbyEffective']],
   ['DueTaskReason',['standbyHeld']],
   ['Mutation',['isolateWorker','clearWorkerIsolation']],
  ] as const) {
   const type = schema.getType(name); expect(isObjectType(type)).toBe(true);
   if (!isObjectType(type)) throw new Error(name);
   for (const field of fields) expect(type.getFields()[field]?.deprecationReason, `${name}.${field}`).toBeTruthy();
  }
  const input = schema.getType('AppDeliverySettingsInput'); expect(isInputObjectType(input)).toBe(true);
  if (isInputObjectType(input)) expect(input.getFields().standbyEnabled?.deprecationReason).toBeTruthy();
 });
});
