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
  // #3701 dropped the isolation columns; the stored-row proof below covers the surviving fields.
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
  fake.workerWakeSettings.findMany = async () => [{ workerId: 'legacy', pausedUntil: new Date(now.getTime()+60_000), isolatedUntil: new Date(now.getTime()+120_000) }] as never;
  expect((await loadPendingReasons(fake as never, appId, ['legacy'], now)).get('legacy')).toBe('PAUSED');
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

it('keeps stored rows unchanged through deprecated doors and actual wake and delivery writes (#3695: the columns are gone)', async () => {
 await db.workerWakeSettings.create({data:{workerId:targetId,mentions:'OFF',pausedUntil:new Date('2099-01-01'),exemptEndedAt:new Date('2020-01-01')}});
 await db.app.update({where:{id:appId},data:{deliveryBusyDelaySeconds:600,deliveryStuckWindowSeconds:1800,deliveryCheckPeriodSeconds:90,deliveryDarkAlarmWindowSeconds:3600}});
 const snapshot=async()=>({
  settings:await db.$queryRawUnsafe('SELECT to_jsonb(w) AS row FROM worker_wake_settings w ORDER BY worker_id'),
  apps:await db.$queryRawUnsafe('SELECT to_jsonb(a) AS row FROM apps a ORDER BY id'),
  events:await db.agentTeamEvent.findMany({where:{appId},orderBy:{id:'asc'}}),
 });
 const before=await snapshot();
 for(const input of [{standbyEnabled:false},{}]) {
  expect(await M.setAppDeliverySettings({}, {appRef:appId,input},ctx(adminId))).toMatchObject({standbyEnabled:false,standbyEffective:false});
  expect(await snapshot()).toEqual(before);
 }
 await expect(M.isolateWorker({}, {workerRef:targetId,until:'not-a-date'},ctx(holderId)))
  .rejects.toMatchObject({extensions:{code:'WORKER_ISOLATION_UNAVAILABLE'}});
 expect(await snapshot()).toEqual(before);
 for(const userId of [holderId,adminId]) {
  const result=await M.clearWorkerIsolation({}, {workerRef:targetId},ctx(userId));
  expect(await F.isolated(result,{},ctx(userId))).toBe(false);
  expect(await F.isolatedUntil(result,{},ctx(userId))).toBeNull();
  expect(await F.isolatedAt(result,{},ctx(userId))).toBeNull();
  expect(await F.isolatedByHandle(result,{},ctx(userId))).toBeNull();
  expect(await snapshot()).toEqual(before);
 }
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

it.each(['cli-wake','cli-delivery','portal-delivery'])('validates frozen released-client selections: %s', async name => {
 const { readFileSync } = await import('node:fs');
 const { parse, validate } = await import('graphql');
 const document = readFileSync(new URL(`../../../test/fixtures/s7-retirement3606/${name}.graphql`,import.meta.url),'utf8');
 expect(validate(buildSchema(typeDefs),parse(document)).map(e=>e.message)).toEqual([]);
});

const principalCodes = [
 ['manager','WORKER_ISOLATION_UNAVAILABLE',null],
 ['holder','WORKER_ISOLATION_UNAVAILABLE',null],
 ['participant','WORKER_ISOLATION_UNAVAILABLE','WORKER_ISOLATION_FORBIDDEN'],
 ['worker-no-instruction','WORKER_ISOLATION_FORBIDDEN','WORKER_ISOLATION_FORBIDDEN'],
 ['worker-missing','WORKER_NOT_FOUND','WORKER_NOT_FOUND'],
 ['worker-foreign','WORKER_NOT_FOUND','WORKER_NOT_FOUND'],
 ['instructed-manager','WORKER_ISOLATION_UNAVAILABLE',null],
 ['instructed-holder','WORKER_ISOLATION_UNAVAILABLE',null],
 ['instructed-neither','WORKER_ISOLATION_UNAVAILABLE','WORKER_ISOLATION_FORBIDDEN'],
 ['app-key','WORKER_NOT_FOUND','WORKER_NOT_FOUND'],
 ['impersonation','WORKER_ISOLATION_UNAVAILABLE','FORBIDDEN'],
 ['refused-binding','WORKER_NOT_FOUND','WORKER_NOT_FOUND'],
 ['missing','WORKER_NOT_FOUND','WORKER_NOT_FOUND'],
 ['retired-target','WORKER_ISOLATION_UNAVAILABLE','WORKER_NOT_FOUND'],
 ['unauthenticated','WORKER_NOT_FOUND','WORKER_NOT_FOUND'],
 ['deleted-app','WORKER_NOT_FOUND','WORKER_NOT_FOUND'],
 ['uninstalled-app','WORKER_ISOLATION_UNAVAILABLE','APP_UNINSTALLED'],
] as const;
it.each(principalCodes)('source-exact deprecated doors for %s (main 8652fe90)', async (kind,setCode,clearCode) => {
 const worker = await db.worker.findUniqueOrThrow({ where: { id: targetId } });
 let c = ctx(kind==='manager'?adminId:kind==='participant'||kind==='instructed-neither'?memberId:holderId);
 let ref = targetId; let instruction: unknown;
 let caller: {id:string}|undefined;
 if (kind.startsWith('instructed')||kind.startsWith('worker-')||kind==='refused-binding') {
  const userId = kind==='instructed-manager'?adminId:kind==='instructed-holder'?holderId:memberId;
  caller = await db.worker.create({data:{appId,agentId:worker.agentId,name:'Caller',slug:'caller',signature:'',trailer:'',heldByUserId:userId}});
  const session = await db.session.create({data:{id:generateId(),appId,workerId:caller.id,agentId:worker.agentId,userId}});
  c = ctx(userId,{sessionId:session.id});
  if(kind.startsWith('instructed')) instruction={kind:'LIVE_CHAT',ref:'synthetic:retirement3606'};
 }
 if(kind==='app-key') c=ctx(undefined,{appId} as never);
 if(kind==='unauthenticated') c=ctx();
 if(kind==='impersonation') c=ctx(adminId,{impersonation:{sessionId:generateId(),actorUserId:memberId,orgId:(await db.app.findUniqueOrThrow({where:{id:appId}})).organizationId,expiresAt:new Date(Date.now()+60_000)}} as never);
 if(kind==='refused-binding') { await db.worker.update({where:{id:caller!.id},data:{retiredAt:new Date()}}); c={...c,sessionBindingRefused:true}; }
 if(kind==='missing'||kind==='worker-missing') ref=generateId();
 if(kind==='worker-foreign') {
  const foreignOrg=await db.organization.create({data:{name:'Foreign',urn:'foreign-retirement3606.test'}});
  const foreignApp=await db.app.create({data:{organizationId:foreignOrg.id,name:'Foreign',urn:'foreign-retirement3606.test:app'}});
  ref=(await db.worker.create({data:{appId:foreignApp.id,agentId:worker.agentId,name:'Foreign',slug:'foreign',signature:'',trailer:''}})).id;
 }
 if(kind==='retired-target') await db.worker.update({where:{id:targetId},data:{retiredAt:new Date()}});
 if(kind==='deleted-app') await db.app.update({where:{id:appId},data:{deletedAt:new Date()}});
 if(kind==='uninstalled-app') await db.app.update({where:{id:appId},data:{uninstalledAt:new Date()}});
 const before={settings:await db.workerWakeSettings.findMany(),events:await db.agentTeamEvent.findMany({where:{appId}})};
 const run = async (clear:boolean) => {
  const call=()=>clear?M.clearWorkerIsolation({}, {workerRef:ref,instruction},c):M.isolateWorker({}, {workerRef:ref,until:'not-a-date',instruction},c);
  if(caller){const{runAsActor}=await import('../../../lib/requestActor.js');return runAsActor({workerId:caller.id,agentId:worker.agentId},call);}
  return call();
 };
 await expect(run(false)).rejects.toMatchObject({extensions:{code:setCode}});
 if(clearCode) await expect(run(true)).rejects.toMatchObject({extensions:{code:clearCode}});
 else expect(await run(true)).toMatchObject({workerId:targetId,pausedUntil:null});
 expect({settings:await db.workerWakeSettings.findMany(),events:await db.agentTeamEvent.findMany({where:{appId}})}).toEqual(before);
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

it('standby false or omission is an authorized no-op; true refuses before every write', async () => {
 const before = await db.app.findUniqueOrThrow({where:{id:appId}});
 const events = await db.agentTeamEvent.findMany({where:{appId}});
 for (const input of [{standbyEnabled:false},{}]) {
  const output=await M.setAppDeliverySettings({}, {appRef:appId,input},ctx(adminId));
  expect(output).toMatchObject({standbyEnabled:false,standbyEffective:false});
  expect(await db.app.findUniqueOrThrow({where:{id:appId}})).toEqual(before);
 }
 await expect(M.setAppDeliverySettings({}, {appRef:appId,input:{standbyEnabled:true}},ctx(adminId)))
  .rejects.toMatchObject({extensions:{code:'DELIVERY_STANDBY_UNAVAILABLE'}});
 expect(await db.app.findUniqueOrThrow({where:{id:appId}})).toEqual(before);
 expect(await db.agentTeamEvent.findMany({where:{appId}})).toEqual(events);
});

it('executes released CLI get/pause/clear-pause and portal get/set documents with compatibility constants', async () => {
 const {ApolloServer}=await import('@apollo/server');const{readFileSync}=await import('node:fs');
 const server=new ApolloServer<Context>({typeDefs,resolvers:resolvers as never});await server.start();
 const execute=async(name:string,file:string,variables:Record<string,unknown>,c:Context)=>{
  const query=readFileSync(new URL(`../../../test/fixtures/s7-retirement3606/${file}.graphql`,import.meta.url),'utf8');
  const result=await server.executeOperation({query,operationName:name,variables},{contextValue:c});
  expect(result.body.kind).toBe('single');if(result.body.kind!=='single')throw new Error('single result required');
  expect(result.body.singleResult.errors).toBeUndefined();return result.body.singleResult.data as any;
 };
 const wakeConstants={isolated:false,isolatedAt:null,isolatedUntil:null,isolatedByHandle:null,canManageIsolation:false};
 try {
  expect((await execute('WorkerWakeSettings','cli-wake',{workerRef:targetId},ctx(holderId))).workerWakeSettings).toMatchObject(wakeConstants);
  const until=new Date(Date.now()+60_000).toISOString();
  expect((await execute('SetWorkerWakeSettings','cli-wake',{workerRef:targetId,input:{pausedUntil:until}},ctx(holderId))).setWorkerWakeSettings).toMatchObject({...wakeConstants,pausedUntil:until});
  expect((await execute('SetWorkerWakeSettings','cli-wake',{workerRef:targetId,input:{clearPause:true}},ctx(holderId))).setWorkerWakeSettings).toMatchObject({...wakeConstants,pausedUntil:null});
  expect((await execute('ClearWorkerIsolation','cli-wake',{workerRef:targetId},ctx(holderId))).clearWorkerIsolation).toMatchObject(wakeConstants);
  for(const[name,file,variables,key]of[
   ['TeamDeliverySettings','cli-delivery',{appRef:appId},'appDeliverySettings'],
   ['TeamDeliverySettingsSet','cli-delivery',{appRef:appId,input:{standbyEnabled:false}},'setAppDeliverySettings'],
   ['AppDeliverySettings','portal-delivery',{appRef:appId},'appDeliverySettings'],
   ['SetAppDeliverySettings','portal-delivery',{appRef:appId,input:{busyDelaySeconds:500}},'setAppDeliverySettings'],
  ] as const)expect((await execute(name,file,variables,ctx(adminId)))[key]).toMatchObject({standbyEnabled:false,standbyEffective:false});
 } finally {await server.stop();}
});
