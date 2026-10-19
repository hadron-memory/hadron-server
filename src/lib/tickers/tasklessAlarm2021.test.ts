/** #2021/#2014 — task-less alarm transport uses real schedules and per-event delivery identity. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { computeDueWakes } from './dueWakes.js';
import { verifyWakeProof } from './wakeProof.js';
import { pendingTaskWakes } from '../agentTasks/taskWakes.js';
import { deliveryStateTransaction, beginDeliveryTracking, observeDeliveryPolicyThrough, reconcileDeliveryAlarm } from './deliveryState.js';
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const MIN = 60_000;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
let org: { id: string; urn: string };
let manager: { id: string };
let holder: { id: string };
let outsider: { id: string };
let app: { id: string; organizationId: string | null; ownerUserId: string | null };
let agent: { id: string };
let liam: { id: string; name: string };
let rook: { id: string; name: string };

async function mkUser(n: number) {
  return db.user.create({
    data: { id: generateId(), githubId: 1_708_000 + n * 1000 + Math.floor(Math.random() * 1000), githubUsername: `tw-${n}-${generateId().slice(-8)}`, roles: ['READER'] },
    select: { id: true },
  });
}
const mkWorker = (name: string, extra: Record<string, unknown> = {}) =>
  db.worker.create({
    data: { id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), heldByUserId: holder.id, heldAt: new Date(), ...extra },
    select: { id: true, name: true },
  });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().slice(-10).toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'tw-org', urn: `tw-org-${suffix}.com` } });
  [manager, holder, outsider] = [await mkUser(1), await mkUser(2), await mkUser(3)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, organizationId: true, ownerUserId: true } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
  liam = await mkWorker('Liam');
  rook = await mkWorker('Rook');
});

/** The due wakes the App's manager reads, at `now`. */
const dueFor = (c: Context = ctx(manager.id), now = new Date()) =>
  computeDueWakes({ ctx: c, app, reader: { manager: true, userId: c.userId ?? null }, requester: { userId: c.userId! }, now });


const now = () => new Date();
async function deliveryAlarm(personOnly=false) {
 const at=now(),dueSince=new Date(at.getTime()-20*MIN);
 if(!personOnly) await db.worker.update({where:{id:liam.id},data:{reportsToWorkerId:rook.id}});
 const memory=await db.memory.create({data:{organizationId:org.id,name:'alarm channel',urn:`${org.urn}:alarm-channel`,class:'knowledge'}});
 const root=await db.node.create({data:{memoryId:memory.id,loc:'chat',name:'Chat',nodeType:'chat'}});
 const channel=await db.channel.create({data:{memoryId:memory.id,loc:'chat',name:'Chat',chatRootNodeId:root.id}});
 const raised=await deliveryStateTransaction(db,app.id,liam.id,async tx=>{
  await beginDeliveryTracking(tx,liam.id,dueSince);await observeDeliveryPolicyThrough(tx,liam.id,new Date(at.getTime()+MIN));
  return reconcileDeliveryAlarm(tx,{workerId:liam.id,candidates:[{workerId:liam.id,channelId:channel.id,channelIncarnation:1,seq:1,dueSince}],now:at,hold:null});
 });
 expect(raised.raised).toBeTruthy();
 return db.agentTeamEvent.findUniqueOrThrow({where:{id:raised.raised!}});
}
it('a delivery alarm with no task reaches the scheduled worker without fabricating task metadata',async()=>{
 const e=await deliveryAlarm();
 const p=await pendingTaskWakes(db,[rook.id],now());
 expect(p.get(rook.id)).toEqual([expect.objectContaining({taskId:null,eventId:e.id,subjectWorkerId:liam.id,chainIndex:0,event:'ALARM',title:null})]);
 const page=await dueFor();
 const wake=page.wakes.find(w=>w.workerId===rook.id)!;
 expect(wake).toBeDefined();
 expect(wake.wake.reasons).toContainEqual({kind:'TASK',taskId:null,title:null,eventId:e.id,subjectWorkerId:liam.id,chainIndex:0,event:'ALARM'});
 expect(verifyWakeProof(wake.proof).tasks).toEqual([{eventId:e.id,chainIndex:0}]);
 await M.acknowledgeWakes({}, {proofs:[wake.proof]},ctx(manager.id));
 expect((await db.agentTeamEvent.findUniqueOrThrow({where:{id:e.id}})).acknowledgedAt).toBeNull();
 expect((await pendingTaskWakes(db,[rook.id],now())).get(rook.id)).toBeUndefined();
});
it('alarm acknowledgement stops pending delivery without pretending the subject had a task',async()=>{
 const e=await deliveryAlarm();
 expect((await pendingTaskWakes(db,[rook.id],now())).get(rook.id)).toHaveLength(1);
 await M.acknowledgeAlarm({}, {eventId:e.id},ctx(manager.id));
 expect((await pendingTaskWakes(db,[rook.id],now())).get(rook.id)).toBeUndefined();
});
it('unknown null-task alarm types do not enter the closed delivery arm',async()=>{
 await db.agentTeamEvent.create({data:{appId:app.id,type:'unknown.alarm',severity:'alarm',subjectWorkerId:liam.id,chain:[{workerId:rook.id}]}});
 expect((await pendingTaskWakes(db,[rook.id],now())).size).toBe(0);
});
it('a person-only fallback is visible and acknowledgeable but creates no worker push',async()=>{
 const e=await deliveryAlarm(true);
 expect((await pendingTaskWakes(db,[liam.id,rook.id],now())).size).toBe(0);
 await M.acknowledgeAlarm({}, {eventId:e.id},ctx(manager.id));
 expect((await db.agentTeamEvent.findUniqueOrThrow({where:{id:e.id}})).acknowledgedAt).not.toBeNull();
});
it('a covered S5 anchor stops waking while the retained episode/event remain unchanged',async()=>{
 const e=await deliveryAlarm();
 expect((await pendingTaskWakes(db,[rook.id],now())).get(rook.id)).toHaveLength(1);
 const active=await db.workerDeliveryAlarmEpisode.findUniqueOrThrow({where:{workerId:liam.id}});
 await db.channelReadState.create({data:{workerId:liam.id,channelId:active.channelId,lastSeenSeq:active.anchorSeq}});
 expect((await pendingTaskWakes(db,[rook.id],now())).get(rook.id)).toBeUndefined();
 expect(await db.agentTeamEvent.findUniqueOrThrow({where:{id:e.id}})).toEqual(e);
 expect(await db.workerDeliveryAlarmEpisode.findUniqueOrThrow({where:{workerId:liam.id}})).toEqual(active);
});

it('real GraphQL execution preserves null-task alarm metadata without non-null bubbling or fake refs',async()=>{
 const e=await deliveryAlarm();
 const {makeExecutableSchema}=await import('@graphql-tools/schema');
 const {graphql}=await import('graphql');
 const {typeDefs}=await import('../../api/graphql/schema/typeDefs.js');
 const result=await graphql({schema:makeExecutableSchema({typeDefs,resolvers:resolvers as never}),contextValue:ctx(manager.id),
  source:'query($app:String!){dueWakes(appRef:$app){wakes{reasons{kind task{id title eventId chainIndex event ref subjectWorkerId}}}}}',variableValues:{app:app.id}});
 expect(result.errors).toBeUndefined();
 const answer=JSON.parse(JSON.stringify(result.data));
 expect(answer.dueWakes.wakes[0].reasons[0].task).toEqual({id:null,title:null,eventId:e.id,chainIndex:0,event:'ALARM',ref:`ALARM:${e.id}:0`,subjectWorkerId:liam.id});
});
it('the real MCP due-wakes handler labels a task-less alarm without task null or a fabricated title',async()=>{
 const e=await deliveryAlarm();
 const {createTestableMcpServer}=await import('../../mcp/server.js');
 const server=createTestableMcpServer({userId:manager.id,roles:['READER'],clientId:`user:${manager.id}`},{sessionId:generateId()});
 const answer=await server.callToolText('hadron_due_wakes',{appRef:app.id});
 expect(answer).toContain(`alarm ${e.id}`);
 expect(answer).not.toContain('task null');
 expect(answer).not.toContain('TASK:null');
});
