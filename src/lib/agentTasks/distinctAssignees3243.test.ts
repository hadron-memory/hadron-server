import { lockWorkersForAssignment } from './workerLock.js';
import { matchQueuedTasks } from './matcher.js';
import * as launchModule from '../hostOperations/launch.js';
/** #3243, ruling0084 A: distinct batch matching is all-or-none, named workers count. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';



vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any, Q = resolvers.Query as any;
let app: any, owner: any, agent: any, ctx: any;
beforeEach(async () => {
  await cleanDb(db);
  process.env.DISABLE_TASK_MATCHER = 'true'; // explicit match-now must still run; only automatic triggers are disabled
  const n=generateId();
  owner=await db.user.create({data:{handle:`mn-${n}`}});
  const org=await db.organization.create({data:{name:'Match now',urn:`mn-${n}.example`}});
  await db.orgMember.create({data:{organizationId:org.id,userId:owner.id,role:'ADMIN'}});
  ctx={db,userId:owner.id,roles:['READER']};
  agent=await M.createAgent({}, {orgId:org.id,name:'Team'},ctx);
  app=await db.app.create({data:{organizationId:org.id,name:'Match',urn:`${org.urn}:app`}});
});
afterEach(()=>{delete process.env.DISABLE_TASK_MATCHER;});
async function worker(name='Reviewer', role='reviewer', reportsToWorkerId: string|null=null) {
  const w=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name,slug:name.toLowerCase(),role,reportsToWorkerId}});
  await db.session.create({data:{id:generateId(),appId:app.id,workerId:w.id,agentId:agent.id,role,family:'claude',llmModel:'claude-sonnet-5-5',startedAt:new Date(),updatedAt:new Date()}});
  return w;
}
const create=(input:any={})=>M.createAgentTask({}, {input:{appRef:app.id,title:'Match',...input}},ctx);
const row=(id:string)=>db.agentTask.findUniqueOrThrow({where:{id}});

const item=(task:any={})=>({task:{title:'Seat',source:'https://example.test/seat',...task}});
const batch=(tasks:any[], distinctAssignees?:boolean|null)=>M.createAgentTasks({}, {appRef:app.id,tasks,distinctAssignees},ctx);
const matched=(requirements:any={})=>item({match:true,requirements});
const snapshot=async()=>({tasks:await db.agentTask.findMany({where:{appId:app.id},orderBy:{id:'asc'}}),events:await db.agentTeamEvent.findMany({where:{appId:app.id},orderBy:{id:'asc'}})});
it('distinct option: two eligible workers get different seats, preserving their requirements',async()=>{
 const a=await worker('Alpha'), b=await worker('Beta');
 const tasks=await batch([matched({role:'reviewer'}),matched({roles:['reviewer'],familyIn:['claude']})],true);
 expect(tasks.map((t:any)=>t.assigneeWorkerId)).toEqual([a.id,b.id]);
 expect(tasks[1].requirements).toEqual({roles:['reviewer'],familyIn:['claude']});
 expect(tasks.every((t:any)=>!t.matchPending&&!t.matchFailedAt)).toBe(true);
 expect(await db.agentTeamEvent.count({where:{appId:app.id,type:'assignment.matched'}})).toBe(2);
});
it('one available worker: second match refuses with position and reason, rolls back tasks/events/handles',async()=>{
 await worker(); const before=await snapshot();
 await expect(batch([matched(),matched()],true)).rejects.toMatchObject({extensions:{code:'TASK_MATCH_FAILED',position:2,reason:'NOBODY_FREE'}});
 expect(await snapshot()).toEqual(before);
 expect((await create({assignee:{user:owner.id}})).handle).toBe('AT0.1');
});
it('named assignee later in list is excluded from earlier matches too',async()=>{
 const a=await worker('Alpha'), b=await worker('Beta');
 const tasks=await batch([matched(),item({assignee:{worker:a.id}})],true);
 expect(tasks.map((t:any)=>t.assigneeWorkerId)).toEqual([b.id,a.id]);
});
it('explicit named-only duplicate workers are refused at their second position',async()=>{
 const a=await worker(); const before=await snapshot();
 await expect(batch([item({assignee:{worker:a.id}}),item({assignee:{worker:a.id}})],true)).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT',position:2}});
 expect(await snapshot()).toEqual(before);
});
it('failure preserves the exact matching reason and writes no match-failed task or event',async()=>{
 await worker(); const before=await snapshot();
 await expect(batch([matched({role:'missing'})],true)).rejects.toMatchObject({extensions:{code:'TASK_MATCH_FAILED',position:1,reason:'NO_ROLE'}});
 expect(await snapshot()).toEqual(before);
});
it('ordinary batch with absent/null/false option retains single-shot failure marks and per-task events',async()=>{
 for(const flag of [undefined,null,false]) {
 const tasks=await batch([matched({role:'missing'})],flag);
 expect(tasks[0]).toMatchObject({matchFailedReason:'NO_ROLE',assigneeWorkerId:null,matchPending:false});
 const events=await db.agentTeamEvent.findMany({where:{taskId:tasks[0].id},orderBy:{createdAt:'asc'}});
 expect(events.map(e=>e.type).sort()).toEqual(['assignment.queued','task.created']);
 }
});
it('same-call blockers refuse before matching, leaving no task or event',async()=>{
 await worker(); const before=await snapshot();
 await expect(batch([matched(),{...matched(),blockedByPositions:[1]}],true)).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT',position:2}});
 expect(await snapshot()).toEqual(before);
});
it('ordinary non-matched tasks and user assignees keep their meaning under the option',async()=>{
 const a=await worker();
 const tasks=await batch([item({assignee:{user:owner.id}}),item({requirements:{role:'missing'}}),matched()],true);
 expect(tasks[0].assigneeUserId).toBe(owner.id); expect(tasks[1].assigneeWorkerId).toBeNull(); expect(tasks[2].assigneeWorkerId).toBe(a.id);
});
it('two concurrent distinct batches never reserve the same worker; losing call creates nothing',async()=>{
 const a=await worker('Alpha'),b=await worker('Beta');
 const result=await Promise.allSettled([batch([matched(),matched()],true),batch([matched(),matched()],true)]);
 expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect(await db.agentTask.count({where:{appId:app.id,handle:{not:'AT0'}}})).toBe(2);
 expect(new Set((await db.agentTask.findMany({where:{appId:app.id,assigneeWorkerId:{not:null}}})).map(t=>t.assigneeWorkerId))).toEqual(new Set([a.id,b.id]));
});
it('GraphQL accepts distinctAssignees and exposes typed positioned rollback refusal',async()=>{
 const {ApolloServer}=await import('@apollo/server'); const {typeDefs}=await import('../../api/graphql/schema/typeDefs.js');
 await worker(); const api=new ApolloServer({typeDefs,resolvers});
 try {const response=await api.executeOperation({query:'mutation($a:ID!){createAgentTasks(appRef:$a,distinctAssignees:true,tasks:[{task:{title:"A",match:true}},{task:{title:"B",match:true}}]){id}}',variables:{a:app.id}},{contextValue:ctx});
 expect(response.body.kind).toBe('single'); if(response.body.kind!=='single')throw Error('single');
 expect(response.body.singleResult.errors?.[0].extensions).toMatchObject({code:'TASK_MATCH_FAILED',position:2,reason:'NOBODY_FREE'});
 expect(await db.agentTask.count({where:{appId:app.id}})).toBe(0);
 }finally{await api.stop();}
});

it('a full 25-task distinct batch succeeds with 25 eligible workers',async()=>{
 const workers=[];for(let i=0;i<25;i++)workers.push(await worker(`Reviewer${String(i).padStart(2,'0')}`));
 const tasks=await batch(Array.from({length:25},()=>matched()),true);
 expect(new Set(tasks.map((t:any)=>t.assigneeWorkerId))).toEqual(new Set(workers.map(w=>w.id)));
 expect(tasks).toHaveLength(25);
});
it('each role/family/min-tier constraint is still judged per task in a distinct batch',async()=>{
 const a=await worker('Alpha','engineer'),b=await worker('Beta','reviewer');
 const tasks=await batch([matched({role:'engineer',familyIn:['claude'],minTier:'mid'}),matched({role:'reviewer',familyNotIn:['codex']})],true);
 expect(tasks.map((t:any)=>t.assigneeWorkerId)).toEqual([a.id,b.id]);
});

it('post-commit launch receives the family selected by the atomic match',async()=>{
 await worker(); const spy=vi.spyOn(launchModule,'launchForAssignment');
 try {const [task]=await batch([matched({familyIn:['claude']})],true);
 expect(spy.mock.calls.filter(call=>call[1].taskId===task.id).map(call=>call[1].family)).toEqual(['claude']);
 }finally{spy.mockRestore();}
});

it('automatic matcher holds graph shared before a distinct batch takes its pool locks; both finish without double assignment',async()=>{
 const queued=await create({requirements:{role:'reviewer'}});
 const alpha=await worker('Alpha'), beta=await worker('Beta');
 const latch=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};};
 const paused=latch<void>(),release=latch<void>(),entered=latch<number>();
 const observedDb=new Proxy(db,{get(target,key){
  if(key==='$transaction')return (body:any,options:any)=>target.$transaction(async(tx:any)=>{
   const [{pid}]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;entered.resolve(pid);return body(tx);
  },options);
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const automatic=matchQueuedTasks(db,new Date(),{appId:app.id,hooks:{afterWorkerCheck:async()=>{paused.resolve();await release.promise;}}});
 let batchRun:Promise<any>|undefined;
 try {
  await paused.promise;
  batchRun=M.createAgentTasks({}, {appRef:app.id,distinctAssignees:true,tasks:[matched({role:'reviewer'})]}, {...ctx,db:observedDb})
   .then((value:any)=>({value}),(error:any)=>({error}));
  const pid=await entered.promise;
  let graphWait=false;const deadline=Date.now()+2000;
  while(Date.now()<deadline){
   const [lock]=await db.$queryRaw<{waiting:boolean}[]>`
    SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND locktype='advisory' AND NOT granted
     AND mode='ExclusiveLock' AND objsubid=1
     AND classid::bigint=((hashtextextended(${'task-blockers:'+app.id},0)>>32)&4294967295)
     AND objid::bigint=(hashtextextended(${'task-blockers:'+app.id},0)&4294967295)) AS waiting`;
   if(lock.waiting){graphWait=true;break;}await new Promise(r=>setTimeout(r,10));
  }
  expect(graphWait).toBe(true); // waits at graph, not on a worker held by the matcher
  release.resolve();
  expect((await automatic).map(r=>r.workerId)).toEqual([alpha.id]);
  const result=await batchRun;expect(result.error).toBeUndefined();
  expect(result.value[0].assigneeWorkerId).toBe(beta.id);
  expect((await row(queued.id)).assigneeWorkerId).toBe(alpha.id);
  expect(await db.agentTeamEvent.count({where:{appId:app.id,type:'assignment.matched'}})).toBe(2);
 }finally{release.resolve();await Promise.allSettled([automatic,...(batchRun?[batchRun]:[])]);}
},15000);

it('a distinct call with no match items completes while an unrelated worker assignment lock is held',async()=>{
 const workerRow=await worker('Unrelated');
 let held!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>{held=r;}),free=new Promise<void>(r=>{release=r;});
 const holding=db.$transaction(async(tx)=>{await lockWorkersForAssignment(tx,[workerRow.id]);held();await free;},{timeout:15000});
 let operation:Promise<any>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await entered;
  operation=batch([item({requirements:{role:'missing'}})],true).then((value:any)=>({value}),(error:any)=>({error}));
  const outcome=await Promise.race([operation,new Promise<{timeout:true}>(r=>{timer=setTimeout(()=>r({timeout:true}),5000);})]);
  expect('timeout' in outcome).toBe(false);
  if('timeout' in outcome)throw Error('unrelated worker lock blocked a non-matching batch');
  expect(outcome.error).toBeUndefined();expect(outcome.value[0].assigneeWorkerId).toBeNull();
  expect(outcome.value[0].matchPending).toBe(false);
 }finally{if(timer)clearTimeout(timer);release();await Promise.allSettled([holding,...(operation?[operation]:[])]);}
},20000);
it('distinct option still rejects match with an explicit assignee or backlog before matching',async()=>{
 const w=await worker();const before=await snapshot();
 for(const bad of [{assignee:{worker:w.id}},{status:'BACKLOG'}]){
  await expect(batch([item(),item({match:true,...bad})],true)).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT',position:2}});
  expect(await snapshot()).toEqual(before);
 }
});

it('a matched distinct batch takes every pool worker lock before inserting any task',async()=>{
 const alpha=await worker('Alpha'),beta=await worker('Beta');
 let held!:()=>void,release!:()=>void,entered!:(pid:number)=>void;
 const ready=new Promise<void>(r=>{held=r;}),free=new Promise<void>(r=>{release=r;}),started=new Promise<number>(r=>{entered=r;});
 const holding=db.$transaction(async(tx)=>{await lockWorkersForAssignment(tx,[beta.id]);held();await free;},{timeout:15000});
 const observedDb=new Proxy(db,{get(target,key){
  if(key==='$transaction')return (body:any,options:any)=>target.$transaction(async(tx:any)=>{
   const [{pid}]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;entered(pid);return body(tx);
  },options);
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 let operation:Promise<any>|undefined;
 try{
  await ready;
  operation=M.createAgentTasks({}, {appRef:app.id,distinctAssignees:true,tasks:[matched()]},{...ctx,db:observedDb})
   .then((value:any)=>({value}),(error:any)=>({error}));
  const pid=await started;let waiting=false;const deadline=Date.now()+2000;
  while(Date.now()<deadline){
   const [lock]=await db.$queryRaw<{waiting:boolean}[]>`
    SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND locktype='advisory' AND NOT granted
     AND mode='ExclusiveLock' AND objsubid=2
     AND classid::bigint=(hashtext('agent-task-matcher:worker')::bigint&4294967295)
     AND objid::bigint=(hashtext(${beta.id})::bigint&4294967295)) AS waiting`;
   if(lock.waiting){waiting=true;break;}await new Promise(r=>setTimeout(r,10));
  }
  expect(waiting).toBe(true); // Beta is not selected: only the pool fence waits on it.
  expect(await db.agentTask.count({where:{appId:app.id}})).toBe(0);
  release();const result=await operation;expect(result.error).toBeUndefined();
  expect(result.value[0].assigneeWorkerId).toBe(alpha.id);
 }finally{release();await Promise.allSettled([holding,...(operation?[operation]:[])]);}
},20000);
