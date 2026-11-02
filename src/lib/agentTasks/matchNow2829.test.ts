/** #2829/#2830: blocking single-shot matching, role sets and reporting-team pools. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { matchQueuedTasks } from './matcher.js';
import { effectiveWindows, loadStallInputs, stallCandidates } from './stall.js';
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
it('one call assigns once, and no match flag leaves the original queued result untouched when automatic matching is disabled',async()=>{
  const w=await worker();
  const ordinary=await create({requirements:{role:'reviewer'}});
  expect(ordinary.assigneeWorkerId).toBeNull();
  const t=await create({match:true,requirements:{roles:['engineer','reviewer']}});
  expect(t.assigneeWorkerId).toBe(w.id);
  expect(t.matchFailedAt).toBeNull();
  expect(await db.agentTeamEvent.count({where:{taskId:t.id,type:{in:['task.assigned','assignment.matched']}}})).toBe(1);
});
it('failed match is marked, filtered, skipped after availability changes, kept on cancel, cleared on manual assign, with no unassignable alarm',async()=>{
  const t=await create({match:true,requirements:{role:'reviewer'}});
  expect(t.matchFailedReason).toBe('NO_ROLE'); expect(t.matchFailedAt).toBeInstanceOf(Date);
  const w=await worker();
  expect(await matchQueuedTasks(db,new Date(),{appId:app.id})).toEqual([]);
  expect((await row(t.id)).assigneeWorkerId).toBeNull();
  const marked=await Q.agentTasks({}, {appRef:app.id,matchFailed:true},ctx);
  expect(marked.map((x:any)=>x.id)).toEqual([t.id]);
  const now=new Date(Date.now()+3600000);
  const inputs=await loadStallInputs(db,{id:t.id},now);
  expect(stallCandidates(inputs[0],effectiveWindows(null),now).filter(x=>x.rule==='unassignable')).toEqual([]);
  const cancelled=await create({match:true,requirements:{role:'missing'}});
  await M.cancelAgentTask({}, {taskId:cancelled.id},ctx);
  expect((await row(cancelled.id)).matchFailedReason).toBe('NO_ROLE');
  await M.assignAgentTask({}, {taskId:t.id,assignee:{worker:w.id}},ctx);
  expect(await row(t.id)).toMatchObject({matchFailedAt:null,matchFailedReason:null,assigneeWorkerId:w.id});
  expect((await Q.agentTasks({}, {appRef:app.id,matchFailed:true},ctx)).map((x:any)=>x.id)).toEqual([cancelled.id]);
});
it('two concurrent match-now creates compete for one worker through the existing assignment lock',async()=>{
  const w=await worker();
  const tasks=await Promise.all([create({match:true}),create({match:true})]);
  expect(tasks.filter(t=>t.assigneeWorkerId===w.id)).toHaveLength(1);
  expect(tasks.filter(t=>t.matchFailedReason==='NOBODY_FREE')).toHaveLength(1);
  expect(await db.agentTeamEvent.count({where:{taskId:{in:tasks.map(t=>t.id)},type:'assignment.matched'}})).toBe(1);
});
it('empty role set and invalid team leads refuse before anything is created',async()=>{
  const lead=await worker('Retired'); await db.worker.update({where:{id:lead.id},data:{retiredAt:new Date()}});
  const before=await db.agentTask.count();
  for(const requirements of [{roles:[]},{team:lead.id},{team:generateId()}]) {
    await expect(create({match:true,requirements})).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
    expect(await db.agentTask.count()).toBe(before);
  }
});
it('team narrows the pool: descendant and null parent join, other tree does not; role and family remain ANDed',async()=>{
  const lead=await worker('Lead','manager'),other=await worker('Other','manager');
  await worker('Outside','reviewer',other.id);
  const inTeam=await worker('Inside','reviewer',lead.id);
  const t=await create({match:true,requirements:{team:lead.id,roles:['reviewer','engineer'],familyIn:['claude']}});
  expect(t.assigneeWorkerId).toBe(inTeam.id);
  expect(t.requirements.teamWorkerId).toBe(lead.id);
  const loose=await worker('Loose');
  const t2=await create({match:true,requirements:{team:lead.id,role:'reviewer'}});
  expect(t2.assigneeWorkerId).toBe(loose.id);
});
it('family exclusion produces a closed failure reason, and omitted team still admits another tree',async()=>{
  const lead=await worker('Lead','manager'); const w=await worker('Outside','reviewer',lead.id);
  const failed=await create({match:true,requirements:{role:'reviewer',familyNotIn:['claude']}});
  expect(failed.matchFailedReason).toBe('REQUIREMENTS_EXCLUDED');
  expect((await create({match:true,requirements:{role:'reviewer'}})).assigneeWorkerId).toBe(w.id);
});
