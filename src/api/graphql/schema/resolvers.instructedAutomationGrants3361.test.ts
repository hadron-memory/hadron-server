import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { requestActorStorage } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { GRANT_SUBSCRIBE_WORKERS } from '../../../lib/tickers/bounds.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const A = resolvers.App as any;
let f: any;
const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-17' };
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: f.holder.id, roles: ['READER'], ...extra });
const bound = (extra: Partial<Context> = {}) => ctx({ sessionId: f.session.id, ...extra });
const answer = async (p: Promise<unknown>) => { try { await p; return { code: 'RESOLVED' }; } catch (e: any) { return { code: e.extensions?.code, message: e.message }; } };
const instructionEvents = () => db.agentTeamEvent.findMany({ where: { appId: f.app.id }, orderBy: { id: 'asc' } })
  .then((es) => es.filter((e) => (e.payload as any)?.instruction));
const snapshot = async () => ({
  readGrants: await db.appAutomationReadGrant.findMany({orderBy:{id:'asc'}}),
  teamGrants: await db.appAutomationTeamSnapshotGrant.findMany({orderBy:{id:'asc'}}),
  readEvents: await db.appAutomationReadGrantEvent.findMany({orderBy:{id:'asc'}}),
  teamEvents: await db.appAutomationTeamSnapshotGrantEvent.findMany({orderBy:{id:'asc'}}),
  scopes: await db.appKeyScope.findMany({ orderBy: { id: 'asc' } }),
  grants: await db.appGrant.findMany({ orderBy: { id: 'asc' } }),
  writeGrants: await db.appMemoryWriteGrant.findMany({ orderBy: { id: 'asc' } }),
  events: await db.agentTeamEvent.findMany({ orderBy: { id: 'asc' } }),
});

const revokes: Record<string, (instruction?: unknown,c?:Context)=>Promise<any>> = {
 read:(instruction=live,c=bound())=>M.revokeAutomationReadGrant({}, {id:f.readGrant.id,instruction},c),
 team:(instruction=live,c=bound())=>M.revokeAutomationTeamSnapshotGrant({}, {id:f.teamGrant.id,instruction},c),
};
const lists: Record<string, (instruction?: unknown,c?:Context)=>Promise<any>> = {
 readList:(instruction=live,c=bound())=>Q.automationReadGrants({}, {appRef:f.app.id,instruction},c),
 teamList:(instruction=live,c=bound())=>Q.automationTeamSnapshotGrants({}, {appRef:f.app.id,instruction},c),
};
const doors={...revokes,...lists};
const isList=(door:string)=>door in lists;
beforeEach(async () => {
  await cleanDb(db);
  const holder = await db.user.create({ data: { handle: 'cred-holder', roles: ['READER'] } });
  const other = await db.user.create({ data: { handle: 'cred-other', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Cred', urn: 'cred3311.test' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: holder.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: other.id, role: 'ADMIN' },
  ] });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'cred3311.test:team' } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: 'cred3311.test:agent', name: 'Agent' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Caller', slug: 'caller', heldByUserId: holder.id } });
  const target = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Target', slug: 'target' } });
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
  const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'abcd', label: 'K' } });
  await db.appKeyScope.create({ data: { id: generateId(), appKeyId: key.id, scope: 'attention:deliver', grantedByUserId: holder.id } });
  await db.appGrant.create({ data: { appId: app.id, granteeWorkerId: target.id, name: GRANT_SUBSCRIBE_WORKERS, grantedBy: holder.id } });
  const mem = await db.memory.create({ data: { name: 'dest', urn: 'cred3311.test:dest', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never });
  const writeGrant = await db.appMemoryWriteGrant.create({ data: { appId: app.id, memoryId: mem.id, prefix: 'reports:x', grantedBy: holder.id } });
  const schedule = await db.agentSchedule.create({data:{id:generateId(),organizationId:org.id,appId:app.id,name:'grant',cron:'* * * * *',entryNodeUrn:'hrn:node:cred3311.test:flows:main'}});
  const readGrant = await db.appAutomationReadGrant.create({data:{appId:app.id,triggerKind:'SCHEDULE',triggerId:schedule.id,memoryId:mem.id,grantedBy:holder.id}});
  const teamGrant = await db.appAutomationTeamSnapshotGrant.create({data:{appId:app.id,triggerKind:'SCHEDULE',triggerId:schedule.id,grantedBy:holder.id}});
  f = { holder, other, org, app, agent, worker, target, session, key, mem, writeGrant, schedule, readGrant, teamGrant };
});

describe('#3361 instructed automation grants',()=>{
  for (const [door, call] of Object.entries(doors)) {
    it(`${door}: an owner-role holder's instruction is admitted${isList(door) ? ' and writes one record per call' : ' with exactly one attributed record'}`, async () => {
      await call();
      const es = await instructionEvents();
      expect(es).toHaveLength(1);
      expect(es[0]).toMatchObject({ actorUserId: f.holder.id, actorWorkerId: f.worker.id });
      expect((es[0].payload as any).instruction).toEqual(live);
      if (isList(door)) { await call(); expect(await instructionEvents()).toHaveLength(2); }
    });
    it(`${door}: an org ADMIN holder's instruction is admitted`, async () => {
      await db.appMember.deleteMany({ where: { appId: f.app.id, userId: f.holder.id } });
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.holder.id } }, data: { role: 'ADMIN' } });
      await call();
      expect(await instructionEvents()).toHaveLength(1);
    });
    it(`${door}: a direct person writes no instruction record`, async () => {
      await call(null, ctx());
      expect(await instructionEvents()).toHaveLength(0);
    });
    it(`${door}: the record names the act and carries no key, scope or grant id`, async () => {
      await call();
      const [e] = await instructionEvents();
      const text = JSON.stringify(e.payload) + JSON.stringify(e);
      for (const id of [f.key.id, f.writeGrant.id, f.mem.id, f.target.id]) expect(text).not.toContain(id);
      expect(text).not.toContain('attention:deliver');
    });
    for (const kind of ['no-instruction', 'host-launch', 'unheld', 'other-holder', 'ended-session', 'retired-worker', 'plain-member', 'impersonation', 'app-key', 'refused-binding', 'ambiguous', 'run'] as const) {
      it(`${door}: ${kind} is refused and writes nothing`, async () => {
        let c = bound(); let claim: unknown = live;
        if (kind === 'no-instruction') claim = null;
        if (kind === 'host-launch') await db.session.update({ where: { id: f.session.id }, data: { launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'manager' } });
        if (kind === 'unheld' || kind === 'other-holder') await db.worker.update({ where: { id: f.worker.id }, data: { heldByUserId: kind === 'unheld' ? null : f.other.id } });
        if (kind === 'ended-session') await db.session.update({ where: { id: f.session.id }, data: { endedAt: new Date() } });
        if (kind === 'retired-worker') await db.worker.update({ where: { id: f.worker.id }, data: { retiredAt: new Date() } });
        if (kind === 'plain-member') await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
        if (kind === 'impersonation') c = bound({ impersonation: { sessionId: generateId(), actorUserId: f.other.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } } as any);
        if (kind === 'app-key') c = { db, appId: f.app.id, roles: [] } as Context;
        if (kind === 'refused-binding') c = bound({ sessionBindingRefused: true });
        if (kind === 'run') c = bound({ clientId: 'run:test', appId: f.app.id });
        const before = await snapshot();
        const invoke = () => call(claim, c);
        const got = await answer(kind === 'ambiguous' ? requestActorStorage.run({ workerId: null, agentId: null, ambiguousSessionIds: ['a', 'b'] }, invoke) : invoke());
        expect(got.code).toBe('FORBIDDEN');
        expect(got.code).toBeDefined(); // a refusal, never a crash
        expect(await snapshot()).toEqual(before);
      });
    }
    it(`${door}: a holder who does not manage the App gets that holder's own refusal, byte-identical`, async () => {
      await db.appMember.update({ where: { appId_userId: { appId: f.app.id, userId: f.holder.id } }, data: { role: 'member' } });
      const before = await snapshot();
      const worker = await answer(call(live, bound()));
      const person = await answer(call(null, ctx()));
      expect(worker).toEqual(person);
      expect(worker.code).not.toBe('RESOLVED');
      expect(await snapshot()).toEqual(before);
    });
  }


  for(const [name,call] of Object.entries(revokes)) it(`${name} repeated revoke is terminal and records once`,async()=>{
    await call(); const before=await snapshot(); await call(); expect(await snapshot()).toEqual(before);
  });
  for(const [name,call] of Object.entries(lists)) it(`${name} empty admitted list records once`,async()=>{
    await db.appAutomationReadGrant.updateMany({data:{revokedAt:new Date(),revokedBy:f.holder.id}});
    await db.appAutomationTeamSnapshotGrant.updateMany({data:{revokedAt:new Date(),revokedBy:f.holder.id}});
    const out=await call(); expect(Array.isArray(out)?out:out.items).toEqual([]); expect(await instructionEvents()).toHaveLength(1);
  });
  it('memory-only instructed list is bound to worker App; direct target manager keeps other-App reach',async()=>{
    await db.appMember.deleteMany({where:{appId:f.app.id,userId:f.holder.id}});
    await db.orgMember.update({where:{organizationId_userId:{organizationId:f.org.id,userId:f.holder.id}},data:{role:'ADMIN'}});
    const app=await db.app.create({data:{organizationId:f.org.id,name:'Other',urn:'cred3311.test:other'}});
    const grant=await db.appAutomationReadGrant.create({data:{appId:app.id,triggerKind:'SCHEDULE',triggerId:generateId(),memoryId:f.mem.id,grantedBy:f.holder.id}});
    const out=await Q.automationReadGrants({}, {memoryRef:f.mem.id,instruction:live},bound());
    expect(out.map((r:any)=>r.id)).toEqual([f.readGrant.id]);
    expect((await Q.automationReadGrants({}, {memoryRef:f.mem.id},ctx())).map((r:any)=>r.id)).toContain(grant.id);
    const before=await snapshot();
    expect((await answer(Q.automationReadGrants({}, {appRef:app.id,instruction:live},bound()))).code).toBe('FORBIDDEN');
    expect((await answer(M.revokeAutomationReadGrant({}, {id:grant.id,instruction:live},bound()))).code).toBe('FORBIDDEN');
    expect(await snapshot()).toEqual(before);
    await M.revokeAutomationReadGrant({}, {id:grant.id},ctx());
  });

});
