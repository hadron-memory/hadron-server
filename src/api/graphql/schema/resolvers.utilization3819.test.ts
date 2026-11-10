/** #3819 count/ranked slice: V1–V5, optimistic availability and roster admission. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { registerHost } from '../../../lib/agentTasks/hosts.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);
let appId: string, agentId: string, memberId: string, outsiderId: string;
const ctx = (userId = memberId): Context => ({ db, userId, roles: ['READER'] });
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Utilization', urn: `util-${generateId()}.test` } });
  const admin = await db.user.create({ data: { handle: `ua-${generateId()}` } });
  memberId = (await db.user.create({ data: { handle: `um-${generateId()}` } })).id;
  outsiderId = (await db.user.create({ data: { handle: `uo-${generateId()}` } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Utilization Agent' }, ctx(admin.id))).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Utilization', urn: `util-${generateId()}.test:team` } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'member' } });
});
async function worker(opts: { family?: string; model?: string | null; role?: string; unbound?: boolean } = {}) {
  const id = generateId();
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId, agentId, name: `Worker-${id}`, slug: `worker-${id}`, role: opts.role ?? 'server-engineer' } });
  if (!opts.unbound) await db.session.create({ data: { id: generateId(), appId, agentId, workerId: id, family: opts.family ?? 'claude', llmModel: opts.model === undefined ? 'claude-sonnet-5-5' : opts.model, startedAt: ago(48), updatedAt: ago(48) } });
  return id;
}
async function task(workerId: string, extra: Record<string, unknown> = {}) {
  return db.agentTask.create({ data: { appId, title: 'Synthetic task', ownerUserId: memberId, assigneeWorkerId: workerId, assignedAt: ago(48), createdAt: ago(48), ...extra } });
}
async function read(args: Record<string, unknown> = {}, c = ctx()) {
  expect(typeof Q.teamUtilization, '#3819 API field exists').toBe('function');
  return Q.teamUtilization({}, { appRef: appId, ...args }, c);
}
describe('#3819 utilization count/ranked slice', () => {
  it('four eligible, three busy: 0.75; never-assigned and quiet bound workers remain eligible', async () => {
    const ids = await Promise.all([worker(), worker(), worker(), worker()]);
    await Promise.all(ids.slice(0, 3).map(w => task(w)));
    const r = await read();
    expect(r.windowHours).toBe(24);
    expect(r.combinations).toEqual([{ family: 'claude', tier: 'mid', role: 'server-engineer', eligibleWorkers: 4, busyWorkers: 3, utilization: 0.75, saturated: false }]);
  });
  it('finished inside the window counts; earlier finished and mere activity do not', async () => {
    const [a,b,c] = await Promise.all([worker(),worker(),worker()]);
    await task(a, { status:'finished', startedAt:ago(3), finishedAt:ago(2), resultOutcome:'done' });
    await task(b, { status:'finished', startedAt:ago(30), finishedAt:ago(25), resultOutcome:'done' });
    await db.agentTeamEvent.create({ data:{ appId, type:'task.progress', actorWorkerId:c, createdAt:ago(1), payload:{} } });
    expect((await read()).combinations[0]).toMatchObject({eligibleWorkers:3,busyWorkers:1,utilization:1/3});
    expect((await read({windowHours:1})).combinations[0].busyWorkers).toBe(0);
  });
  it('assignment, reassignment-away and hand-back in the window retain former task holders', async () => {
    const [a,b,c] = await Promise.all([worker(),worker(),worker()]);
    await db.agentTeamEvent.createMany({ data:[
      {appId,type:'task.reassigned',subjectWorkerId:b,createdAt:ago(1),payload:{from:{workerId:a},to:{workerId:b}}},
      {appId,type:'task.handed-back',actorWorkerId:c,createdAt:ago(1),payload:{code:'missing_input'}},
    ]});
    expect((await read()).combinations[0]).toMatchObject({eligibleWorkers:3,busyWorkers:3,utilization:1});
  });
  it('retired and effective unavailable workers do not enter either count; lapsed marks do', async () => {
    const [a,b,c,d] = await Promise.all([worker(),worker(),worker(),worker()]);
    await db.worker.update({where:{id:a},data:{retiredAt:new Date()}});
    await db.workerAvailability.createMany({data:[
      {workerId:b,state:'unavailable',reason:'other',setBy:'worker',setAt:ago(2)},
      {workerId:c,state:'unavailable',reason:'other',setBy:'worker',setAt:ago(2),until:ago(1)},
    ]});
    await Promise.all([a,b,c,d].map(w=>task(w)));
    expect((await read()).combinations[0]).toMatchObject({eligibleWorkers:2,busyWorkers:2,utilization:1});
  });
  it('family unavailability leaves an observed combination with zero eligible and utilization one', async () => {
    await worker();
    await db.modelFamilyAvailability.create({data:{appId,family:'claude',state:'unavailable',reason:'other',setByUserId:memberId,setAt:ago(1)}});
    expect((await read()).combinations[0]).toMatchObject({eligibleWorkers:0,busyWorkers:0,utilization:1,saturated:true});
  });
  it('a launchable unbound worker enters every live registered family, with null tier', async () => {
    const id = await worker({unbound:true});
    for (const family of ['codex','glm']) await registerHost(db,{appId,hostId:`util-host-${family}`,label:'Util host',pollIntervalSeconds:60,workers:[{workerId:id,family,worktrees:['repo/worker']}]});
    const r = await read();
    expect(r.combinations.map((x:any)=>[x.family,x.tier,x.eligibleWorkers])).toEqual([['codex',null,1],['glm',null,1]]);
  });
  it('filters narrow combinations and ties sort by count then family/tier/role', async () => {
    const a=await worker({family:'codex',model:'gpt-6.1-sol'});
    await task(a);
    await worker({role:'qa-engineer'});
    await worker({role:'qa-engineer'});
    await worker({role:'server-engineer'});
    const r=await read();
    expect(r.combinations.map((x:any)=>[x.family,x.role])).toEqual([['codex','server-engineer'],['claude','server-engineer'],['claude','qa-engineer']]);
    expect((await read({family:'claude',tier:'mid',role:'qa-engineer'})).combinations).toHaveLength(1);
    expect((await read({family:'glm'})).combinations).toEqual([]);
  });
  it.each([0,169])('refuses windowHours %s after roster admission',async windowHours=>{
    await expect(read({windowHours})).rejects.toMatchObject({extensions:{code:'BAD_USER_INPUT'}});
  });
  it('an outsider and a foreign App receive exactly the roster refusal',async()=>{
    for (const c of [ctx(outsiderId),ctx()]) {
      const args={appRef:c.userId===outsiderId?appId:generateId()};
      const capture=async(f:()=>Promise<unknown>)=>f().then(()=>null,(e:any)=>({message:e.message,extensions:e.extensions}));
      expect(await capture(()=>read(args,c))).toEqual(await capture(()=>Q.teamRoster({},args,c)));
    }
  });
  it('a foreign-App assignment event cannot make a local worker busy',async()=>{
    const id=await worker();
    const other=await db.app.create({data:{name:'Other',urn:`util-${generateId()}.test:other`,ownerUserId:memberId}});
    await db.agentTeamEvent.create({data:{appId:other.id,type:'task.assigned',subjectWorkerId:id,payload:{assignee:{workerId:id}}}});
    expect((await read()).combinations[0].busyWorkers).toBe(0);
  });
});
