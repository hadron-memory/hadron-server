import { buildSchema } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
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
 await db.node.create({data:{memoryId:agent.systemMemoryId,loc:'roles',name:'Roles',nodeType:'info'}});
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
  for(const kind of ['no-instruction','host-launch','unheld','other-holder','ended-session','retired-worker','plain-member','impersonation','app-key','refused-binding','ambiguous','run'] as const) {
   it(`${door}: ${kind} refuses byte-identically and writes nothing`,async()=>{
    let c=bound();let claim:unknown=live;
    if(kind==='no-instruction')claim=null;
    if(kind==='host-launch')await db.session.update({where:{id:f.session.id},data:{launchOperationId:generateId(),launchHostId:generateId(),launchIssuedBy:'manager'}});
    if(kind==='unheld'||kind==='other-holder')await db.worker.update({where:{id:f.worker.id},data:{heldByUserId:kind==='unheld'?null:f.other.id}});
    if(kind==='ended-session')await db.session.update({where:{id:f.session.id},data:{endedAt:new Date()}});
    if(kind==='retired-worker')await db.worker.update({where:{id:f.worker.id},data:{retiredAt:new Date()}});
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
  it(`${door}: missing, unreadable and foreign messages use the same refusal`,async()=>{
   const mem=await db.memory.create({data:{name:'Private',urn:'instruct3307.test:private',class:'private',visibility:null,userId:f.other.id,organizationId:f.org.id,appId:f.app.id,userMemoryOfAgentId:f.agent.id}});
   const channel=await M.createChannel({}, {input:{memoryRef:mem.id,loc:'chats:private',name:'Private'}},ctx({userId:f.other.id}));
   const secret=await M.createChannelMessage({}, {channelRef:channel.id,body:'private instruction'},ctx({userId:f.other.id}));
   const foreign=await db.app.create({data:{organizationId:f.org.id,name:'Other',urn:'instruct3307.test:other'}});
   await db.appAgent.create({data:{appId:foreign.id,agentId:f.agent.id}});
   await db.appMember.create({data:{appId:foreign.id,userId:f.holder.id,role:'owner'}});
   const visible=await M.createTeamChatMessage({}, {appRef:foreign.id,body:'other App'},ctx());
   const before=await snapshot();
   const absent=await answer(call({kind:'TEAM_CHAT_MESSAGE',ref:'hrn:node:instruct3307.test:private:missing'}));
   expect(await answer(call({kind:'TEAM_CHAT_MESSAGE',ref:secret.urn}))).toEqual(absent);
   expect(await answer(call({kind:'TEAM_CHAT_MESSAGE',ref:visible.urn}))).toEqual(absent);
   expect(absent.code).toBe('FORBIDDEN');expect(await snapshot()).toEqual(before);
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

// Instrument only event attempts, leaving real PostgreSQL writes/rollback in place.
it('#3307 no instruction event is attempted before a casting refusal',async()=>{
 let attempted=0;
 const client=new Proxy(db,{get(target,key){
  if(key==='$transaction')return (callback:any,options:any)=>db.$transaction(async tx=>callback(new Proxy(tx,{get(t,k){
   if(k==='agentTeamEvent')return new Proxy(t.agentTeamEvent,{get(delegate,op){
    if(op==='create')return (...args:any[])=>{attempted++;return (delegate.create as any)(...args);};
    const value=(delegate as any)[op];return typeof value==='function'?value.bind(delegate):value;
   }});
   const value=(t as any)[k];return typeof value==='function'?value.bind(t):value;
  }})),options);
  const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
 }});
 const before=await snapshot();
 expect((await answer(M.changeWorkerAgent({}, {workerRef:f.target.id,agentRef:generateId(),instruction:live},bound({db:client})))).code).toBe('WORKER_AGENT_NOT_INSTALLED');
 expect(attempted).toBe(0);expect(await snapshot()).toEqual(before);
});

/** Real transaction wrapper: an uncommitted hold change must be judged on tx, never pooled db. */
for(const door of ['signature','agent']) it('#3307 '+door+' reads its instruction authority from the transaction',async()=>{
 const client=new Proxy(db,{get(target,key){
  if(key==='$transaction')return (callback:any,options:any)=>db.$transaction(async tx=>{
   await tx.worker.update({where:{id:f.worker.id},data:{heldByUserId:f.other.id}});
   return callback(tx);
  },options);
  const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
 }});
 const before=await snapshot();expect((await answer(calls[door](live,bound({db:client})))).code).toBe('FORBIDDEN');expect(await snapshot()).toEqual(before);
});

for(const door of ['signature','agent']) for(const moving of ['holder','launch']) it('#3307 '+door+' rechecks '+moving+' after the first admission',async()=>{
 let moved=false;
 const client=new Proxy(db,{get(target,key){
  if(key==='$transaction')return (callback:any,options:any)=>db.$transaction(async tx=>callback(new Proxy(tx,{get(t,k){
   if(k===(moving==='holder'?'worker':'session')) {
    const delegate=(t as any)[k];return new Proxy(delegate,{get(d,op){
     if(op==='findUnique')return async(args:any)=>{
      const row=await d.findUnique(args);
      if(!moved && args.where.id===(moving==='holder'?f.worker.id:f.session.id)) {
       moved=true;
       if(moving==='holder')await tx.worker.update({where:{id:f.worker.id},data:{heldByUserId:f.other.id}});
       else await tx.session.update({where:{id:f.session.id},data:{launchOperationId:generateId(),launchHostId:generateId(),launchIssuedBy:'manager'}});
      }
      return row;
     };
     const value=d[op];return typeof value==='function'?value.bind(d):value;
    }});
   }
   const value=(t as any)[k];return typeof value==='function'?value.bind(t):value;
  }})),options);
  const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
 }});
 const before=await snapshot();expect((await answer(calls[door](live,bound({db:client})))).code).toBe('FORBIDDEN');expect(moved).toBe(true);expect(await snapshot()).toEqual(before);
});

it('#3307 SDL accepts one typed instruction per call',async()=>{
 const apollo=new ApolloServer<Context>({typeDefs,resolvers});
 try {
 const result=await apollo.executeOperation({query:'mutation($worker:ID!,$instruction:ActInstructionInput!){updateWorker(workerRef:$worker,signature:"signed",instruction:$instruction){id signature}}',variables:{worker:f.target.id,instruction:live}},{contextValue:bound()});
 expect(result.body.kind).toBe('single');if(result.body.kind!=='single')throw new Error('unexpected response');
 expect(result.body.singleResult.errors).toBeUndefined();expect((result.body.singleResult.data as any).updateWorker.signature).toBe('signed');expect(await instructionEvents()).toHaveLength(1);
 }finally{await apollo.stop();}
});

it('#3307 instruction input exists only on the two widened doors',()=>{
 const fields=buildSchema(typeDefs).getMutationType()!.getFields();
 for(const name of ['updateWorker','changeWorkerAgent'])expect(fields[name].args.map(a=>a.name)).toContain('instruction');
 for(const name of ['createAppKey','regenerateAppKey','grantAppKeyScope','grantApp','setAppMemoryWriteGrant','setAutomationReadGrant','startImpersonation'])expect(fields[name].args.map(a=>a.name)).not.toContain('instruction');
});

it('#3307 a transport-bound actor uses the persisted session and records both principals',async()=>{
 await runAsActor({workerId:f.worker.id,agentId:f.agent.id},()=>calls.signature());
 expect((await instructionEvents())[0]).toMatchObject({actorUserId:f.holder.id,actorWorkerId:f.worker.id,actorAgentId:f.agent.id});
});
it('#3307 a live-chat URL reference is opaque, not a restricted identifier alphabet',async()=>{
 const instruction={kind:'LIVE_CHAT',ref:'https://client.example/chat/17?turn=3%2F4'};
 await calls.signature(instruction);expect((await instructionEvents())[0].payload).toMatchObject({instruction});
});
it('#3307 the instruction ref length boundary is inclusive',async()=>{
 await calls.signature({kind:'LIVE_CHAT',ref:'x'.repeat(512)});expect(await instructionEvents()).toHaveLength(1);
});
it('#3307 a malformed or missing message URN gives the same refusal',async()=>{
 expect(await answer(calls.signature({kind:'TEAM_CHAT_MESSAGE',ref:'hrn:node:bad'}))).toEqual(await answer(calls.signature({kind:'TEAM_CHAT_MESSAGE',ref:'hrn:node:instruct3307.test:absent:missing'})));
});
it('#3307 a refused mixed signature update records no instruction or partial change',async()=>{
 const before=await snapshot();expect((await answer(M.updateWorker({}, {workerRef:f.target.id,signature:'new',trailer:null,instruction:live},bound()))).code).toBe('BAD_USER_INPUT');expect(await snapshot()).toEqual(before);
});

for(const door of ['signature','agent']) it('#3307 '+door+' holds the live manager membership while waiting for its worker row',async()=>{
 let held!:()=>void, release!:()=>void;
 let blockerPid!:number;
 let publishActPid!:(pid:number)=>void;
 const actPidReady=new Promise<number>(resolve=>{publishActPid=resolve;});
 const ready=new Promise<void>(r=>{held=r;}), gate=new Promise<void>(r=>{release=r;});
 const side=db.$transaction(async tx=>{const [{pid}]=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;blockerPid=pid;await tx.$queryRaw`SELECT id FROM workers WHERE id=${f.target.id} FOR UPDATE`;held();await gate;},{timeout:30000});
 await ready;
 const client=new Proxy(db,{get(target,key){
  if(key==='$transaction')return (callback:any,options:any)=>db.$transaction(async tx=>{
   const [{pid}]=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;publishActPid(pid);return callback(tx);
  },options);
  const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
 }});
 const call=answer(calls[door](live,bound({db:client})));
 let outcome:any;
 try {
  const actPid=await Promise.race([actPidReady,call.then(()=>{throw new Error('worker act did not publish its backend PID');})]);
  for(let i=0;;i++) {
   const [{n}]=await db.$queryRaw<Array<{n:number}>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=${actPid} AND wait_event_type='Lock' AND ${blockerPid}=ANY(pg_blocking_pids(pid))`;
   if(n>0)break;if(i>200)throw new Error('worker act never waited');await new Promise(r=>setTimeout(r,25));
  }
  let denied=false;
  try {await db.$transaction(async tx=>{await tx.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");await tx.appMember.delete({where:{appId_userId:{appId:f.app.id,userId:f.holder.id}}});});}
  catch(e){expect(String(e)).toMatch(/lock timeout/);denied=true;}
  expect(denied).toBe(true);
 }finally{release();await side;outcome=await call;}
 expect(outcome.code).toBe('RESOLVED');expect(await instructionEvents()).toHaveLength(1);
});

for (const door of ['signature', 'agent']) it(`#3314 ${door}: a worker held in another App cannot carry its holder's target-App manager right`, async () => {
  const foreign = await db.app.create({ data: { organizationId: f.org.id, name: 'Foreign team', urn: 'instruct3307.test:foreign-team' } });
  await db.appMember.create({ data: { appId: foreign.id, userId: f.holder.id, role: 'owner' } });
  await db.appAgent.create({ data: { appId: foreign.id, agentId: f.agent.id } });
  const worker = await db.worker.create({ data: {
    ...WORKER_SIGNATURE_DEFAULTS, appId: foreign.id, agentId: f.agent.id,
    name: 'Foreign caller', slug: 'foreign-caller', heldByUserId: f.holder.id,
  } });
  const session = await db.session.create({ data: {
    id: generateId(), appId: foreign.id, agentId: f.agent.id, workerId: worker.id, userId: f.holder.id,
  } });
  const before = await snapshot();
  const result = await runAsActor({ workerId: worker.id, agentId: f.agent.id }, () =>
    answer(calls[door](live, ctx({ sessionId: session.id }))));
  expect(result.code).toBe('FORBIDDEN');
  expect(await snapshot()).toEqual(before);
});

it('#3307 task instructions reuse the caller task-read gate even at the right App',async()=>{
 const outsider=await db.user.create({data:{handle:'instruction-outsider',roles:['READER']}});
 const task=await db.agentTask.create({data:{appId:f.app.id,title:'private task',ownerUserId:f.holder.id}});
 const {readActInstruction}=await import('./resolvers.instruction.js');
 const claim={kind:'TASK' as const,ref:`hrn:agenttask:${f.app.urn}:${task.handle}`};
 expect(await readActInstruction(ctx(),f.app.id,claim)).toBe(true);
 expect(await readActInstruction(ctx({userId:outsider.id}),f.app.id,claim)).toBe(false);
});

for(const initial of ['worker','person','agent']) for(const door of ['signature','agent']) it('#3307 '+door+' refuses '+initial+' session principal drift before the final lock',async()=>{
 const replacement=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:f.app.id,agentId:f.agent.id,name:'Replacement',slug:'replacement',heldByUserId:f.holder.id}});
 if(initial==='person')await db.session.update({where:{id:f.session.id},data:{workerId:null}});
 let moved=false;
 const client=new Proxy(db,{get(target,key){
  if(key==='$transaction')return (callback:any,options:any)=>db.$transaction(async tx=>callback(new Proxy(tx,{get(t,k){
   if(k==='session')return new Proxy(t.session,{get(d,op){
    if(op==='findUnique')return async(args:any)=>{
     const prior=await d.findUnique(args);
     if(!moved && args.where.id===f.session.id){moved=true;await tx.session.update({where:{id:f.session.id},data:initial==='agent'?{agentId:f.next.id}:{workerId:replacement.id}});}
     return prior;
    };
    const value=(d as any)[op];return typeof value==='function'?value.bind(d):value;
   }});
   const value=(t as any)[k];return typeof value==='function'?value.bind(t):value;
  }})),options);
  const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
 }});
 const before=await snapshot();
 expect((await answer(calls[door](live,bound({db:client})))).code).toBe('FORBIDDEN');expect(moved).toBe(true);expect(await snapshot()).toEqual(before);
 expect(await db.session.findUniqueOrThrow({where:{id:f.session.id}})).toMatchObject({workerId:initial==='person'?null:f.worker.id,agentId:f.agent.id});
});

it('#3307 refuses an App ownership scope different from its authority anchors',async()=>{
 const nextOrg=await db.organization.create({data:{name:'Other scope',urn:'instruction-scope.test'}});
 await db.appMember.deleteMany({where:{appId:f.app.id,userId:f.holder.id}});
 await db.orgMember.create({data:{organizationId:nextOrg.id,userId:f.holder.id,role:'ADMIN'}});
 const client=new Proxy(db,{get(target,key){
  if(key==='$transaction')return (callback:any,options:any)=>db.$transaction(async tx=>{
   await tx.app.update({where:{id:f.app.id},data:{organizationId:nextOrg.id}});
   return callback(tx);
  },options);
  const value=(target as any)[key];return typeof value==='function'?value.bind(target):value;
 }});
 const before=await snapshot();expect((await answer(calls.signature(live,bound({db:client})))).code).toBe('FORBIDDEN');expect(await snapshot()).toEqual(before);
 expect((await db.app.findUniqueOrThrow({where:{id:f.app.id}})).organizationId).toBe(f.org.id);
});

it('#3307 malformed live-chat references refuse before writing',async()=>{
 const before=await snapshot();
 for(const ref of ['instruction prose', 'bad\u0000ref', 'bad\ud800ref'])expect((await answer(calls.signature({kind:'LIVE_CHAT',ref}))).code).toBe('FORBIDDEN');
 expect(await snapshot()).toEqual(before);
 await calls.signature({kind:'LIVE_CHAT',ref:'client:😀'});expect((await instructionEvents())[0].payload).toMatchObject({instruction:{kind:'LIVE_CHAT',ref:'client:😀'}});
});

describe('#3314 BLIND P2: person controls and instruction-claim limits', () => {
  for (const [door, call] of Object.entries(calls)) {
    it(`${door}: a worker may instruct an act on itself without duplicating locks or records`, async () => {
      f.target = f.worker;
      await runAsActor({ workerId: f.worker.id, agentId: f.agent.id }, () => call(live, bound()));
      const events = await instructionEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorWorkerId: f.worker.id, subjectWorkerId: f.worker.id });
    });
    for (const claim of [null, live]) {
      it(`${door}: a normal person session succeeds without an instruction record (${claim ? 'valid claim' : 'no claim'})`, async () => {
        const session = await db.session.create({ data: { id: generateId(), userId: f.holder.id } });
        await call(claim, ctx({ sessionId: session.id }));
        expect(await instructionEvents()).toHaveLength(0);
      });
    }

    for (const state of ['missing', 'ended', 'foreign-user'] as const) {
      it(`${door}: a person's ${state} session refuses before any act write`, async () => {
        const sessionId = generateId();
        if (state !== 'missing') {
          await db.session.create({ data: {
            id: sessionId,
            userId: state === 'foreign-user' ? f.other.id : f.holder.id,
            ...(state === 'ended' ? { endedAt: new Date() } : {}),
          } });
        }
        const before = await snapshot();
        const baseline = await answer(call(null, bound()));
        const actual = await answer(call(null, ctx({ sessionId })));
        expect(actual).toEqual(baseline);
        expect(actual.code).toBe('FORBIDDEN');
        expect(await snapshot()).toEqual(before);
      });
    }

    for (const kind of ['LIVE_CHAT', 'TASK', 'TEAM_CHAT_MESSAGE'] as const) {
      it(`${door}: a person's invalid ${kind} claim refuses before any act write`, async () => {
        const claim = { kind, ref: kind === 'LIVE_CHAT' ? 'not an opaque reference' : 'not-a-urn' };
        const before = await snapshot();
        const baseline = await answer(call(null, bound()));
        const actual = await answer(call(claim, ctx()));
        expect(actual).toEqual(baseline);
        expect(actual.code).toBe('FORBIDDEN');
        expect(await snapshot()).toEqual(before);
      });

      it(`${door}: a held worker may self-cite a ${kind} claim and the record preserves its provenance`, async () => {
        const actor = { workerId: f.worker.id, agentId: f.agent.id };
        let ref: string;
        if (kind === 'LIVE_CHAT') {
          ref = `client-chat:${f.worker.id}:turn-1`;
        } else if (kind === 'TASK') {
          const task = await runAsActor(actor, () => M.createAgentTask({}, {
            input: { appRef: f.app.id, title: 'worker-authored instruction claim' },
          }, bound()));
          expect(task.createdByWorkerId).toBe(f.worker.id);
          ref = `hrn:agenttask:${f.app.urn}:${task.handle}`;
        } else {
          const message = await runAsActor(actor, () => M.createTeamChatMessage({}, {
            appRef: f.app.id, body: 'worker-authored instruction claim', sessionRef: f.session.id,
          }, bound()));
          const stored = await db.node.findUniqueOrThrow({ where: { id: message.nodeId } });
          expect(message.authorWorkerId).toBe(f.worker.id);
          expect(stored.data).toMatchObject({ authorWorkerId: f.worker.id });
          ref = message.urn;
        }
        const claim = { kind, ref };
        await runAsActor(actor, () => call(claim, bound()));
        const events = await instructionEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ actorUserId: f.holder.id, actorWorkerId: f.worker.id });
        expect(events[0].payload).toMatchObject({ instruction: claim });
      });
    }
  }

  it('a host-launched session cannot become a person session and is refused with a claim', async () => {
    await db.session.update({ where: { id: f.session.id }, data: {
      launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'manager',
    } });
    // cor:agt:070:08: only a worker session can carry a launch marker. The person-shaped case is not a legal row.
    await expect(db.session.update({ where: { id: f.session.id }, data: { workerId: null } }))
      .rejects.toThrow(/chk_sessions_launch/);
    const before = await snapshot();
    for (const call of Object.values(calls)) {
      expect((await answer(call(live, bound()))).code).toBe('FORBIDDEN');
    }
    expect(await snapshot()).toEqual(before);
  });

  it('the LIVE_CHAT cap counts UTF-16 units and preserves valid emoji in the record', async () => {
    const ref = '😀'.repeat(256);
    await calls.signature({ kind: 'LIVE_CHAT', ref });
    expect((await instructionEvents())[0].payload).toMatchObject({ instruction: { kind: 'LIVE_CHAT', ref } });
    const before = await snapshot();
    expect((await answer(calls.signature({ kind: 'LIVE_CHAT', ref: `${ref}😀` }))).code).toBe('FORBIDDEN');
    expect(await snapshot()).toEqual(before);
  });
});
