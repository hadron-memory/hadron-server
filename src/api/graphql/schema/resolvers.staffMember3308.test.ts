/** #3308 / cor:dmo:050:12: staff/member acts need an instruction or the acting worker's own grant. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor, requestActorStorage } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let f: any;
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-18' };
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const answer = async (p: Promise<unknown>) => {
 try { await p; return { code: 'RESOLVED' }; }
 catch (e: any) { return { code: e.extensions?.code, message: e.message }; }
};
const calls: Record<string, (claim?: unknown, c?: Context) => Promise<any>> = {
 cast: (instruction, c = bound()) => M.castWorker({}, { appRef: f.app.id, agentRef: f.agent.id, name: 'NewWorker', noTeam: true, instruction }, c),
 retire: (instruction, c = bound()) => M.retireWorker({}, { workerRef: f.target.id, instruction }, c),
 delete: (instruction, c = bound()) => M.deleteWorker({}, { workerRef: f.target.id, confirmNoExternalAttribution: true, instruction }, c),
 add: (instruction, c = bound()) => M.ensureAppMember({}, { appRef: f.app.id, userRef: f.other.id, role: 'member', instruction }, c),
 remove: (instruction, c = bound()) => M.removeAppMember({}, { appRef: f.app.id, userRef: f.other.id, instruction }, c),
 preview: (instruction, c = bound()) => Q.castWorkerPreview({}, { appRef: f.app.id, agentRef: f.agent.id, name: 'Preview', noTeam: true, instruction }, c),
};
const snapshot = async () => ({
 workers: await db.worker.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
 members: await db.appMember.findMany({ where: { appId: f.app.id }, orderBy: { userId: 'asc' } }),
 events: await db.agentTeamEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } }),
});
const instructionEvents = () => db.agentTeamEvent.findMany({ where: { appId: f.app.id } }).then(es => es.filter(e => (e.payload as any)?.instruction));
beforeEach(async()=>{
 await cleanDb(db);
 const holder=await db.user.create({data:{handle:'staff-holder',roles:['READER']}});
 const other=await db.user.create({data:{handle:'staff-other',roles:['READER']}});
 const org=await db.organization.create({data:{name:'Instruction',urn:'staff3308.test'}});
 await db.orgMember.createMany({data:[{organizationId:org.id,userId:holder.id,role:'CONTRIBUTOR'},{organizationId:org.id,userId:other.id,role:'ADMIN'}]});
 const app=await db.app.create({data:{organizationId:org.id,name:'Team',urn:'staff3308.test:team'}});
 await db.appMember.create({data:{appId:app.id,userId:holder.id,role:'owner'}});
 f={holder,other,org,app};
 const agent=await M.createAgent({}, {orgId:org.id,name:'Current',personaRole:'server-engineer'},ctx({userId:other.id}));
 await db.node.create({data:{memoryId:agent.systemMemoryId,loc:'roles',name:'Roles',nodeType:'info'}});
 const next=await M.createAgent({}, {orgId:org.id,name:'Next',personaRole:'qa-engineer'},ctx({userId:other.id}));
 for(const a of [agent,next]) { await db.appAgent.create({data:{appId:app.id,agentId:a.id}}); await serveAgentBootPrompt(db,a.id,'{{worker.name}} {{worker.role}}'); }
 const worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Caller',slug:'caller',heldByUserId:holder.id}});
 const target=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,appId:app.id,agentId:agent.id,name:'Target',slug:'target'}});
 const session=await db.session.create({data:{id:generateId(),appId:app.id,agentId:agent.id,workerId:worker.id,userId:holder.id,tool:'vitest'}});
 await db.appMember.create({data:{appId:app.id,userId:other.id,role:"reader"}});
 f={...f,agent,next,worker,target,session};
});


describe('#3308 red-first staffing/member narrowing', () => {
 for (const [door, call] of Object.entries(calls)) {
  it(`${door}: headless without a grant is refused and writes nothing`, async () => {
   const before = await snapshot();
   expect((await answer(call())).code).toBe('FORBIDDEN');
   expect(await snapshot()).toEqual(before);
  });
  it(`${door}: a direct person keeps the existing admission`, async () => {
   expect((await answer(call(undefined, ctx()))).code).toBe('RESOLVED');
   expect(await instructionEvents()).toHaveLength(0);
  });
  it(`${door}: a launched worker without a grant is refused even with a claim`, async () => {
   await db.session.update({ where: { id: f.session.id }, data: { launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'manager' } });
   const before = await snapshot();
   expect((await answer(call(live))).code).toBe('FORBIDDEN');
   expect(await snapshot()).toEqual(before);
  });
 }
 for (const door of ['cast', 'retire', 'delete', 'add', 'remove']) {
  it(`${door}: a valid instruction needs no grant and is recorded with both principals`, async () => {
   await calls[door](live);
   const events = await instructionEvents();
   expect(events).toHaveLength(1);
   expect(events[0]).toMatchObject({ actorUserId: f.holder.id, actorWorkerId: f.worker.id, actorAgentId: f.agent.id });
   expect(events[0].payload).toMatchObject({ instruction: live });
  });
 }
 for (const door of ['add', 'remove']) it(`${door}: refused headless worker cannot resolve a real or missing target`, async () => {
  const method = door === 'add' ? M.ensureAppMember : M.removeAppMember;
  const invoke = (userRef: string) => answer(method({}, { appRef: f.app.id, userRef, role: 'member' }, bound()));
  const before = await snapshot();
  const real = await invoke(f.other.id);
  expect(real.code).toBe('FORBIDDEN');
  expect(await invoke(generateId())).toEqual(real);
  expect(await snapshot()).toEqual(before);
 });
 it('self-leave is refused for a headless worker without app.members', async () => {
  const before = await snapshot();
  expect((await answer(M.removeAppMember({}, { appRef: f.app.id, userRef: f.holder.id }, bound()))).code).toBe('FORBIDDEN');
  expect(await snapshot()).toEqual(before);
 });
 it('direct person self-leave stays admitted', async () => {
  expect(await M.removeAppMember({}, { appRef: f.app.id, userRef: f.holder.id }, ctx())).toBe(true);
 });
 it('no-op updateWorker is not narrowed by workers.staff', async () => {
  expect((await answer(M.updateWorker({}, { workerRef: f.target.id }, bound()))).code).toBe('RESOLVED');
 });
 it('S1 signature path still refuses a workers.staff-less worker without instruction', async () => {
  expect((await answer(M.updateWorker({}, { workerRef: f.target.id, signature: 'New signature' }, bound()))).code).toBe('FORBIDDEN');
 });
 it('SDL exposes instruction at the staffing/member doors and both new grant names', () => {
  const schema = buildSchema(typeDefs);
  for (const name of ['castWorker', 'retireWorker', 'deleteWorker', 'ensureAppMember', 'removeAppMember']) {
   expect(schema.getMutationType()!.getFields()[name].args.map(a => a.name)).toContain('instruction');
  }
  expect(schema.getQueryType()!.getFields().castWorkerPreview.args.map(a => a.name)).toContain('instruction');
  const names = (schema.getType('AppGrantName') as any).getValues().map((v: any) => v.name);
  expect(names).toContain('WORKERS_STAFF'); expect(names).toContain('APP_MEMBERS');
 });
});

const grantName = (door: string) => door === 'add' || door === 'remove' ? 'APP_MEMBERS' : 'WORKERS_STAFF';
const give = (door: string, workerId = f.worker.id, name = grantName(door)) => M.grantApp({}, { appRef: f.app.id, workerRef: workerId, name }, ctx());

describe('#3308 grant identity and holder ceiling', () => {
 for (const [door, call] of Object.entries(calls)) {
  it(`${door}: matching live grant admits headless but adds no instruction claim`, async () => {
   await give(door);
   expect((await answer(call())).code).toBe('RESOLVED');
   expect(await instructionEvents()).toHaveLength(0);
  });
  it(`${door}: host-launched matching grant is headless despite a claim`, async () => {
   await give(door);
   await db.session.update({ where: { id: f.session.id }, data: { launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'manager' } });
   expect((await answer(call(live))).code).toBe('RESOLVED');
   expect(await instructionEvents()).toHaveLength(0);
  });
  for (const mismatch of ['wrong-name', 'other-worker', 'revoked', 'foreign-app'] as const) {
   it(`${door}: ${mismatch} grant refuses without writes`, async () => {
    if (mismatch === 'foreign-app') {
     const app = await db.app.create({ data: { organizationId: f.org.id, name: 'Other', urn: 'staff3308.test:other' } });
     await db.appMember.create({ data: { appId: app.id, userId: f.holder.id, role: 'owner' } });
     const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: f.agent.id, name: 'Foreign', slug: 'foreign', heldByUserId: f.holder.id } });
     await M.grantApp({}, { appRef: app.id, workerRef: worker.id, name: grantName(door) }, ctx());
    } else {
     const row = await give(door, mismatch === 'other-worker' ? f.target.id : f.worker.id,
      mismatch === 'wrong-name' ? (grantName(door) === 'APP_MEMBERS' ? 'WORKERS_STAFF' : 'APP_MEMBERS') : grantName(door));
     if (mismatch === 'revoked') await M.revokeAppGrant({}, { appRef: f.app.id, workerRef: f.worker.id, name: grantName(door) }, ctx());
     expect(row.id).toBeTruthy();
    }
    const before = await snapshot();
    expect((await answer(call())).code).toBe('FORBIDDEN');
    expect(await snapshot()).toEqual(before);
   });
  }
  it(`${door}: a grant never widens a reader holder's rights`, async () => {
   await give(door);
   await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'READER' } });
   await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'reader' } });
   const direct = await answer(call(undefined, ctx()));
   const before = await snapshot();
   expect((await answer(call())).code).toBe('FORBIDDEN');
   expect(await answer(call())).toEqual(direct);
   expect(await snapshot()).toEqual(before);
  });
  for (const binding of ['unbound', 'ambiguous', 'refused', 'other-holder', 'retired', 'ended'] as const) {
   it(`${door}: grant does not repair an invalid ${binding} binding`, async () => {
    await give(door);
    let c = bound();
    if (binding === 'unbound') await db.session.update({ where: { id: f.session.id }, data: { workerId: null } });
    if (binding === 'refused') c = bound({ sessionBindingRefused: true });
    if (binding === 'other-holder') await db.worker.update({ where: { id: f.worker.id }, data: { heldByUserId: f.other.id } });
    if (binding === 'retired') await db.worker.update({ where: { id: f.worker.id }, data: { retiredAt: new Date() } });
    if (binding === 'ended') await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
    const before = await snapshot();
    const invoke = () => call(undefined, c);
    const got = await answer(binding === 'ambiguous' ? requestActorStorage.run({ workerId: null, agentId: null, ambiguousSessionIds: ['one', 'two'] }, invoke) : binding === 'unbound' ? runAsActor({ workerId: f.worker.id, agentId: f.agent.id }, invoke) : invoke());
    expect(got.code).toBe('FORBIDDEN');
    expect(await snapshot()).toEqual(before);
   });
  }
 }
 for (const door of ['cast', 'retire']) it(`${door}: revocation on the act transaction is observed before writing`, async () => {
  await give(door);
  const client = new Proxy(db, { get(target, key) {
   if (key === '$transaction') return (callback: any, options: any) => db.$transaction(async tx => {
    await tx.appGrant.updateMany({ where: { appId: f.app.id, granteeWorkerId: f.worker.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return callback(tx);
   }, options);
   const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const before = await snapshot();
  expect((await answer(calls[door](undefined, bound({ db: client })))).code).toBe('FORBIDDEN');
  expect(await snapshot()).toEqual(before);
 });
 for (const mode of ['instruction', 'grant'] as const) it(`self-leave admits on ${mode}`, async () => {
  if (mode === 'grant') await give('remove');
  await M.removeAppMember({}, { appRef: f.app.id, userRef: f.holder.id, instruction: mode === 'instruction' ? live : undefined }, bound());
  expect(await db.appMember.findUnique({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } } })).toBeNull();
  expect(await instructionEvents()).toHaveLength(mode === 'instruction' ? 1 : 0);
 });
});

describe('#3308 instructed previews and idempotent calls have one claim, not a repeated act', () => {
 it('preview with an instruction records once but allocates no worker', async () => {
  const count = await db.worker.count({ where: { appId: f.app.id } });
  await calls.preview(live);
  expect(await db.worker.count({ where: { appId: f.app.id } })).toBe(count);
  expect(await instructionEvents()).toHaveLength(1);
 });
 for (const door of ['add', 'remove', 'retire']) it(`${door}: admitted instructed no-op writes one separate claim`, async () => {
  await calls[door](undefined, ctx());
  const before = await snapshot();
  await calls[door](live);
  const after = await snapshot();
  expect(after.workers).toEqual(before.workers);
  const memberState = (rows: typeof after.members) => rows.map(({ appId, userId, role }) => ({ appId, userId, role }));
  expect(memberState(after.members)).toEqual(memberState(before.members));
  expect(await instructionEvents()).toHaveLength(1);
  expect(after.events.filter(e => e.type === 'member.added' || e.type === 'member.role-changed' || e.type === 'member.removed' || e.type === 'worker.retired')).toEqual(
   before.events.filter(e => e.type === 'member.added' || e.type === 'member.role-changed' || e.type === 'member.removed' || e.type === 'worker.retired'));
 });
});

for (const door of ['cast', 'retire', 'delete', 'add', 'remove', 'preview']) it(`#3308 ${door}: final recheck sees a transaction-local revocation after worker locking`, async () => {
 await give(door);
 let revoked = false;
 const client = new Proxy(db, { get(target, key) {
  if (key === '$transaction') return (callback: any, options: any) => db.$transaction(async tx => callback(new Proxy(tx, { get(t, k) {
   if (k === '$queryRaw') return async (query: any, ...values: any[]) => {
    const sql = Array.isArray(query) ? query.join('?') : query.sql;
    const value = await (t.$queryRaw as any)(query, ...values);
    if (!revoked && /FROM workers[\s\S]*FOR UPDATE/.test(sql)) {
     revoked = true;
     await t.appGrant.updateMany({ where: { appId: f.app.id, granteeWorkerId: f.worker.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return value;
   };
   const value = (t as any)[k]; return typeof value === 'function' ? value.bind(t) : value;
  } })), options);
  const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
 } });
 const before = await snapshot();
 expect((await answer(calls[door](undefined, bound({ db: client })))).code).toBe('FORBIDDEN');
 expect(revoked).toBe(true);
 expect(await snapshot()).toEqual(before);
});

for (const [door, call] of Object.entries(calls)) for (const shape of ['app-key', 'impersonation', 'run'] as const) {
 it(`#3308 ${door}: a matching grant does not repair the ${shape} principal`, async () => {
  await give(door);
  const c = shape === 'app-key' ? { db, appId: f.app.id, appKeyId: generateId(), roles: [] } as Context
   : shape === 'impersonation' ? bound({ impersonation: { sessionId: generateId(), actorUserId: f.other.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } } as any)
   : bound({ clientId: 'run:fixture', appId: f.app.id });
  const before = await snapshot();
  expect((await answer(call(live, c))).code).toBe('FORBIDDEN');
  expect(await snapshot()).toEqual(before);
 });
}

it('#3308 instructed retirement no-op records do not turn bookkeeping into external use', async () => {
 await calls.retire(live);
 await calls.retire(live);
 expect(await instructionEvents()).toHaveLength(2);
 expect(await M.deleteWorker({}, { workerRef: f.target.id, confirmNoExternalAttribution: true }, ctx())).toBe(true);
});

// #3308: stable preflight principals and fail-closed session projections.
it('#3308 admission stability database refuses a persisted workerless launched session', async () => {
 await expect(db.session.update({ where: { id: f.session.id }, data: { workerId: null, launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'manager' } })).rejects.toThrow('chk_sessions_launch');
 expect((await db.session.findUniqueOrThrow({ where: { id: f.session.id } })).workerId).toBe(f.worker.id);
});
for (const door of Object.keys(calls)) it(`#3308 admission stability ${door}: a corrupted launched-session projection never falls back to person`, async () => {
 // A real workerless launch is CHECK-rejected above; corrupt only the read projection to pin defensive admission.
 await db.session.update({ where: { id: f.session.id }, data: { launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'manager' } });
 const wrap = (client: any): any => new Proxy(client, { get(target, key) {
  if (key === '$transaction' && typeof target.$transaction === 'function') return (callback: any, options: any) => target.$transaction((tx: any) => callback(wrap(tx)), options);
  if (key === 'session') return new Proxy(target.session, { get(delegate, field) {
   if (field === 'findUnique') return async (query: any) => {
    const row = await delegate.findUnique(query);
    return query.where.id === f.session.id && row ? { ...row, workerId: null } : row;
   };
   const value = delegate[field]; return typeof value === 'function' ? value.bind(delegate) : value;
  } });
  const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
 } });
 const before = await snapshot();
 expect((await answer(calls[door](live, bound({ db: wrap(db) })))).code).toBe('FORBIDDEN');
 expect(await snapshot()).toEqual(before);
});
for (const door of ['cast', 'preview']) it(`#3308 admission stability ${door}: transaction session substitution cannot replace the preflight worker`, async () => {
 await db.worker.update({ where: { id: f.target.id }, data: { heldByUserId: f.holder.id } });
 await give(door); await give(door, f.target.id);
 const client = new Proxy(db, { get(target, key) {
  if (key === '$transaction') return (callback: any, options: any) => db.$transaction(async tx => {
   await tx.session.update({ where: { id: f.session.id }, data: { workerId: f.target.id } });
   return callback(tx);
  }, options);
  const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
 } });
 const before = await snapshot();
 expect((await answer(calls[door](undefined, bound({ db: client })))).code).toBe('FORBIDDEN');
 expect(await snapshot()).toEqual(before);
});

it('#3308 admission stability cast: ownership drift after the deciding membership lock keeps the typed retry', async () => {
 const otherOrg = await db.organization.create({ data: { name: 'Moved', urn: 'staff3308.test:moved' } });
 let changed = false;
 const client = new Proxy(db, { get(target, key) {
  if (key === '$transaction') return (callback: any, options: any) => db.$transaction(async tx => callback(new Proxy(tx, { get(t, k) {
   if (k === '$queryRaw') return async (query: any, ...values: any[]) => {
    const sql = Array.isArray(query) ? query.join('?') : query.sql;
    const value = await (t.$queryRaw as any)(query, ...values);
    if (!changed && /FROM app_members[\s\S]*FOR SHARE/.test(sql)) {
     changed = true;
     await t.app.update({ where: { id: f.app.id }, data: { organizationId: otherOrg.id } });
    }
    return value;
   };
   const value = (t as any)[k]; return typeof value === 'function' ? value.bind(t) : value;
  } })), options);
  const value = (target as any)[key]; return typeof value === 'function' ? value.bind(target) : value;
 } });
 const before = await snapshot();
 expect((await answer(calls.cast(undefined, ctx({ db: client })))).code).toBe('CAST_TARGET_CHANGED');
 expect(changed).toBe(true);
 expect(await snapshot()).toEqual(before);
 expect((await db.app.findUniqueOrThrow({ where: { id: f.app.id } })).organizationId).toBe(f.org.id);
});


describe('#3308 leaveApp self-leave narrowing', () => {
 it('own app.members grant admits worker cleanup without an instruction claim', async () => {
  await give('remove');
  await M.leaveApp({}, {appId:f.app.id}, bound());
  expect(await db.appMember.findUnique({where:{appId_userId:{appId:f.app.id,userId:f.holder.id}}})).toBeNull();
  expect(await instructionEvents()).toHaveLength(0);
 });
 it('instructed repeated cleanup records the no-op claim', async () => {
  await db.appMember.delete({where:{appId_userId:{appId:f.app.id,userId:f.holder.id}}});
  await M.leaveApp({}, {appId:f.app.id,instruction:live}, bound());
  expect(await instructionEvents()).toHaveLength(1);
 });

 it('grantless bound worker refuses and retains membership', async () => {
  const before = await snapshot();
  expect((await answer(M.leaveApp({}, {appId:f.app.id}, bound()))).code).toBe('FORBIDDEN');
  expect(await snapshot()).toEqual(before);
 });
 it('instructed bound worker records the self-removal', async () => {
  await M.leaveApp({}, {appId:f.app.id,instruction:live}, bound());
  expect(await db.appMember.findUnique({where:{appId_userId:{appId:f.app.id,userId:f.holder.id}}})).toBeNull();
  expect(await instructionEvents()).toHaveLength(1);
 });
 it('direct person retains self-service cleanup', async () => {
  await M.leaveApp({}, {appId:f.app.id}, ctx());
  expect(await db.appMember.findUnique({where:{appId_userId:{appId:f.app.id,userId:f.holder.id}}})).toBeNull();
  expect(await instructionEvents()).toHaveLength(0);
 });
});


describe('#3308 App reader with independent org staffing authority', () => {
 for (const door of ['cast','preview','retire','delete']) {
  for (const mode of ['person','worker'] as const) it(`${door}: ${mode} retains org CONTRIBUTOR right with App reader role`, async () => {
   if (mode === 'worker') await give(door);
   await db.appMember.update({where:{appId_userId:{appId:f.app.id,userId:f.holder.id}},data:{role:'reader'}});
   expect((await answer(calls[door](undefined,mode === 'person' ? ctx() : bound()))).code).toBe('RESOLVED');
  });
 }
});
