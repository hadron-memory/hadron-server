import { composeWorkerUrn } from '../entityRef/workerRef.js';
/** #2829/#2830: blocking single-shot matching, role sets and reporting-team pools. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { __matcherTesting, matchingTeamPool, matchQueuedTasks } from './matcher.js';
import { evaluateStalls, effectiveWindows, loadStallInputs, stallCandidates } from './stall.js';
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
  expect(await db.agentTeamEvent.count({where:{taskId:t.id,type:'assignment.matched'}})).toBe(1);
  expect(await db.agentTeamEvent.count({where:{taskId:t.id,type:'task.assigned'}})).toBe(0);
});
it('failed match is marked, filtered, skipped after availability changes, cleared on cancel, cleared on manual assign, with no unassignable alarm',async()=>{
  const t=await create({match:true,requirements:{role:'reviewer'}});
  expect(t.matchFailedReason).toBe('NO_ROLE'); expect(t.matchFailedAt).toBeInstanceOf(Date);
  const w=await worker();
  expect(await matchQueuedTasks(db,new Date(),{appId:app.id})).toEqual([]);
  expect((await row(t.id)).assigneeWorkerId).toBeNull();
  const marked=await Q.agentTasks({}, {appRef:app.id,matchFailed:true},ctx);
  expect(marked.map((x:any)=>x.id)).toEqual([t.id]);
  const now=new Date(Date.now()+3600000);
  await evaluateStalls(db,now);
  expect(await db.agentTeamEvent.count({where:{taskId:t.id,type:'assignment.unassignable'}})).toBe(0);
  const inputs=await loadStallInputs(db,{id:t.id},now);
  expect(stallCandidates(inputs[0],effectiveWindows(null),now).filter(x=>x.rule==='unassignable')).toEqual([]);
  const cancelled=await create({match:true,requirements:{role:'missing'}});
  await M.cancelAgentTask({}, {taskId:cancelled.id},ctx);
  expect(await row(cancelled.id)).toMatchObject({matchFailedAt:null,matchFailedReason:null});
  await M.assignAgentTask({}, {taskId:t.id,assignee:{worker:w.id}},ctx);
  expect(await row(t.id)).toMatchObject({matchFailedAt:null,matchFailedReason:null,assigneeWorkerId:w.id});
  expect((await Q.agentTasks({}, {appRef:app.id,matchFailed:true},ctx)).map((x:any)=>x.id)).toEqual([]);
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
it('team-empty and stop-signal failures are distinguished, and the failure never enters automatic stop-hold accounting',async()=>{
  const lead=await worker('Lead','manager'),other=await worker('Other','manager');
  const outside=await worker('Outside','reviewer',other.id);
  expect((await create({match:true,requirements:{role:'reviewer',team:lead.id}})).matchFailedReason).toBe('TEAM_POOL_EMPTY');
  const w=await worker('Inside','reviewer',lead.id);
  await db.teamStopSignal.create({data:{id:generateId(),appId:app.id,level:'pause',scope:'worker',targetWorkerId:w.id,setAt:new Date(),setByUserId:owner.id}});
  const t=await create({match:true,requirements:{role:'reviewer',team:lead.id}});
  expect(t.matchFailedReason).toBe('STOP_SIGNAL');
  await matchQueuedTasks(db,new Date(),{appId:app.id});
  expect(await db.agentTaskStopHold.count({where:{taskId:t.id,endedAt:null}})).toBe(0);
  expect((await row(t.id)).assigneeWorkerId).toBeNull();
  expect((await row(t.id)).matchFailedAt).toEqual(t.matchFailedAt);
  expect(outside.id).not.toBe(w.id);
});
it('descendants include multi-hop reporting lines; null parent ignores explicitNoTeam; other-App lead refuses atomically',async()=>{
  const lead=await worker('Lead','manager'),mid=await worker('Mid','manager',lead.id);
  const child=await worker('Child','reviewer',mid.id);
  const t=await create({match:true,requirements:{team:composeWorkerUrn(app.urn, lead.slug),role:'reviewer'}});
  expect(t.assigneeWorkerId).toBe(child.id);
  const other=await db.app.create({data:{organizationId:app.organizationId,name:'Other',urn:`other-${generateId()}.example:app`}});
  const alien=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:other.id,agentId:agent.id,name:'Alien',slug:'alien'}});
  const before=await db.agentTask.count();
  await expect(create({match:true,requirements:{team:composeWorkerUrn(other.urn, alien.slug)}})).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
  expect(await db.agentTask.count()).toBe(before);
});
it('single role stays byte-identical, role set uses any listed role, and failed list cannot widen App access',async()=>{
  const w=await worker('Reviewer','Reviewer');
  const a=await create({match:true,requirements:{role:'Reviewer'}});
  expect(a.requirements).toEqual({role:'Reviewer'}); expect(a.assigneeWorkerId).toBe(w.id);
  const failed=await create({match:true,requirements:{roles:['engineer','REVIEWER']}});
  expect(failed.matchFailedReason).toBe('NOBODY_FREE');
  const outsider=await db.user.create({data:{handle:`outsider-${generateId()}`}});
  await expect(Q.agentTasks({}, {appRef:app.id,matchFailed:true},{db,userId:outsider.id,roles:['READER']})).rejects.toMatchObject({extensions:{code:'APP_NOT_FOUND'}});
});
it('match flag with backlog or explicit assignee refuses without a task; null preserves the default',async()=>{
  const w=await worker(); const before=await db.agentTask.count();
  for(const input of [{status:'BACKLOG'},{assignee:{worker:w.id}}]) {
    await expect(create({match:true,...input})).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
    expect(await db.agentTask.count()).toBe(before);
  }
  expect((await create({match:null})).matchFailedAt).toBeNull();
});

it('a corrupt cyclic reporting snapshot is bounded and never joins an unrelated team',async()=>{
  const rows=[{id:'lead',reportsToWorkerId:null,retiredAt:null},{id:'a',reportsToWorkerId:'b',retiredAt:null},{id:'b',reportsToWorkerId:'a',retiredAt:null},{id:'loose',reportsToWorkerId:null,retiredAt:null}];
  const fake={worker:{findMany:vi.fn().mockResolvedValue(rows)}};
  expect([...(await matchingTeamPool(fake as any,'app','lead'))].sort()).toEqual(['lead','loose']);
  expect(fake.worker.findMany).toHaveBeenCalledTimes(1);
});

it('executable GraphQL exposes the failure and team requirements under the same list gate',async()=>{
  const { ApolloServer }=await import('@apollo/server');
  const { typeDefs }=await import('../../api/graphql/schema/typeDefs.js');
  const lead=await worker('Lead','manager');
  const api=new ApolloServer({typeDefs,resolvers});
  try {
    const made=await api.executeOperation({query:`mutation($app:ID!,$lead:String!){createAgentTask(input:{appRef:$app,title:"GraphQL",match:true,requirements:{roles:["missing"],team:$lead}}){id matchFailure{reason failedAt} requirements{roles teamWorkerId}}}`,variables:{app:app.id,lead:composeWorkerUrn(app.urn, lead.slug)}},{contextValue:ctx});
    expect(made.body.kind).toBe('single');
    if(made.body.kind!=='single') throw Error('single expected');
    expect(made.body.singleResult.errors).toBeUndefined();
    const task=(made.body.singleResult.data as any).createAgentTask;
    expect(task).toMatchObject({matchFailure:{reason:'NO_ROLE'},requirements:{roles:['missing'],teamWorkerId:lead.id}});
    const list=await api.executeOperation({query:`query($app:ID!){agentTasks(appRef:$app,matchFailed:true){id matchFailure{reason}}}`,variables:{app:app.id}},{contextValue:ctx});
    if(list.body.kind!=='single') throw Error('single expected');
    expect(list.body.singleResult.errors).toBeUndefined();
    expect((list.body.singleResult.data as any).agentTasks).toEqual([{id:task.id,matchFailure:{reason:'NO_ROLE'}}]);
  } finally {await api.stop();}
});

it('the final assignment transaction rejects a worker outside the current reporting-team pool', async () => {
  const lead = await worker('Lead', 'manager');
  const other = await worker('Other', 'manager');
  const outsider = await worker('Outside', 'reviewer', other.id);
  const task = await create({ requirements: { team: lead.id, role: 'reviewer' } });
  expect(await __matcherTesting.tryAssign(db, task, outsider.id, 'claude', new Date(), {})).toBe('worker-not-free');
  expect((await row(task.id)).assigneeWorkerId).toBeNull();
  expect(await db.agentTeamEvent.count({ where: { taskId: task.id, type: 'assignment.matched' } })).toBe(0);
});

it('role and role-set together refuse before creating a task', async () => {
  const before = await db.agentTask.count();
  await expect(create({ requirements: { role: 'reviewer', roles: ['reviewer'] } })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  expect(await db.agentTask.count()).toBe(before);
});

it('match now refuses an open blocker atomically but accepts ended blockers', async () => {
  const w = await worker();
  const blocker = await create();
  const before = await db.agentTask.count();
  await expect(create({ match: true, blockedBy: [blocker.id] })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  expect(await db.agentTask.count()).toBe(before);
  await M.cancelAgentTask({}, { taskId: blocker.id }, ctx);
  expect((await create({ match: true, blockedBy: [blocker.id] })).assigneeWorkerId).toBe(w.id);
});

it.each(['failed', 'held'])('park then ready clears %s matching state and restores regular matching', async (state) => {
  const task = await create({ match: true, requirements: { role: 'reviewer' } });
  if (state === 'held') await db.agentTask.update({ where: { id: task.id }, data: { matchPending: true, matchFailedAt: null, matchFailedReason: null } });
  await M.parkAgentTask({}, { taskId: task.id }, ctx);
  const w = await worker();
  await M.makeAgentTaskReady({}, { taskId: task.id }, ctx);
  expect(await row(task.id)).toMatchObject({ matchPending: false, matchFailedAt: null, matchFailedReason: null, assigneeWorkerId: null });
  expect((await Q.agentTasks({}, { appRef: app.id, matchFailed: false }, ctx)).map((t: any) => t.id)).toContain(task.id);
  await matchQueuedTasks(db, new Date(), { appId: app.id });
  expect((await row(task.id)).assigneeWorkerId).toBe(w.id);
});

it('batch match-now attempts items in list order after commit and marks failure without rolling back creation', async () => {
  const w = await worker();
  const tasks = await M.createAgentTasks({}, { appRef: app.id, tasks: [
    { task: { title: 'First', match: true, requirements: { role: 'reviewer' } } },
    { task: { title: 'Second', match: true, requirements: { role: 'reviewer' } } },
  ] }, ctx);
  expect(tasks).toHaveLength(2);
  expect(tasks[0]).toMatchObject({ assigneeWorkerId: w.id, matchPending: false, matchFailedAt: null });
  expect(tasks[1]).toMatchObject({ assigneeWorkerId: null, matchPending: false, matchFailedReason: 'NOBODY_FREE' });
  expect(tasks[1].matchFailedAt).toBeInstanceOf(Date);
  expect(tasks.map((t: any) => t.requirements)).toEqual([{ role: 'reviewer' }, { role: 'reviewer' }]);
  expect(await db.agentTeamEvent.count({ where: { taskId: { in: tasks.map((t: any) => t.id) }, type: 'assignment.matched' } })).toBe(1);
});

it('batch match-now refuses a forward blocker after all links, rolling back every row and event', async () => {
  await worker();
  const before = await db.agentTask.count(), events = await db.agentTeamEvent.count();
  await expect(M.createAgentTasks({}, { appRef: app.id, tasks: [
    { task: { title: 'Blocked', match: true }, blockedByPositions: [2] },
    { task: { title: 'Later blocker' } },
  ] }, ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', position: 1 } });
  expect(await db.agentTask.count()).toBe(before);
  expect(await db.agentTeamEvent.count()).toBe(events);
});

it('batch match-now accepts an ended existing blocker and applies single-input refusals with position', async () => {
  const w = await worker();
  for (const bad of [{ status: 'BACKLOG' }, { assignee: { worker: w.id } }]) {
    const before = await db.agentTask.count();
    await expect(M.createAgentTasks({}, { appRef: app.id, tasks: [
      { task: { title: 'Earlier' } }, { task: { title: 'Bad', match: true, ...bad } },
    ] }, ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', position: 2 } });
    expect(await db.agentTask.count()).toBe(before);
  }
  const ended = await create();
  await M.cancelAgentTask({}, { taskId: ended.id }, ctx);
  const tasks = await M.createAgentTasks({}, { appRef: app.id, tasks: [
    { task: { title: 'Ready', match: true, blockedBy: [ended.id] } },
  ] }, ctx);
  expect(tasks[0].assigneeWorkerId).toBe(w.id);
});

it('no-match batch preserves ordinary queued results and events for omitted false and null', async () => {
  const tasks = await M.createAgentTasks({}, { appRef: app.id, tasks: [
    { task: { title: 'Ordinary' } }, { task: { title: 'Ordinary', match: false } }, { task: { title: 'Ordinary', match: null } },
  ] }, ctx);
  for (const t of tasks) {
    expect(t).toMatchObject({ title: 'Ordinary', status: 'pending', assigneeWorkerId: null, matchPending: false, matchFailedAt: null, matchFailedReason: null });
    // createdAt can tie and there is no insertion-sequence column; compare exact event
    // multiplicities in a deliberate non-chronological order, not unspecified SQL tie order.
    const events = await db.agentTeamEvent.findMany({ where: { taskId: t.id }, orderBy: { type: 'asc' } });
    expect(events.map(e => e.type)).toEqual(['assignment.queued', 'task.created']);
  }
});

it('a clone keeps normalized role/team requirements but starts without the source match-failure state', async () => {
  const lead = await worker('Lead', 'manager');
  const source = await create({ match: true, requirements: { roles: ['missing'], team: lead.id } });
  expect(source.matchFailedReason).toBe('NO_ROLE');
  const cloned = await M.cloneAgentTask({}, { taskId: source.id, input: {} }, ctx);
  expect(cloned).toMatchObject({ clonedFromId: source.id, status: 'pending', assigneeWorkerId: null, matchPending: false, matchFailedAt: null, matchFailedReason: null });
  expect(cloned.requirements).toEqual(source.requirements);
  expect((await row(source.id)).matchFailedReason).toBe('NO_ROLE');
});
