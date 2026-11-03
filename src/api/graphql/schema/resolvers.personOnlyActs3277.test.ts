/**
 * #3277 (S3a of #2483; rulings 0098 A and 0099 A; hrn:node:hadronmemory.com:specs:cor:dmo:050:12): minting and
 * rotating an App key, and giving a grant, are PERSON-ONLY acts. Every one of those doors is on the one person gate
 * (`requirePersonOnlyAct` → `requirePersonAsThemselves`), so a worker session in any shape is refused there, even one
 * whose holder manages the App:
 *  - a bound worker (the request's published actor, the header binding);
 *  - a worker session found only on the session row (`ctx.sessionId`);
 *  - an ambiguous MCP actor (several live worker bindings, none named);
 *  - a refused session binding;
 *  - an impersonated request;
 *  - a run principal carrying the manager's user id;
 *  - an App key.
 *
 * Each refusal is the door's OWN existing answer, byte for byte, and writes nothing: no key, no scope row, no grant
 * row, no raw secret. A class that main already refused at an earlier gate keeps that earlier answer (pinned below
 * as the door's answer on main). A person who manages the App still succeeds at every door (regression pins).
 *
 * Out of scope (S3b, waits on S1): listing keys, revokeAppKey, and every REVOKE door: they keep today's answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { RUN_CLIENT_PREFIX } from '../../../lib/auth/runPrincipal.js';
import { requestActorStorage, runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

type F = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const mgr = await db.user.create({ data: { id: generateId(), handle: 'po-mgr', name: 'Mgr', roles: ['READER'] as never } });
  const org = await db.organization.create({ data: { id: generateId(), name: 'PO Org', urn: 'po3277.test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: mgr.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'PO App', urn: 'po3277.test:app' } });
  await db.appMember.create({ data: { appId: app.id, userId: mgr.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'PO Agent', urn: 'po3277.test:agent' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  // The manager holds both workers: a worker whose holder manages the App is still refused (acceptance 2).
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'PO Worker', slug: 'po-worker', heldByUserId: mgr.id } });
  const target = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'PO Target', slug: 'po-target', heldByUserId: mgr.id } });
  const workerSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: mgr.id, tool: 'vitest' } });
  const personSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, userId: mgr.id, tool: 'vitest' } });
  const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'hdr_app_x...0000', label: 'existing' } });
  const dest = await db.memory.create({ data: { name: 'dest', urn: 'po3277.test:dest', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never });
  const schedule = await db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, name: 'S', cron: '* * * * *', entryNodeUrn: 'hrn:node:example.com:m:flows:entry' } });
  return { mgr, org, app, agent, worker, target, workerSession, personSession, key, dest, schedule };
}

let f: F;
beforeEach(async () => { await cleanDb(db); f = await fixture(); });

const person = (extra: Record<string, unknown> = {}) => ({ db, userId: f.mgr.id, roles: ['READER'], ...extra }) as unknown as Context;

/** The seven non-person shapes; each runs the door call inside its own actor scope. */
const CLASSES: Record<string, (call: (c: Context) => Promise<unknown>) => Promise<unknown>> = {
  boundWorker: (call) => runAsActor({ workerId: f.worker.id, agentId: f.agent.id }, () => call(person())),
  sessionRowWorker: (call) => call(person({ sessionId: f.workerSession.id })),
  ambiguousActor: (call) => requestActorStorage.run({ workerId: null, agentId: null, ambiguousSessionIds: ['s1', 's2'] }, () => call(person())),
  refusedBinding: (call) => call(person({ sessionBindingRefused: true })),
  impersonation: (call) => call(person({ impersonation: { sessionId: generateId(), actorUserId: f.mgr.id, orgId: f.org.id, expiresAt: new Date('2099-01-01') } })),
  runPrincipal: (call) => call(person({ clientId: `${RUN_CLIENT_PREFIX}${generateId()}`, appId: f.app.id, organizationId: f.org.id })),
  appKey: (call) => call({ db, appId: f.app.id, appKeyId: f.key.id, organizationId: f.org.id, roles: [] } as unknown as Context),
};

/** Everything a door could write: compared before and after each refusal. */
const writes = async () => ({
  keys: await db.appKey.findMany({ orderBy: { id: 'asc' } }),
  scopes: await db.appKeyScope.findMany({ orderBy: { id: 'asc' } }),
  grants: await db.appGrant.findMany({ orderBy: { id: 'asc' } }),
  writeGrants: await db.appMemoryWriteGrant.findMany({ orderBy: { id: 'asc' } }),
  readGrants: await db.appAutomationReadGrant.findMany({ orderBy: { id: 'asc' } }),
});

const DOORS: Record<string, (c: Context) => Promise<unknown>> = {
  createAppKey: (c) => M.createAppKey({}, { appRef: f.app.id, label: 'new' }, c),
  regenerateAppKey: (c) => M.regenerateAppKey({}, { appRef: f.app.id }, c),
  grantAppKeyScope: (c) => M.grantAppKeyScope({}, { id: f.key.id, scope: 'attention:deliver' }, c),
  grantApp: (c) => M.grantApp({}, { appRef: f.app.id, workerRef: f.target.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, c),
  setAppMemoryWriteGrant: (c) => M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: f.dest.id, prefix: 'reports:x' }, c),
  // The sixth door (Ada #68814, Xanthos #68810, folded by Patrick #68818): giving an automation's read grant.
  setAutomationReadGrant: (c) => M.setAutomationReadGrant({}, { appRef: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, memoryRef: f.dest.id, prefix: 'tasks' }, c),
};

const answer = (p: Promise<unknown>) => p.then(
  (v) => ({ admitted: JSON.stringify(v ?? null) }),
  (e: any) => ({ code: e?.extensions?.code ?? null, message: String(e?.message) }),
);

const FORBIDDEN = { code: 'FORBIDDEN', message: 'Forbidden' };
const SCOPE_REFUSAL = { code: 'FORBIDDEN', message: 'Only whoever manages this App can change what its keys may do.' };
const GRANT_REFUSAL = { code: 'APP_GRANT_FORBIDDEN', message: 'Only whoever manages this App can give or revoke a grant.' };
const NOT_BOUND = { code: 'SESSION_NOT_BOUND', message: 'The session this request names is not one of your open sessions (it may have ended). Nothing was written. Bind a live session, or send no session to act as yourself.' };
const READ_ONLY = { code: 'FORBIDDEN', message: 'Impersonation sessions are read-only.' };

/**
 * The answer each door gives each shape. A worker shape gets the door's own manager refusal (the answer its bound
 * worker already got on main); a shape main refused at an earlier gate keeps that answer. Rows marked RED were
 * ADMITTED on main 102090d7ae (the door wrote: a key, a scope, a grant).
 */
const EXPECTED: Record<string, Record<keyof typeof CLASSES, { code: string; message: string }>> = {
  createAppKey: { boundWorker: FORBIDDEN, sessionRowWorker: FORBIDDEN /* RED */, ambiguousActor: FORBIDDEN /* RED */, refusedBinding: FORBIDDEN /* RED */, impersonation: FORBIDDEN, runPrincipal: FORBIDDEN /* RED */, appKey: FORBIDDEN },
  regenerateAppKey: { boundWorker: FORBIDDEN, sessionRowWorker: FORBIDDEN /* RED */, ambiguousActor: FORBIDDEN /* RED */, refusedBinding: FORBIDDEN /* RED */, impersonation: FORBIDDEN, runPrincipal: FORBIDDEN /* RED */, appKey: FORBIDDEN },
  grantAppKeyScope: { boundWorker: SCOPE_REFUSAL, sessionRowWorker: SCOPE_REFUSAL /* RED */, ambiguousActor: SCOPE_REFUSAL /* RED */, refusedBinding: NOT_BOUND, impersonation: READ_ONLY, runPrincipal: SCOPE_REFUSAL /* RED */, appKey: { code: 'APP_KEY_NOT_FOUND', message: 'App key not found.' } },
  grantApp: { boundWorker: GRANT_REFUSAL, sessionRowWorker: GRANT_REFUSAL /* RED */, ambiguousActor: GRANT_REFUSAL /* RED */, refusedBinding: NOT_BOUND, impersonation: READ_ONLY, runPrincipal: GRANT_REFUSAL /* RED */, appKey: { code: 'APP_NOT_FOUND', message: 'App not found.' } },
  // Already on the person gate on main (both grant doors): regression pins for the whole matrix.
  setAppMemoryWriteGrant: { boundWorker: FORBIDDEN, sessionRowWorker: FORBIDDEN, ambiguousActor: FORBIDDEN, refusedBinding: FORBIDDEN, impersonation: FORBIDDEN, runPrincipal: FORBIDDEN, appKey: FORBIDDEN },
  setAutomationReadGrant: { boundWorker: FORBIDDEN, sessionRowWorker: FORBIDDEN, ambiguousActor: FORBIDDEN, refusedBinding: FORBIDDEN, impersonation: FORBIDDEN, runPrincipal: FORBIDDEN, appKey: FORBIDDEN },
};

describe('#3277 person-only doors refuse every non-person shape, byte-identical, writing nothing', () => {
  for (const door of Object.keys(DOORS)) {
    for (const cls of Object.keys(CLASSES) as (keyof typeof CLASSES)[]) {
      it(`${door}: ${cls}`, async () => {
        const before = await writes();
        const got = await answer(CLASSES[cls](DOORS[door]) as Promise<unknown>);
        expect(got).toEqual(EXPECTED[door][cls]);
        // No raw secret in any refused answer, and nothing written.
        expect(JSON.stringify(got)).not.toContain('hdr_app_');
        expect(await writes()).toEqual(before);
      });
    }
  }

  it('a worker never gives a grant to itself, even held by the App\'s manager', async () => {
    const before = await writes();
    const self = (c: Context) => M.grantApp({}, { appRef: f.app.id, workerRef: f.worker.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, c);
    expect(await answer(CLASSES.boundWorker(self) as Promise<unknown>)).toEqual(GRANT_REFUSAL);
    expect(await answer(CLASSES.sessionRowWorker(self) as Promise<unknown>)).toEqual(GRANT_REFUSAL);
    expect(await writes()).toEqual(before);
  });
});

describe('#3277 a person who manages the App still succeeds at every door (regression)', () => {
  for (const [label, extra] of [['no session', {}], ['a non-worker session', 'person-session']] as const) {
    it(`createAppKey, regenerateAppKey, grantAppKeyScope, grantApp, setAppMemoryWriteGrant, setAutomationReadGrant with ${label}`, async () => {
      const c = person(extra === 'person-session' ? { sessionId: f.personSession.id } : {});
      expect((await DOORS.createAppKey(c) as any).rawKey).toMatch(/^hdr_app_/);
      expect((await DOORS.grantAppKeyScope(c) as any).id).toBe(f.key.id);
      expect(await db.appKeyScope.count({ where: { appKeyId: f.key.id, revokedAt: null } })).toBe(1);
      expect((await DOORS.grantApp(c) as any).granteeWorkerId).toBe(f.target.id);
      expect((await DOORS.setAppMemoryWriteGrant(c) as any).prefix).toBe('reports:x');
      await DOORS.setAutomationReadGrant(c);
      expect(await db.appAutomationReadGrant.count({ where: { revokedAt: null } })).toBe(1);
      expect(await DOORS.regenerateAppKey(c)).toBeTruthy();
      expect(await db.appKey.count({ where: { appId: f.app.id, revokedAt: null } })).toBe(1);
    });
  }
});

describe('#3277 out of scope: list and revoke keep their gates (S3b)', () => {
  it('a person who manages the App still lists and revokes keys, scopes and grants', async () => {
    const c = person();
    await DOORS.grantAppKeyScope(c); await DOORS.grantApp(c);
    expect((await Q.appKeys({}, { appRef: f.app.id }, c) as any[]).map((k) => k.id)).toContain(f.key.id);
    await M.revokeAppKeyScope({}, { id: f.key.id, scope: 'attention:deliver' }, c);
    await M.revokeAppGrant({}, { appRef: f.app.id, workerRef: f.target.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, c);
    expect(await M.revokeAppKey({}, { id: f.key.id }, c)).toBe(true);
  });
  it('a bound worker is still refused at the key list and revokeAppKey, as on main', async () => {
    await expect(CLASSES.boundWorker((c) => Q.appKeys({}, { appRef: f.app.id }, c)) as Promise<unknown>).rejects.toThrow('Forbidden');
    await expect(CLASSES.boundWorker((c) => M.revokeAppKey({}, { id: f.key.id }, c)) as Promise<unknown>).rejects.toThrow('Forbidden');
    expect((await db.appKey.findUniqueOrThrow({ where: { id: f.key.id } })).revokedAt).toBeNull();
  });
});

// #3307 S1: an instruction is a claim, never a bypass of these person-only doors.
describe('#3307 instructed worker remains refused at person-only doors', () => {
 const instruction = {kind:'LIVE_CHAT',ref:'client:turn-17'};
 const instructed: Record<string,(c:Context)=>Promise<unknown>> = {
 createAppKey:c=>M.createAppKey({}, {appRef:f.app.id,label:'new',instruction},c),
 regenerateAppKey:c=>M.regenerateAppKey({}, {appRef:f.app.id,instruction},c),
 grantAppKeyScope:c=>M.grantAppKeyScope({}, {id:f.key.id,scope:'attention:deliver',instruction},c),
 grantApp:c=>M.grantApp({}, {appRef:f.app.id,workerRef:f.target.id,name:'TICKER_SUBSCRIBE_WORKERS',instruction},c),
 setAppMemoryWriteGrant:c=>M.setAppMemoryWriteGrant({}, {appRef:f.app.id,memoryRef:f.dest.id,prefix:'reports:x',instruction},c),
 setAutomationReadGrant:c=>M.setAutomationReadGrant({}, {appRef:f.app.id,triggerKind:'SCHEDULE',triggerId:f.schedule.id,memoryRef:f.dest.id,prefix:'tasks',instruction},c),
 startImpersonation:c=>M.startImpersonation({}, {orgRef:f.org.id,userRef:(f as any).impTarget.id,reason:'fixture',instruction},c),
 };
 for(const [name,call] of Object.entries(instructed)) it(name+' refuses instruction byte-identically, no writes',async()=>{
  if(name==='startImpersonation'){(f as any).impTarget=await db.user.create({data:{handle:'po-imp-target',roles:['READER']}});await db.orgMember.create({data:{organizationId:f.org.id,userId:(f as any).impTarget.id,role:'CONTRIBUTOR'}});}
  const before={writes:await writes(),events:await db.agentTeamEvent.findMany({where:{appId:f.app.id}}),support:await db.impersonationSession.findMany()};
  const plain=name==='startImpersonation'?(c:Context)=>M.startImpersonation({}, {orgRef:f.org.id,userRef:(f as any).impTarget.id,reason:'fixture'},c):DOORS[name];
  const got=await answer(CLASSES.sessionRowWorker(call));
  expect(got).toEqual(await answer(CLASSES.sessionRowWorker(plain)));
  expect(got).toHaveProperty('code',name==='grantApp'?'APP_GRANT_FORBIDDEN':'FORBIDDEN');
  expect({writes:await writes(),events:await db.agentTeamEvent.findMany({where:{appId:f.app.id}}),support:await db.impersonationSession.findMany()}).toEqual(before);
 });
});
