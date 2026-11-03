/** #3307 / cor:dmo:050:12: instruction carries the holder's right, never more; record in the act transaction. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor, requestActorStorage } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let f: any;
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-17' };
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const answer = async (p: Promise<unknown>) => { try { await p; return { code:'RESOLVED' }; } catch(e: any) { return {code:e.extensions?.code,message:e.message}; } };
const instructionEvents = () => db.agentTeamEvent.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}).then(es=>es.filter(e=>(e.payload as any)?.instruction));
const snapshot = async () => ({ workers:await db.worker.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}), events:await db.agentTeamEvent.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}), tickers:await db.ticker.findMany({where:{appId:f.app.id},orderBy:{id:'asc'}}) });
const calls: Record<string,(instruction?: unknown,c?:Context)=>Promise<any>> = {
 signature: (instruction=live,c=bound()) => M.updateWorker({}, {workerRef:f.target.id,signature:'Signed by {{worker.name}}',instruction},c),
 trailer: (instruction=live,c=bound()) => M.updateWorker({}, {workerRef:f.target.id,trailer:'Worker: {{worker.name}}',instruction},c),
 agent: (instruction=live,c=bound()) => M.changeWorkerAgent({}, {workerRef:f.target.id,agentRef:f.next.id,instruction},c),
};
beforeEach(async()=>{
 await cleanDb(db);
 const holder=await db.user.create({data:{handle:'instruct-holder',roles:['READER']}});
 const other=await db.user.create({data:{handle:'instruct-other',roles:['READER']}});
 const org=await db.organization.create({data:{name:'Instruction',urn:'instruct3307.test'}});
 await db.orgMember.createMany({data:[{organizationId:org.id,userId:holder.id,role:'CONTRIBUTOR'},{organizationId:org.id,userId:other.id,role:'ADMIN'}]});
 const app=await db.app.create({data:{organizationId:org.id,name:'Team',urn:'instruct3307.test:team'}});
 await db.appMember.create({data:{appId:app.id,userId:holder.id,role:'owner'}});
 f={holder,other,org,app};
 const agent=await M.createAgent({}, {orgId:org.id,name:'Current',personaRole:'server-engineer'},ctx({userId:other.id}));
 const next=await M.createAgent({}, {orgId:org.id,name:'Next',personaRole:'qa-engineer'},ctx({userId:other.id}));
 for(const a of [agent,next]) { await db.appAgent.create({data:{appId:app.id,agentId:a.id}}); await serveAgentBootPrompt(db,a.id,'{{worker.name}} {{worker.role}}'); }
 const worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Caller',slug:'caller',heldByUserId:holder.id}});
 const target=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Target',slug:'target'}});
 const session=await db.session.create({data:{id:generateId(),appId:app.id,agentId:agent.id,workerId:worker.id,userId:holder.id,tool:'vitest'}});
 f={...f,agent,next,worker,target,session};
});

describe('#3307 instructed acts',()=>{
 for(const [door,call] of Object.entries(calls)) {
  it(`${door}: owner-role holder's instruction succeeds with exactly one attributed record`,async()=>{
   await call(); const es=await instructionEvents(); expect(es).toHaveLength(1);
   expect(es[0]).toMatchObject({actorUserId:f.holder.id,actorWorkerId:f.worker.id,subjectWorkerId:f.target.id});
   expect((es[0].payload as any).instruction).toEqual(live);
  });
  it(`${door}: org ADMIN holder's instruction succeeds`,async()=>{
   await db.appMember.deleteMany({where:{appId:f.app.id,userId:f.holder.id}});
   await db.orgMember.update({where:{organizationId_userId:{organizationId:f.org.id,userId:f.holder.id}},data:{role:'ADMIN'}});
   await call();expect(await instructionEvents()).toHaveLength(1);
  });
  it(`${door}: direct person succeeds without instruction record`,async()=>{
   await call(null,ctx());expect(await instructionEvents()).toHaveLength(0);
  });
  for(const kind of ['no-instruction','host-launch','unheld','other-holder','plain-member','impersonation','app-key','refused-binding','ambiguous','run'] as const) {
   it(`${door}: ${kind} refuses byte-identically and writes nothing`,async()=>{
    let c=bound();let claim:unknown=live;
    if(kind==='no-instruction')claim=null;
    if(kind==='host-launch')await db.session.update({where:{id:f.session.id},data:{launchOperationId:generateId(),launchHostId:generateId(),launchIssuedBy:'manager'}});
    if(kind==='unheld'||kind==='other-holder')await db.worker.update({where:{id:f.worker.id},data:{heldByUserId:kind==='unheld'?null:f.other.id}});
    if(kind==='plain-member')await db.appMember.update({where:{appId_userId:{appId:f.app.id,userId:f.holder.id}},data:{role:'member'}});
    if(kind==='impersonation')c=bound({impersonation:{sessionId:generateId(),actorUserId:f.other.id,orgId:f.org.id,expiresAt:new Date('2099-01-01')}} as any);
    if(kind==='app-key')c={db,appId:f.app.id,roles:[]} as Context;
    if(kind==='refused-binding')c=bound({sessionBindingRefused:true});
    if(kind==='run')c=bound({clientId:'run:test',appId:f.app.id});
    const before=await snapshot();
    const invoke=()=>call(claim,c);
    const got=await answer(kind==='ambiguous'?requestActorStorage.run({workerId:null,agentId:null,ambiguousSessionIds:['a','b']},invoke):invoke());
    expect(got.code).toBe('FORBIDDEN'); expect(await snapshot()).toEqual(before);
   });
  }
  it(`${door}: overlong opaque live-chat ref refuses before writes`,async()=>{
   const before=await snapshot();expect((await answer(call({kind:'LIVE_CHAT',ref:'x'.repeat(513)}))).code).toBe('FORBIDDEN');expect(await snapshot()).toEqual(before);
  });
  it(`${door}: missing and foreign TASK URNs give one refusal`,async()=>{
   const foreign=await db.app.create({data:{organizationId:f.org.id,name:'Other',urn:'instruct3307.test:other'}});
   await db.agentTask.create({data:{appId:foreign.id,title:'other',ownerUserId:f.other.id}});
   const before=await snapshot();
   const missing=await answer(call({kind:'TASK',ref:'hrn:agenttask:instruct3307.test:team:AT999'}));
   const cross=await answer(call({kind:'TASK',ref:'hrn:agenttask:instruct3307.test:other:AT1'}));
   expect(missing).toEqual(cross);expect(missing.code).toBe('FORBIDDEN');expect(await snapshot()).toEqual(before);
  });
  it(`${door}: readable same-App TASK URN succeeds`,async()=>{
   const task=await db.agentTask.create({data:{appId:f.app.id,title:'instruction',ownerUserId:f.holder.id}});
   const ref=`hrn:agenttask:${f.app.urn}:${task.handle}`;
   await call({kind:'TASK',ref});expect((await instructionEvents())[0].payload).toMatchObject({instruction:{kind:'TASK',ref}});
  });
  it(`${door}: same-App team message URN succeeds`,async()=>{
   const msg=await M.createTeamChatMessage({}, {appRef:f.app.id,body:'fixture instruction'},ctx());
   expect(msg.urn).toMatch(/^hrn:node:/);await call({kind:'TEAM_CHAT_MESSAGE',ref:msg.urn});expect(await instructionEvents()).toHaveLength(1);
  });
 }
 it('a claimed worker actor without a persisted session stays headless',async()=>{
  expect((await answer(runAsActor({workerId:f.worker.id,agentId:f.agent.id},()=>calls.signature(live,ctx())))).code).toBe('FORBIDDEN');
 });
});
