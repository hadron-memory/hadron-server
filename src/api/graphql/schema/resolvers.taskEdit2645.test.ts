/** #2645: descriptive edits reuse assign authority, never lifecycle/progress or wake authority. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { pendingTaskWakes } from '../../../lib/agentTasks/taskWakes.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { loadStallInputs, stallCandidates, effectiveWindows, raiseStallAlarm } from '../../../lib/agentTasks/stall.js';
import { appendTaskEvent } from '../../../lib/agentTasks/events.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js',()=>({writeNodeToGit:vi.fn().mockResolvedValue(undefined)}));
const M = resolvers.Mutation as any;
let app: any, owner: any, manager: any, assignee: any, outsider: any, agent: any, worker: any, head: any, task: any;
const ctx = (userId=owner.id) => ({db,userId,roles:['READER']});
async function edit(input: Record<string,unknown>, userId=owner.id) {
 expect(M.updateAgentTask, 'the one task edit mutation is implemented').toBeTypeOf('function');
 return M.updateAgentTask({}, {taskId:task.id,input}, ctx(userId));
}
const edited = () => db.agentTeamEvent.findMany({where:{taskId:task.id,type:'task.edited'}});
beforeEach(async()=>{
 await cleanDb(db);
 const org=await db.organization.create({data:{name:'Edit',urn:`edit-${generateId()}.test`}});
 [owner,manager,assignee,outsider]=await Promise.all(['owner','manager','assignee','outsider'].map(handle=>db.user.create({data:{handle}})));
 app=await db.app.create({data:{organizationId:org.id,name:'Edit',urn:`${org.urn}:edit`}});
 for(const [u,role] of [[owner,'member'],[manager,'owner'],[assignee,'member']] as const) await db.appMember.create({data:{appId:app.id,userId:u.id,role}});
 agent=await db.agent.create({data:{organizationId:org.id,name:'Agent',urn:`${org.urn}:agent`}});
 await db.appAgent.create({data:{appId:app.id,agentId:agent.id}});
 head=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Head',slug:'head',heldByUserId:owner.id}});
 worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Worker',slug:'worker',heldByUserId:owner.id,reportsToWorkerId:head.id}});
 task=await M.createAgentTask({}, {input:{appRef:app.id,title:'Original',description:'Old text',source:'fixed-source',tags:['old'],assignee:{user:assignee.id}}},ctx());
});
describe('task edit #2645',()=>{
 it('replaces named values, keeps identity and untouched fields, and emits field names only',async()=>{
  const out=await edit({title:'New PRIVATE',description:'PRIVATE description',tags:['new'],requirements:{role:'server-engineer'},startBy:'2030-01-01T00:00:00Z',closeSessionWhenDone:true});
  expect(out).toMatchObject({id:task.id,handle:task.handle,title:'New PRIVATE',description:'PRIVATE description',tags:['new'],requirements:{role:'server-engineer'},source:'fixed-source',status:'pending',assigneeUserId:assignee.id,closeSessionWhenDone:true});
  const events=await edited();expect(events).toHaveLength(1);
  expect(events[0].payload).toEqual({fields:['title','description','tags','requirements','startBy','closeSessionWhenDone']});
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
  const stamp=out.updatedAt;
  await edit({title:'New PRIVATE',tags:['new'],requirements:{role:'server-engineer'}});
  expect(await edited()).toHaveLength(1);
  expect((await db.agentTask.findUniqueOrThrow({where:{id:task.id}})).updatedAt).toEqual(stamp);
 });
 it('clears optional fields explicitly, with omitted fields unchanged',async()=>{
  await edit({description:'',tags:[],requirements:null,startBy:null,closeSessionWhenDone:false});
  expect(await db.agentTask.findUniqueOrThrow({where:{id:task.id}})).toMatchObject({title:'Original',description:null,tags:[],requirements:null,startBy:null,source:'fixed-source',closeSessionWhenDone:false});
 });
 it.each([{title:''},{title:null},{source:'new'},{status:'finished'},{parentTaskId:'other'},{owner:{user:'other'}},{attributes:{secret:true}}])('refuses invalid or forbidden patch %j atomically',async input=>{
  await expect(edit(input)).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
  expect((await db.agentTask.findUniqueOrThrow({where:{id:task.id}})).title).toBe('Original');expect(await edited()).toHaveLength(0);
 });
 it('admits App managers using the same authority as assign',async()=>{
  expect((await edit({title:'Manager edit'},manager.id)).title).toBe('Manager edit');
 });
 it('admits a worker above the worker owner in the reporting chain',async()=>{
  await db.agentTask.update({where:{id:task.id},data:{ownerUserId:null,ownerWorkerId:worker.id}});
  const out=await runAsActor({workerId:head.id,agentId:agent.id},()=>edit({title:'Chain edit'}));
  expect(out.title).toBe('Chain edit');
  expect((await edited())[0].actorWorkerId).toBe(head.id);
 });
 it('refuses assignee-only, App keys, and revoked managers; conceals outsiders byte-identically',async()=>{
  await expect(edit({title:'No'},assignee.id)).rejects.toMatchObject({extensions:{code:'TASK_NOT_OWNER'}});
  await db.appMember.update({where:{appId_userId:{appId:app.id,userId:manager.id}},data:{role:'member'}});
  await expect(edit({title:'No'},manager.id)).rejects.toMatchObject({extensions:{code:'TASK_NOT_OWNER'}});
  const hidden=await edit({title:'No'},outsider.id).catch(e=>e);
  const absent=await M.assignAgentTask({}, {taskId:task.id,assignee:{user:outsider.id}},ctx(outsider.id)).catch((e:any)=>e);
  expect({message:hidden.message,extensions:hidden.extensions}).toEqual({message:absent.message,extensions:absent.extensions});
  const key=await db.appKey.create({data:{appId:app.id,keyHash:generateId(),keyPreview:'test'}});
  await expect(M.updateAgentTask({}, {taskId:task.id,input:{title:'No'}},{db,appId:app.id,appKeyId:key.id,roles:[]})).rejects.toMatchObject({extensions:{code:'TASK_NOT_FOUND'}});
  expect(await edited()).toHaveLength(0);
 });
 it('refuses an impersonation session even when the impersonated user owns the task',async()=>{
  const impersonation={sessionId:generateId(),actorUserId:manager.id,orgId:app.organizationId,expiresAt:new Date(Date.now()+3600_000)};
  await expect(M.updateAgentTask({}, {taskId:task.id,input:{title:'Impersonated'}},{...ctx(),impersonation})).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});
  expect((await db.agentTask.findUniqueOrThrow({where:{id:task.id}})).title).toBe('Original');expect(await edited()).toHaveLength(0);
 });
 it('stores task.edited payloads only for editable field names',async()=>{
  const actor={userId:owner.id,workerId:null,agentId:null};
  await expect(appendTaskEvent(db,{appId:app.id,taskId:task.id,actor,event:{type:'task.edited',fields:['source' as any]}})).rejects.toThrow(/Unsupported task edit field/);
  expect(await edited()).toHaveLength(0);
  await appendTaskEvent(db,{appId:app.id,taskId:task.id,actor,event:{type:'task.edited',fields:['title','title']}});
  expect((await edited())[0].payload).toEqual({fields:['title']});
 });
 it.each(['finished','cancelled'])('refuses even a no-op edit on %s',async status=>{
  await db.agentTask.update({where:{id:task.id},data:status==='finished'?{status,startedAt:new Date(),finishedAt:new Date(),resultOutcome:'done'}:{status,cancelledAt:new Date()}});
  await expect(edit({})).rejects.toMatchObject({extensions:{code:'TASK_ENDED'}});expect(await edited()).toHaveLength(0);
 });
 it('does not move a started task or restart its no-progress clock',async()=>{
  const startedAt=new Date(Date.now()-7200_000);
  await db.agentTask.update({where:{id:task.id},data:{status:'started',startedAt,assignedAt:startedAt}});
  const before=(await loadStallInputs(db,{id:task.id},new Date()))[0];
  await edit({requirements:{role:'different-role'},startBy:'2030-01-01T00:00:00Z'});
  const after=(await loadStallInputs(db,{id:task.id},new Date()))[0];
  expect(after.task).toMatchObject({status:'started',assigneeUserId:assignee.id,startedAt});
  const candidate=(input:any)=>stallCandidates(input,effectiveWindows(null),new Date()).find(c=>c.rule==='no-progress');
  expect(candidate(after)).toEqual(candidate(before));
 });
 it('reanchors only not-started deadline and gives a changed startBy a new episode',async()=>{
  const assignedAt=new Date(Date.now()-3600_000);
  await db.agentTask.update({where:{id:task.id},data:{assignedAt}});
  const before=(await loadStallInputs(db,{id:task.id},new Date()))[0];
  const old=stallCandidates(before,effectiveWindows(null),new Date()).find(c=>c.rule==='not-started')!;
  const alarmId=await raiseStallAlarm(db,old,new Date());
  expect(alarmId).toBeTruthy();
  await edit({startBy:new Date(Date.now()-1000)});
  const after=(await loadStallInputs(db,{id:task.id},new Date()))[0];
  const next=stallCandidates(after,effectiveWindows(null),new Date()).find(c=>c.rule==='not-started')!;
  expect(next.episodeStart.getTime()).toBeGreaterThan(old.episodeStart.getTime());
  expect(await db.agentTeamEvent.findUnique({where:{id:alarmId!}})).toMatchObject({acknowledgedAt:null,type:'stall.not-started'});
  expect(next.dueAt.getTime()).toBe((after.task.startBy as Date).getTime());
  await edit({startBy:new Date(assignedAt.getTime()-1000)});
  const earlier=(await loadStallInputs(db,{id:task.id},new Date()))[0];
  expect(stallCandidates(earlier,effectiveWindows(null),new Date()).find(c=>c.rule==='not-started')!.dueAt.getTime()).toBe(assignedAt.getTime()+15*60_000);
 });
 it('never clears an assignment wake, and the edit event alone creates no wake',async()=>{
  const at=(n:number)=>new Date(Date.now()-10_000+n*1000);
  task=await db.agentTask.create({data:{appId:app.id,title:'Wake control',ownerWorkerId:worker.id,assigneeWorkerId:worker.id,assignedAt:at(1)}});
  const assigned=await db.agentTeamEvent.create({data:{appId:app.id,taskId:task.id,type:'task.assigned',subjectWorkerId:worker.id,createdAt:at(1)}});
  await runAsActor({workerId:worker.id,agentId:agent.id},()=>edit({title:'Passive edit'}));
  const wakes=(await pendingTaskWakes(db,[worker.id],new Date())).get(worker.id) ?? [];
  expect(wakes.map(w=>w.eventId)).toContain(assigned.id);
  expect(wakes.map(w=>w.eventId)).not.toContain((await edited())[0].id);
  expect(await db.workerDeliveryTaskEvent.count()).toBe(0);
 });
 it('does not clear a child-finished wake when its worker owner edits the parent',async()=>{
  const at=(n:number)=>new Date(Date.now()-10_000+n*1000);
  await db.agentTask.update({where:{id:task.id},data:{ownerUserId:null,ownerWorkerId:worker.id}});
  const child=await db.agentTask.create({data:{appId:app.id,parentTaskId:task.id,title:'Child',ownerWorkerId:worker.id,assigneeUserId:assignee.id,status:'finished',assignedAt:at(0),startedAt:at(0),finishedAt:at(1),resultOutcome:'done'}});
  const finished=await db.agentTeamEvent.create({data:{appId:app.id,taskId:child.id,type:'task.finished',createdAt:at(1)}});
  await runAsActor({workerId:worker.id,agentId:agent.id},()=>edit({description:'Passive parent edit'}));
  expect((await pendingTaskWakes(db,[worker.id],new Date())).get(worker.id)?.map(w=>w.eventId)).toContain(finished.id);
 });
 it('exposes the patch through the GraphQL transport',async()=>{
  const apollo=new ApolloServer({typeDefs,resolvers});
  const operation=await apollo.executeOperation({query:'mutation($id:ID!){updateAgentTask(taskId:$id,input:{title:"GraphQL"}){id title}}',variables:{id:task.id}},{contextValue:ctx()});
  await apollo.stop();
  expect(operation.body.kind).toBe('single');
  const result=(operation.body as any).singleResult;
  expect(result.errors).toBeUndefined();expect(result.data?.updateAgentTask).toMatchObject({id:task.id,title:'GraphQL'});
 // #3082: the MCP half (hadron_task_update, source refused) is disabled; the forbidden-source refusal stays pinned by the 'refuses invalid or forbidden patch' cases above.
});
});
