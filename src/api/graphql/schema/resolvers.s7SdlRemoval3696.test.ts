/** #3696: remove retired SDL; remaining gates and retained storage stay intact. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, isObjectType, isInputObjectType, isEnumType, parse, validate } from 'graphql';
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

it('removes every retired field and enum value from the public SDL', () => {
 const schema = buildSchema(typeDefs);
 for (const [name, fields] of [
  ['Mutation', ['isolateWorker', 'clearWorkerIsolation']],
  ['DueTaskReason', ['standbyHeld']],
  ['WorkerWakeSettings', ['canManageIsolation','isolatedUntil','isolatedAt','isolatedByHandle','isolated']],
  ['AppDeliverySettings', ['standbyEnabled','standbyEffective']],
 ] as const) {
  const type=schema.getType(name); expect(isObjectType(type)).toBe(true);
  if(!isObjectType(type)) throw new Error(name);
  for(const field of fields) expect(type.getFields()[field],`${name}.${field}`).toBeUndefined();
 }
 const input=schema.getType('AppDeliverySettingsInput'); expect(isInputObjectType(input)).toBe(true);
 if(isInputObjectType(input)) expect(input.getFields().standbyEnabled).toBeUndefined();
 const reason=schema.getType('WorkerPendingReason'); expect(isEnumType(reason)).toBe(true);
 if(isEnumType(reason)) expect(reason.getValues().map(v=>v.name)).toEqual(['TEAM_PAUSED','STOPPED','PAUSED','NO_TASK']);
 expect(reason?.description).not.toMatch(/ISOLATED|STANDBY/);
});
it('removes retired resolver map entries and starts Apollo with the remaining schema', async () => {
 for(const key of ['isolateWorker','clearWorkerIsolation']) expect(M[key]).toBeUndefined();
 for(const key of ['canManageIsolation','isolatedUntil','isolatedAt','isolatedByHandle','isolated']) expect(F[key]).toBeUndefined();
 const {ApolloServer}=await import('@apollo/server');
 const server=new ApolloServer<Context>({typeDefs,resolvers:resolvers as never});
 try {await server.start();} finally {await server.stop();}
});
it.each([false,true])('raw standbyEnabled=%s is an unknown delivery key before writes', async standbyEnabled => {
 const before={app:await db.app.findUniqueOrThrow({where:{id:appId}}),events:await db.agentTeamEvent.findMany({where:{appId}})};
 await expect(M.setAppDeliverySettings({}, {appRef:appId,input:{standbyEnabled}},ctx(adminId)))
  .rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
 expect({app:await db.app.findUniqueOrThrow({where:{id:appId}}),events:await db.agentTeamEvent.findMany({where:{appId}})}).toEqual(before);
});
it('remaining delivery outputs have exactly the surviving settings', async () => {
 const {loadDeliverySettings}=await import('../../../lib/tickers/deliverySettings.js');
 const keys=['batchWindowSeconds','busyDelaySeconds','stuckWindowSeconds','checkPeriodSeconds','failedChecksToOverdue','darkAlarmWindowSeconds'].sort();
 expect(Object.keys(await loadDeliverySettings(db,appId)).sort()).toEqual(keys);
 expect(Object.keys(await Q.appDeliverySettings({}, {appRef:appId},ctx(adminId))).sort()).toEqual(keys);
});
it.each(['cli-wake','cli-delivery','portal-delivery'])('old compatibility document %s now fails validation', async name => {
 const {readFileSync}=await import('node:fs');
 const doc=readFileSync(new URL(`../../../test/fixtures/s7-sdl-removal3696/negative/${name}.graphql`,import.meta.url),'utf8');
 const errors=validate(buildSchema(typeDefs),parse(doc));
 expect(errors.length).toBeGreaterThan(0);
 expect(errors.some(e=>/isolat|standby|canManageIsolation/i.test(e.message))).toBe(true);
});
