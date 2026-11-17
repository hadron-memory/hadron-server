/** #3696: remove retired SDL; remaining gates and retained storage stay intact. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, isObjectType, isInputObjectType, isEnumType, parse, validate } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { loadPendingReasons } from '../../../lib/tickers/checkPending.js';
import { runAsActor } from '../../../lib/requestActor.js';
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

it('preserves TEAM_PAUSED > STOPPED > PAUSED > NO_TASK through pending and roster', async () => {
 await db.session.create({data:{id:generateId(),appId,userId:holderId,workerId:targetId,agentId:(await db.worker.findUniqueOrThrow({where:{id:targetId}})).agentId,startedAt:new Date(),updatedAt:new Date()}});
 const now=new Date();
 const status=async()=>{
  const c=ctx(holderId);const roster=await Q.teamRoster({}, {appRef:appId}, c);
  const entry=roster.workers.find((w:any)=>w.name==='Target');
  return (resolvers as any).TeamRosterEntry.checkStatus(entry,{},c);
 };
 const reason=async()=> (await loadPendingReasons(db,appId,[targetId],now)).get(targetId);
 expect(await reason()).toBe('NO_TASK');expect((await status()).pendingReason).toBe('NO_TASK');
 await db.workerWakeSettings.create({data:{workerId:targetId,pausedUntil:new Date(now.getTime()+60_000)}});
 expect(await reason()).toBe('PAUSED');expect((await status()).pendingReason).toBe('PAUSED');
 await db.teamStopSignal.create({data:{id:generateId(),appId,level:'pause',scope:'worker',targetWorkerId:targetId,setAt:now,setByUserId:adminId}});
 expect(await reason()).toBe('STOPPED');expect((await status()).pendingReason).toBe('STOPPED');
 await db.app.update({where:{id:appId},data:{teamPausedAt:now}});
 expect(await reason()).toBe('TEAM_PAUSED');expect((await status()).pendingReason).toBe('TEAM_PAUSED');
});

it('ignores a legacy isolation clock but retains the clearPause exemption end', async () => {
 const {deriveWorkerCheckStatus}=await import('../../../lib/workerCheckStatus.js');
 const now=new Date('2026-11-06T12:00:00Z');const ago=(min:number)=>new Date(now.getTime()-min*60_000);
 const input={liveSessionStartedAt:ago(120),pendingReason:null,tickerWakes:null,lastAssignedAt:ago(100),lastCheckedAt:ago(80),pausedUntil:null,isolatedUntil:ago(1),exemptEndedAt:ago(10)};
 const result=deriveWorkerCheckStatus(input,{checkPeriodSeconds:600,failedChecksToOverdue:2},now);
 expect(result.resumedAt).toEqual(ago(10));expect(result.status).toBe('OK');
});

it('keeps stored rows unchanged through surviving wake and delivery writes (#3695: the isolation/standby columns are gone)', async () => {
 await db.workerWakeSettings.create({data:{workerId:targetId,mentions:'OFF',pausedUntil:new Date('2099-01-01'),exemptEndedAt:new Date('2020-01-01')}});
 await db.app.update({where:{id:appId},data:{deliveryBusyDelaySeconds:600,deliveryStuckWindowSeconds:1800,deliveryCheckPeriodSeconds:90,deliveryDarkAlarmWindowSeconds:3600}});
 const snapshot=async()=>({
  settings:await db.$queryRawUnsafe('SELECT to_jsonb(w) AS row FROM worker_wake_settings w ORDER BY worker_id'),
  apps:await db.$queryRawUnsafe('SELECT to_jsonb(a) AS row FROM apps a ORDER BY id'),
  events:await db.agentTeamEvent.findMany({where:{appId},orderBy:{id:'asc'}}),
 });
 const before=await snapshot();
 await M.setAppDeliverySettings({}, {appRef:appId,input:{}},ctx(adminId));
 expect(await snapshot()).toEqual(before);
 expect((await loadPendingReasons(db,appId,[targetId],new Date())).get(targetId)).toBe('PAUSED');
 await M.setWorkerWakeSettings({}, {workerRef:targetId,input:{mentions:'IMMEDIATE'}},ctx(holderId));
 expect((await db.workerWakeSettings.findUniqueOrThrow({where:{workerId:targetId}})).mentions).toBe('IMMEDIATE');
 const pausedUntil=new Date('2098-01-01');
 await M.setWorkerWakeSettings({}, {workerRef:targetId,input:{pausedUntil}},ctx(holderId));
 expect((await db.workerWakeSettings.findUniqueOrThrow({where:{workerId:targetId}})).pausedUntil).toEqual(pausedUntil);
 const clearStart=Date.now();
 await M.setWorkerWakeSettings({}, {workerRef:targetId,input:{clearPause:true}},ctx(holderId));
 const clearEnd=Date.now();
 const cleared=await db.workerWakeSettings.findUniqueOrThrow({where:{workerId:targetId}});
 expect(cleared.pausedUntil).toBeNull();
 expect(cleared.exemptEndedAt!.getTime()).toBeGreaterThanOrEqual(clearStart);
 expect(cleared.exemptEndedAt!.getTime()).toBeLessThanOrEqual(clearEnd);
 const changed=await M.setAppDeliverySettings({}, {appRef:appId,input:{busyDelaySeconds:601}},ctx(adminId));
 expect(changed).toMatchObject({busyDelaySeconds:601,stuckWindowSeconds:1800,checkPeriodSeconds:90,darkAlarmWindowSeconds:3600});
 expect((await db.app.findUniqueOrThrow({where:{id:appId}})).deliveryBusyDelaySeconds).toBe(601);
 expect((await loadPendingReasons(db,appId,[targetId],new Date())).get(targetId)).toBe('NO_TASK');
});

it('executes surviving wake get/pause/clearPause and delivery get/set; client provenance C1 remains separate', async () => {
 const {ApolloServer}=await import('@apollo/server');const{readFileSync}=await import('node:fs');
 const server=new ApolloServer<Context>({typeDefs,resolvers:resolvers as never});await server.start();
 const execute=async(name:string,file:string,variables:Record<string,unknown>,c:Context)=>{
  const query=readFileSync(new URL(`../../../test/fixtures/s7-sdl-removal3696/surviving-surface/${file}.graphql`,import.meta.url),'utf8');
  expect(validate(buildSchema(typeDefs),parse(query))).toEqual([]);
  const result=await server.executeOperation({query,operationName:name,variables},{contextValue:c});
  expect(result.body.kind).toBe('single');if(result.body.kind!=='single')throw new Error('single required');
  expect(result.body.singleResult.errors).toBeUndefined();return result.body.singleResult.data as any;
 };
 try {
  expect((await execute('WorkerWakeSettings','cli-wake',{workerRef:targetId},ctx(holderId))).workerWakeSettings.mentions).toBe('IMMEDIATE');
  const until=new Date(Date.now()+60_000).toISOString();
  expect((await execute('SetWorkerWakeSettings','cli-wake',{workerRef:targetId,input:{pausedUntil:until}},ctx(holderId))).setWorkerWakeSettings.pausedUntil).toBe(until);
  expect((await execute('SetWorkerWakeSettings','cli-wake',{workerRef:targetId,input:{clearPause:true}},ctx(holderId))).setWorkerWakeSettings.pausedUntil).toBeNull();
  for(const[name,file,variables,key]of[
   ['TeamDeliverySettings','cli-delivery',{appRef:appId},'appDeliverySettings'],
   ['TeamDeliverySettingsSet','cli-delivery',{appRef:appId,input:{busyDelaySeconds:500}},'setAppDeliverySettings'],
   ['AppDeliverySettings','portal-delivery',{appRef:appId},'appDeliverySettings'],
   ['SetAppDeliverySettings','portal-delivery',{appRef:appId,input:{busyDelaySeconds:500}},'setAppDeliverySettings'],
  ] as const)expect((await execute(name,file,variables,ctx(adminId)))[key]).not.toHaveProperty('standbyEnabled');
 }finally{await server.stop();}
});

it('legacy isolation cannot override an active task in pending derivation', async () => {
 const now=new Date();
 const fake={
  app:{findUnique:async()=>({teamPausedAt:null})},
  worker:{findMany:async()=>[{id:'legacy',agent:{usesTasks:true}}]},
  workerWakeSettings:{findMany:async()=>[{workerId:'legacy',pausedUntil:null,isolatedUntil:new Date(now.getTime()+60_000)}]},
  agentTask:{findMany:async()=>[{assigneeWorkerId:'legacy'}]},
  $queryRaw:async()=>[{n:0n}],
 };
 expect((await loadPendingReasons(fake as never,appId,['legacy'],now)).get('legacy')).toBeNull();
});

it.each(['wake','delivery','teamPause'] as const)('refuses an impersonated manager on %s before writes', async door => {
 const c=ctx(adminId,{impersonation:{sessionId:generateId(),actorUserId:memberId,orgId:(await db.app.findUniqueOrThrow({where:{id:appId}})).organizationId,expiresAt:new Date(Date.now()+60_000)}} as never);
 const snapshot=async()=>({app:await db.app.findUniqueOrThrow({where:{id:appId}}),wake:await db.workerWakeSettings.findMany(),events:await db.agentTeamEvent.findMany({where:{appId}})});
 const before=await snapshot();
 const call=()=>door==='wake'
  ?M.setWorkerWakeSettings({}, {workerRef:targetId,input:{mentions:'OFF'}},c)
  :door==='delivery'
   ?M.setAppDeliverySettings({}, {appRef:appId,input:{busyDelaySeconds:777}},c)
   :M.setTeamPause({}, {appRef:appId,paused:true},c);
 await expect(call()).rejects.toMatchObject({message:'Impersonation sessions are read-only.',extensions:{code:'FORBIDDEN'}});
 expect(await snapshot()).toEqual(before);
});

// #4020 pins, kept where the doors survive (the standby key and the clear door were retired by #3696, so B4's
// standbyEnabled arm is the BAD_USER_INPUT test above and B5/B2 have no door left). An instructed worker manager's
// no-op records no manager act.
describe('instructed worker manager on the surviving delivery door (#4020)', () => {
 const instruction = { kind: 'LIVE_CHAT', ref: 'synthetic:instructed4020' };
 let callerId: string;
 const asInstructedManager = async <T>(call: (c: Context) => Promise<T>): Promise<T> => {
  const worker = await db.worker.findUniqueOrThrow({ where: { id: targetId } });
  const slug = `caller-${generateId()}`;
  const caller = await db.worker.create({ data: { appId, agentId: worker.agentId, name: slug, slug, signature: '', trailer: '', heldByUserId: adminId } });
  callerId = caller.id;
  const session = await db.session.create({ data: { id: generateId(), appId, workerId: caller.id, agentId: worker.agentId, userId: adminId } });
  return runAsActor({ workerId: caller.id, agentId: worker.agentId }, () => call(ctx(adminId, { sessionId: session.id })));
 };
 const acts = () => db.agentTeamEvent.findMany({ where: { appId, type: 'app.manager-act' } });
 const snapshot = async () => ({
  apps: await db.$queryRawUnsafe('SELECT to_jsonb(a) AS row FROM apps a ORDER BY id'),
  settings: await db.$queryRawUnsafe('SELECT to_jsonb(w) AS row FROM worker_wake_settings w ORDER BY worker_id'),
  target: await db.$queryRawUnsafe(`SELECT to_jsonb(w) AS row FROM workers w WHERE w.id = '${targetId}'`),
  events: await db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } }),
 });
 it('B6 control: an instructed real delivery change updates the App and records one act, attributed to the caller', async () => {
  const actsBefore = (await acts()).length;
  const out = await asInstructedManager(c => M.setAppDeliverySettings({}, { appRef: appId, input: { busyDelaySeconds: 601 }, instruction }, c));
  expect(out).toMatchObject({ busyDelaySeconds: 601 });
  expect((await db.app.findUniqueOrThrow({ where: { id: appId } })).deliveryBusyDelaySeconds).toBe(601);
  const after = await acts();
  expect(after).toHaveLength(actsBefore + 1);
  expect(after[after.length - 1]).toMatchObject({ appId, type: 'app.manager-act', actorWorkerId: callerId, actorUserId: adminId });
 });
 it('B4: an instructed delivery no-op writes nothing and records no act', async () => {
  const before = await snapshot();
  const actsBefore = (await acts()).length;
  await asInstructedManager(c => M.setAppDeliverySettings({}, { appRef: appId, input: {}, instruction }, c));
  const after = await snapshot();
  expect({ ...after, events: after.events.filter(e => before.events.every(b => b.id !== e.id)) }).toEqual({ ...before, events: [] });
  expect(await acts()).toHaveLength(actsBefore);
 });
});
