/**
 * #2693: pins for #2667's LOCAL P3s. Test-only: they record CURRENT behaviour of the task edit door
 * (`updateAgentTask`); no policy changes here.
 *
 * 1. Concurrency: a second connection holds the competing act open (the task row, or the member row) while the
 *    edit is started; the edit must wait, then judge the committed state. A mutant that drops the edit door's
 *    task-row lock (`lockTask`) reads the stale row and fails these.
 * 2. No-op equality: the same `startBy` instant or the same `tags` in another order write nothing.
 * 3. Clearing `startBy` after an unacknowledged not-started alarm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { loadStallInputs, stallCandidates, effectiveWindows, raiseStallAlarm } from '../../../lib/agentTasks/stall.js';
import { resolvers } from './resolvers.js';
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

/** Runs `act` on a second connection inside an open transaction, starts the edit, waits until it is blocked, then commits. */
async function editRacing(act: (c: Client) => Promise<unknown>, input: Record<string, unknown>, userId = owner.id) {
 const c = new Client({ connectionString: process.env.DATABASE_URL });
 await c.connect();
 try {
  await c.query('BEGIN');
  await act(c);
  let settled = false;
  const outcome = edit(input, userId).then((value) => ({ value }), (error) => ({ error })).finally(() => { settled = true; });
  const deadline = Date.now() + 5000;
  for (;;) {
   const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE NOT granted`;
   if (Number(n) > 0) break;
   if (Date.now() > deadline) throw new Error('the edit never waited on the competing act');
   await new Promise((r) => setTimeout(r, 25));
  }
  expect(settled, 'the edit waits for the competing act instead of reading around it').toBe(false);
  await c.query('COMMIT');
  return (await outcome) as { value?: any; error?: any };
 } finally {
  await c.end();
 }
}
const lockTaskRow = (c: Client) => c.query('SELECT id FROM agent_tasks WHERE id = $1 FOR UPDATE', [task.id]);
const stored = () => db.agentTask.findUniqueOrThrow({ where: { id: task.id } });

describe('#2693 the edit door against concurrent acts',()=>{
 it('an edit racing finish is refused as ended, and writes nothing',async()=>{
  const r=await editRacing(async c=>{await lockTaskRow(c);await c.query("UPDATE agent_tasks SET status='finished', started_at=now(), finished_at=now(), result_outcome='done' WHERE id=$1",[task.id]);},{title:'Raced'});
  expect(r.error).toMatchObject({extensions:{code:'TASK_ENDED'}});
  expect(await edited()).toHaveLength(0);
  expect(await stored()).toMatchObject({title:'Original',status:'finished'});
 });
 it('an edit racing cancel is refused as ended, and writes nothing',async()=>{
  const r=await editRacing(async c=>{await lockTaskRow(c);await c.query("UPDATE agent_tasks SET status='cancelled', cancelled_at=now() WHERE id=$1",[task.id]);},{title:'Raced'});
  expect(r.error).toMatchObject({extensions:{code:'TASK_ENDED'}});
  expect(await edited()).toHaveLength(0);
  expect(await stored()).toMatchObject({title:'Original',status:'cancelled'});
 });
 it('the assignee editing properties while the task is reassigned away is refused, and writes nothing',async()=>{
  const r=await editRacing(async c=>{await lockTaskRow(c);await c.query('UPDATE agent_tasks SET assignee_user_id=$1 WHERE id=$2',[manager.id,task.id]);},{properties:{note:'late'}},assignee.id);
  expect(r.error).toMatchObject({extensions:{code:'TASK_NOT_OWNER'}});
  expect(await stored()).toMatchObject({properties:null,assigneeUserId:manager.id});
  expect(await db.agentTeamEvent.count({where:{taskId:task.id,type:'task.properties-changed'}})).toBe(0);
 });
 it('the owner editing while the task is reassigned applies once and keeps the new assignee',async()=>{
  const r=await editRacing(async c=>{await lockTaskRow(c);await c.query('UPDATE agent_tasks SET assignee_user_id=$1 WHERE id=$2',[manager.id,task.id]);},{title:'Owner edit'});
  expect(r.error).toBeUndefined();
  expect(await stored()).toMatchObject({title:'Owner edit',assigneeUserId:manager.id});
  expect(await edited()).toHaveLength(1);
 });
 it('a manager edit racing the manager role being revoked is refused, and writes nothing',async()=>{
  const r=await editRacing(async c=>{await c.query("UPDATE app_members SET role='member' WHERE app_id=$1 AND user_id=$2",[app.id,manager.id]);},{title:'Raced'},manager.id);
  expect(r.error).toMatchObject({extensions:{code:'TASK_NOT_OWNER'}});
  expect(await edited()).toHaveLength(0);
  expect((await stored()).title).toBe('Original');
 });
});

describe('#2693 an edit that changes nothing writes nothing',()=>{
 it('the same startBy instant, as a string or a Date, writes no event and does not touch updatedAt',async()=>{
  await edit({startBy:'2030-01-01T00:00:00Z'});
  expect(await edited()).toHaveLength(1);
  const before=await stored();
  await edit({startBy:'2030-01-01T00:00:00.000Z'});
  await edit({startBy:new Date('2030-01-01T00:00:00Z')});
  expect(await edited()).toHaveLength(1);
  expect(await stored()).toEqual(before);
 });
 it('the same tags in the same order write no event and change nothing',async()=>{
  await edit({tags:['a','b','c']});
  expect(await edited()).toHaveLength(1);
  const before=await stored();
  await edit({tags:['a','b','c']});
  expect(await edited()).toHaveLength(1);
  expect(await stored()).toEqual(before);
 });
 // CURRENT behaviour, not the issue's expectation: tags are an ORDERED array and the comparison is order-sensitive, so
 // the same set in another order is an edit (one task.edited event, order stored as given). Making reordered-equal
 // tags a no-op is a policy change, left to a ruling; if it is made, this pin is the one to flip.
 it('the same tags in another order are an edit today: one event, the new order stored',async()=>{
  await edit({tags:['a','b','c']});
  await edit({tags:['c','a','b']});
  expect(await edited()).toHaveLength(2);
  expect((await stored()).tags).toEqual(['c','a','b']);
  expect((await edited())[1].payload).toEqual({fields:['tags']});
 });
});

describe('#2693 clearing startBy after an unacknowledged not-started alarm',()=>{
 const notStarted=async()=>stallCandidates((await loadStallInputs(db,{id:task.id},new Date()))[0],effectiveWindows(null),new Date()).find(c=>c.rule==='not-started');
 it('opens a new episode, and the first alarm stays unacknowledged',async()=>{
  const assignedAt=new Date(Date.now()-3600_000);
  await db.agentTask.update({where:{id:task.id},data:{assignedAt}});
  await edit({startBy:new Date(Date.now()-1000)});
  const first=(await notStarted())!;
  const alarmId=(await raiseStallAlarm(db,first,new Date()))!;
  expect(alarmId).toBeTruthy();
  await edit({startBy:null});
  expect((await stored()).startBy).toBeNull();
  const after=(await notStarted())!;
  expect(after).toBeTruthy();
  expect(after.episodeStart.getTime()).not.toBe(first.episodeStart.getTime());
  expect(await db.agentTeamEvent.findUnique({where:{id:alarmId}})).toMatchObject({acknowledgedAt:null,type:'stall.not-started'});
  // the new episode can raise its own alarm: two not-started alarms now exist for the task, the first still open
  const secondId=await raiseStallAlarm(db,after,new Date());
  expect(secondId).toBeTruthy();
  expect(secondId).not.toBe(alarmId);
  expect(await db.agentTeamEvent.count({where:{taskId:task.id,type:'stall.not-started'}})).toBe(2);
 });
});
