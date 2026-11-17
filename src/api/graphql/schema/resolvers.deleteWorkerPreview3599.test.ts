/** #3599: preview the real delete's census and act gate, without performing the delete. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const instruction = { kind: 'LIVE_CHAT', ref: 'client-chat:preview3599' };
let f: any;
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const preview = (c = ctx(), workerRef = f.target.id, claim?: unknown) => Q.deleteWorkerPreview({}, { workerRef, instruction: claim }, c);
const remove = (workerRef = f.target.id) => M.deleteWorker({}, { workerRef, confirmNoExternalAttribution: true }, ctx());
async function error(p: Promise<unknown>) {
 try { await p; throw new Error('expected refusal'); } catch (e: any) {
  if (!e.extensions) throw e;
  return { message: e.message, extensions: e.extensions };
 }
}
const fences = () => db.$queryRaw<Array<{subject_id:string;version:bigint}>>`SELECT subject_id,version FROM worker_reference_fences ORDER BY subject_id`;
const events = () => db.agentTeamEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } });
const state = async () => ({
 workers: await db.worker.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}),
 memories: await db.memory.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}),
 sessions: await db.session.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}),
 tickers: await db.ticker.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}),
 nodes: await db.node.findMany({where:{memory:{appId:f.app.id}},orderBy:{id:'asc'}}),
 grants: await db.appGrant.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}),
 members: await db.appMember.findMany({where:{appId:f.app.id},orderBy:{userId:'asc'}}),
 events: await events(), fences: await fences(),
});
beforeEach(async () => {
 await cleanDb(db);
 const holder = await db.user.create({data:{handle:'preview-holder',roles:['READER']}});
 const outsider = await db.user.create({data:{handle:'preview-outsider',roles:['READER']}});
 const org = await db.organization.create({data:{name:'Preview',urn:'preview3599.test'}});
 await db.orgMember.create({data:{organizationId:org.id,userId:holder.id,role:'ADMIN'}});
 const app = await db.app.create({data:{organizationId:org.id,name:'Team',urn:'preview3599.test:team'}});
 f={holder,outsider,org,app};
 const agent = await M.createAgent({}, {orgId:org.id,name:'Role',personaRole:'server-engineer'},ctx());
 await db.appAgent.create({data:{appId:app.id,agentId:agent.id}});
 const caller = await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Caller',slug:'caller',heldByUserId:holder.id}});
 const session = await db.session.create({data:{id:generateId(),appId:app.id,agentId:agent.id,workerId:caller.id,userId:holder.id,tool:'vitest'}});
 await M.createAgentTickerTemplate({}, {agentRef:agent.id,input:{name:'Pristine tick',cadenceSeconds:600}},ctx());
 const target = await M.castWorker({}, {appRef:app.id,agentRef:agent.id,name:'Miscast'},ctx());
 const memory=await db.memory.create({data:{class:'knowledge',appId:app.id,organizationId:org.id,name:'Synthetic working memory',urn:'preview3599.test:miscast-work'}});
 await db.worker.update({where:{id:target.id},data:{memoryId:memory.id}});
 f={...f,agent,caller,session,target,memory};
});
afterEach(() => sessionKeyCache.clear());

describe('#3599 deleteWorkerPreview contract', () => {
 it('returns only workerId and always-required attestation; pristine state and all fences are unchanged', async () => {
  const before=await state();
  expect(before.tickers.length).toBeGreaterThan(0);expect(before.memories.some(m=>m.id===f.memory.id)).toBe(true);
  expect(await preview()).toEqual({workerId:f.target.id,attestationRequired:true});
  expect(await state()).toEqual(before);
 });
 it('instructed preview records one subject-qualified claim and does not poison the later real delete', async () => {
  const before=await events();const fenceBefore=await fences();
  expect(await preview(bound(),f.target.id,instruction)).toEqual({workerId:f.target.id,attestationRequired:true});
  const after=(await events()).filter(e=>!before.some(x=>x.id===e.id));
  const fenceAfter=await fences();
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({type:'worker.instruction-claimed',subjectWorkerId:f.target.id,actorWorkerId:f.caller.id,actorUserId:f.holder.id});
  expect(after[0].payload).toEqual({operation:'worker.delete-preview',workerId:f.target.id,instruction});
  const old=new Map(fenceBefore.map(r=>[r.subject_id,BigInt(r.version)]));
  const changed=fenceAfter.filter(r=>BigInt(r.version)!==old.get(r.subject_id));
  expect(changed.map(r=>r.subject_id).sort()).toEqual([...new Set([f.target.id,f.caller.id])].sort());
  for(const r of changed) expect(BigInt(r.version)).toBe((old.get(r.subject_id)??-1n)+1n);
  // All fence assertions above precede the destructive call.
  expect(await remove()).toBe(true);
  expect(await db.worker.findUnique({where:{id:f.target.id}})).toBeNull();
 });
 it('repeating the same instructed preview adds one claim and one actor/target fence increment per call', async () => {
  const initialEvents = await events();
  let previousFences = new Map((await fences()).map(row => [row.subject_id, BigInt(row.version)]));
  for (let call = 1; call <= 2; call++) {
   expect(await preview(bound(), f.target.id, instruction)).toEqual({workerId:f.target.id,attestationRequired:true});
   const claims = (await events()).filter(row => !initialEvents.some(old => old.id === row.id));
   expect(claims).toHaveLength(call);
   for (const claim of claims) expect(claim).toMatchObject({type:'worker.instruction-claimed',subjectWorkerId:f.target.id,payload:{operation:'worker.delete-preview',workerId:f.target.id,instruction}});
   const currentFences = await fences();
   const changed = currentFences.filter(row => BigInt(row.version) !== previousFences.get(row.subject_id));
   expect(changed.map(row => row.subject_id).sort()).toEqual([f.caller.id,f.target.id].sort());
   for (const row of changed) expect(BigInt(row.version)).toBe((previousFences.get(row.subject_id) ?? -1n) + 1n);
   previousFences = new Map(currentFences.map(row => [row.subject_id,BigInt(row.version)]));
  }
  const claimsBeforeDelete = await db.agentTeamEvent.findMany({where:{appId:f.app.id,type:'worker.instruction-claimed'},orderBy:{id:'asc'}});
  expect(await M.deleteWorker({}, {workerRef:f.target.id,confirmNoExternalAttribution:true,instruction}, bound())).toBe(true);
  expect(await db.agentTeamEvent.findMany({where:{id:{in:claimsBeforeDelete.map(row=>row.id)}},orderBy:{id:'asc'}})).toEqual(claimsBeforeDelete);
  const deleted = await db.agentTeamEvent.findMany({where:{appId:f.app.id,type:'worker.deleted'}});
  expect(deleted).toHaveLength(1);
  expect(deleted[0].payload).toMatchObject({instruction});
 });
 it('event actor and subject are retained ids rather than Worker foreign keys', async () => {
  const workerForeignKeys = await db.$queryRaw<Array<{name:string}>>`SELECT con.conname AS name FROM pg_constraint con WHERE con.conrelid='agent_team_events'::regclass AND con.contype='f' AND con.confrelid='workers'::regclass`;
  expect(workerForeignKeys).toEqual([]);
  await preview(bound(),f.target.id,instruction);
  const claims = await db.agentTeamEvent.findMany({where:{appId:f.app.id,type:'worker.instruction-claimed'}});
  expect(claims).toHaveLength(1);
  expect(await remove()).toBe(true);
  expect(await db.agentTeamEvent.findMany({where:{id:claims[0].id}})).toEqual(claims);
 });
 it('real delete commits after the census and before an instructed claim: WORKER_NOT_FOUND, no partial claim', async () => {
  let deleted = false;
  const client = new Proxy(db,{get(object,key){
   if(key==='$transaction') return (callback:any,options:any)=>object.$transaction(tx=>callback(new Proxy(tx,{get(transaction,modelKey){
    if(modelKey==='agentTeamEvent') return new Proxy(transaction.agentTeamEvent,{get(model,method){
     if(method==='create') return async(args:any)=>{
      if(args.data.type==='worker.instruction-claimed') {
       expect(deleted).toBe(false);
       // A separate real resolver transaction commits while the preview transaction is still open.
       expect(await remove()).toBe(true);
       deleted=true;
      }
      return model.create(args);
     };
     const value=(model as any)[method];return typeof value==='function'?value.bind(model):value;
    }});
    const value=(transaction as any)[modelKey];return typeof value==='function'?value.bind(transaction):value;
   }})),options);
   const value=(object as any)[key];return typeof value==='function'?value.bind(object):value;
  }});
  const refusal = await error(preview(bound({db:client}),f.target.id,instruction));
  expect(deleted).toBe(true);
  // #3608: the preview door answers as the delete would. Other writers keep the fence refusal.
  expect(refusal).toEqual({message:'Worker not found.',extensions:{code:'WORKER_NOT_FOUND',workerRef:f.target.id}});
  expect(await db.worker.findUnique({where:{id:f.target.id}})).toBeNull();
  expect(await db.agentTeamEvent.count({where:{appId:f.app.id,type:'worker.instruction-claimed'}})).toBe(0);
  expect(await db.agentTeamEvent.count({where:{appId:f.app.id,type:'worker.deleted'}})).toBe(1);
 });
 it('a granted worker previews without an instruction claim or any durable changes', async () => {
  await M.grantApp({}, {appRef:f.app.id,workerRef:f.caller.id,name:'WORKERS_STAFF'},ctx());
  const before=await state();
  expect(await preview(bound())).toEqual({workerId:f.target.id,attestationRequired:true});
  expect(await state()).toEqual(before);
 });
 for (const principal of ['app-key','impersonation','run','headless','launched','unknown-session'] as const) it(`${principal} is refused like real delete without writes`,async()=>{
  let c:Context;
  if(principal==='app-key') c={db,appId:f.app.id,appKeyId:generateId(),roles:[]} as Context;
  else if(principal==='impersonation') c=ctx({impersonation:{sessionId:generateId(),actorUserId:f.outsider.id,orgId:f.org.id,expiresAt:new Date('2099-01-01')}} as any);
  else if(principal==='run') c=ctx({clientId:'run:preview3599',appId:f.app.id});
  else {
   c=bound();
   if(principal==='launched') await db.session.update({where:{id:f.session.id},data:{launchOperationId:generateId(),launchHostId:generateId(),launchIssuedBy:'manager'}});
   if(principal==='unknown-session') c=bound({sessionId:generateId()});
  }
  const before=await state();
  const got=await error(preview(c,f.target.id,principal==='headless'?undefined:instruction));
  const actual=await error(M.deleteWorker({}, {workerRef:f.target.id,confirmNoExternalAttribution:true,instruction:principal==='headless'?undefined:instruction},c));
  expect(got).toEqual(actual);expect(got.extensions.code).toBe('FORBIDDEN');
  expect(await state()).toEqual(before);
 });
 it('missing and unreadable collapse byte-identically for a caller not entitled to the target', async()=>{
  const c=ctx({userId:f.outsider.id});
  const a=await error(preview(c));
  // Same caller-supplied selector in both states: do not normalize any public field.
  await db.worker.delete({where:{id:f.target.id}});
  const b=await error(preview(c));
  expect(a).toEqual(b);expect(a.extensions.code).toBe('WORKER_NOT_FOUND');
 });
 for(const kind of ['persisted-reference','unreleased-stint','unverifiable-encryption'] as const) it(`same closed WORKER_IN_USE for ${kind}, with no preview writes`,async()=>{
  if(kind==='persisted-reference') await db.node.create({data:{memoryId:f.agent.systemMemoryId,loc:'work',name:'Work',createdByWorkerId:f.target.id}});
  if(kind==='unreleased-stint') await db.session.create({data:{id:generateId(),appId:f.app.id,workerId:f.target.id,userId:f.holder.id}});
  if(kind==='unverifiable-encryption') {
   const data=encryptNodeFieldsWithKey({data:{authorWorkerId:f.target.id}},generateDataKey()).data;
   await db.node.create({data:{memoryId:f.agent.systemMemoryId,loc:'sealed',name:'Sealed',data:data as never}});
  }
  const before=await state();const denied=await error(preview());
  expect(denied).toEqual(await error(remove()));
  expect(denied.extensions).toEqual({code:'WORKER_IN_USE',workerId:f.target.id});
  expect(await state()).toEqual(before);
 });
 it.each([false,true])('does not take the target row lock with instructed=%s',async(instructed)=>{
  let unlock!:()=>void;let locked!:()=>void;
  const ready=new Promise<void>(r=>locked=r);const release=new Promise<void>(r=>unlock=r);
  const holder=db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM workers WHERE id=${f.target.id} FOR UPDATE`;locked();await release;},{timeout:15000});
  await ready;
  try {
   // A READ COMMITTED census can read the committed target while another transaction holds its row.
   const client=new Proxy(db,{get(t,k){
    if(k==='$transaction') return (fn:any,opts:any)=>t.$transaction(async tx=>{
     await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;return fn(tx);
    },opts);
    const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;
   }});
   expect(await preview(instructed?bound({db:client}):ctx({db:client}),f.target.id,instructed?instruction:undefined)).toEqual({workerId:f.target.id,attestationRequired:true});
  } finally {unlock();await holder;}
 },20000);
 it('baseline: the existing real delete admits a pristine worker in an uninstalled App',async()=>{
  await db.app.update({where:{id:f.app.id},data:{uninstalledAt:new Date()}});
  expect(await remove()).toBe(true);
 });
 it('a retained uninstalled App has the same preview admission as its real delete',async()=>{
  await db.app.update({where:{id:f.app.id},data:{uninstalledAt:new Date()}});
  const before=await state();
  expect(await preview()).toEqual({workerId:f.target.id,attestationRequired:true});
  expect(await state()).toEqual(before);
  expect(await remove()).toBe(true);
 });
 it('uses READ COMMITTED, never the real delete SERIALIZABLE transaction',async()=>{
  const seen:string[]=[];
  const client=new Proxy(db,{get(t,k){
   if(k==='$transaction') return (fn:any,opts:any)=>t.$transaction(async tx=>{
    const rows=await tx.$queryRaw<Array<{transaction_isolation:string}>>`SHOW transaction_isolation`;
    seen.push(rows[0].transaction_isolation);return fn(tx);
   },opts);
   const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;
  }});
  expect(await preview(ctx({db:client}))).toEqual({workerId:f.target.id,attestationRequired:true});
  expect(seen).toEqual(['read committed']);
 });
 it('re-reads a target removed after preflight and returns the real delete in-tx miss',async()=>{
  const client=new Proxy(db,{get(t,k){
   if(k==='$transaction') return async(fn:any,opts:any)=>{
    await db.worker.delete({where:{id:f.target.id}});return t.$transaction(fn,opts);
   };
   const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;
  }});
  expect(await error(preview(ctx({db:client})))).toEqual({message:'Worker not found.',extensions:{code:'WORKER_NOT_FOUND',workerRef:f.target.id}});
 });
 it('an uninstalled App in-use target has byte-identical refusal parity',async()=>{
  await db.node.create({data:{memoryId:f.agent.systemMemoryId,loc:'used',name:'Used',createdByWorkerId:f.target.id}});
  await db.app.update({where:{id:f.app.id},data:{uninstalledAt:new Date()}});
  expect(await error(preview())).toEqual(await error(remove()));
 });
 it('a soft-deleted App gives the same concealed miss as real delete',async()=>{
  await db.app.update({where:{id:f.app.id},data:{deletedAt:new Date()}});
  const got=await error(preview());expect(got).toEqual(await error(remove()));
  expect(got.extensions.code).toBe('WORKER_NOT_FOUND');
 });
 it('a platform ADMIN on a soft-deleted organization gets byte-identical real-delete refusal',async()=>{
  await db.user.update({where:{id:f.holder.id},data:{roles:['ADMIN']}});
  await db.organization.update({where:{id:f.org.id},data:{deletedAt:new Date()}});
  const p=await error(preview(ctx({roles:['ADMIN']})));
  expect(p).toEqual(await error(M.deleteWorker({}, {workerRef:f.target.id,confirmNoExternalAttribution:true},ctx({roles:['ADMIN']}))));
  expect(p.extensions.code).toBe('WORKER_NOT_FOUND');
 });
 it('revalidates the caller deleted after initial admission inside the transaction',async()=>{
  const client=new Proxy(db,{get(t,k){
   if(k==='$transaction') return async(fn:any,opts:any)=>{
    await db.user.update({where:{id:f.holder.id},data:{deletedAt:new Date()}});return t.$transaction(fn,opts);
   };
   const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;
  }});
  expect((await error(preview(ctx({db:client})))).extensions.code).toBe('FORBIDDEN');
 });
 it('the deciding admission sees a holder role demoted after first admission and before caller locks',async()=>{
  let demoted=false;
  const client=new Proxy(db,{get(t,k){
   if(k==='$transaction') return (fn:any,opts:any)=>t.$transaction(tx=>fn(new Proxy(tx,{get(a,b){
    if(b==='$executeRaw') return async(...args:any[])=>{
     if(!demoted && String(args[0]).includes('agent-task-matcher:worker')) {
      await db.orgMember.update({where:{organizationId_userId:{organizationId:f.org.id,userId:f.holder.id}},data:{role:'READER'}});demoted=true;
     }
     return (a.$executeRaw as any)(...args);
    };
    const v=(a as any)[b];return typeof v==='function'?v.bind(a):v;
   }})),opts);
   const v=(t as any)[k];return typeof v==='function'?v.bind(t):v;
  }});
  const before=await events();
  expect((await error(preview(bound({db:client}),f.target.id,instruction))).extensions.code).toBe('FORBIDDEN');
  expect(demoted).toBe(true);expect(await events()).toEqual(before);
 });
 it('schema has the Query closed shape with no attestation input; real delete signature unchanged',()=>{
  const schema=buildSchema(typeDefs);const q=schema.getQueryType()!.getFields().deleteWorkerPreview;
  expect(q).toBeDefined();expect(String(q.type)).toBe('DeleteWorkerPreview!');
  expect(q.args.map(a=>[a.name,String(a.type)])).toEqual([['workerRef','ID!'],['instruction','ActInstructionInput']]);
  const fields=(schema.getType('DeleteWorkerPreview') as any).getFields();
  expect(Object.keys(fields)).toEqual(['workerId','attestationRequired']);
  const d=schema.getMutationType()!.getFields().deleteWorker;
  expect(String(d.type)).toBe('Boolean!');
  expect(d.args.map(a=>[a.name,String(a.type)])).toEqual([['workerRef','ID!'],['confirmNoExternalAttribution','Boolean'],['instruction','ActInstructionInput']]);
 });
});
