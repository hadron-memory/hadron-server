/** #3243, ruling0084 A: distinct batch matching is all-or-none, named workers count. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';

import { matchQueuedTasks } from './matcher.js';

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
