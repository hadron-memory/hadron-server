import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
/** #2925 / ruling0112: the run read is opt-in, own-App and never a task actor. */
import { ApolloServer } from '@apollo/server';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { resolveRunTools } from '../../../lib/runner/tools/index.js';
import { inRunTeamReadTx, loadApp, mayReadAppTasks, resolveTaskActor, withReadableApp } from './resolvers.agentTask.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';
import type { AppRun } from '../../../generated/prisma/index.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn(async () => {}) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const M = resolvers.Mutation as any, Q = resolvers.Query as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
beforeAll(() => server.start());
afterAll(() => server.stop());
let orgId: string, appId: string, otherAppId: string, personalAppId: string, workerId: string, agentId: string, taskId: string;
let manager: string, owner: string, member: string, outsider: string, personalOwner: string, keyId: string;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
async function wire(query: string, variables: Record<string, unknown>, c: Context) {
  const answer = await server.executeOperation({ query, variables }, { contextValue: c });
  if (answer.body.kind !== 'single') throw new Error('unexpected incremental response');
  return JSON.parse(JSON.stringify(answer.body.singleResult));
}
let triggers = new Map<string, string>();
async function schedule(forApp = appId) {
  const old = triggers.get(forApp); if (old) return old;
  const row = await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId: forApp,
    name: 'Snapshot automation', cron: '* * * * *', entryNodeUrn: 'hrn:node:snapshot2925.example:flows:report' } });
  triggers.set(forApp, row.id); return row.id;
}
const setting = async (enabled: boolean, c = ctx(manager), appRef = appId) => {
  if (enabled) return wire('mutation($app:ID!,$trigger:ID!){setAutomationTeamSnapshotGrant(appRef:$app,triggerKind:"SCHEDULE",triggerId:$trigger){id appId triggerId revokedAt}}',
    { app: appRef, trigger: await schedule(appRef) }, c);
  const row = await db.appAutomationTeamSnapshotGrant.findFirst({ where: { appId: appRef, triggerId: await schedule(appRef), revokedAt: null } });
  return wire('mutation($id:ID!){revokeAutomationTeamSnapshotGrant(id:$id){id revokedAt}}', { id: row?.id ?? 'unknown-grant' }, c);
};
async function enable(appRef = appId) {
  const out = await setting(true, ctx(manager), appRef);
  expect(out.errors).toBeUndefined();
  expect(out.data.setAutomationTeamSnapshotGrant.revokedAt).toBeNull();
}
async function mintRun(userId: string | null = null, forApp = appId): Promise<AppRun> {
  return db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId: forApp, userId, triggerKind: 'SCHEDULE', triggerId: await schedule(forApp),
    entryNodeUrn: 'hrn:node:snapshot2925.example:flows:report', status: 'RUNNING' } });
}
const toolCtx = (run: AppRun) => ({ db, run, principal: runContext(db, run), log: vi.fn() });
function snapshotTool() {
  const found = resolveRunTools(['hadron_team_snapshot']);
  expect(found.unknown, 'new run tool must exist').toEqual([]);
  return found.tools.find(t => t.name === 'hadron_team_snapshot')!;
}
async function denied(p: Promise<unknown>, code: string) {
  const e = await p.then(() => null, error => error);
  expect(e, `expected ${code}, got success`).not.toBeNull();
  expect(e.extensions?.code ?? e.code).toBe(code);
}
const WINDOW = { since: '2026-10-20T00:00:00Z', until: '2026-10-21T00:00:00Z' };
beforeEach(async () => {
  await cleanDb(db); triggers = new Map();
  const org = await db.organization.create({ data: { name: 'Snapshot', urn: `snapshot-${generateId()}.example` } });
  orgId = org.id;
  const user = async () => (await db.user.create({ data: { handle: `snap-${generateId()}`, roles: ['READER'] } })).id;
  [manager, owner, member, outsider, personalOwner] = await Promise.all([user(), user(), user(), user(), user()]);
  await db.orgMember.create({ data: { organizationId: orgId, userId: manager, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { name: 'Team', urn: `${org.urn}:team`, organizationId: orgId } })).id;
  otherAppId = (await db.app.create({ data: { name: 'Other', urn: `${org.urn}:other`, organizationId: orgId } })).id;
  personalAppId = (await db.app.create({ data: { name: 'Personal', urn: `snap-owner-${generateId()}:personal`, ownerUserId: personalOwner } })).id;
  await db.appMember.createMany({ data: [{ appId, userId: owner, role: 'owner' }, { appId, userId: member, role: 'member' }] });
  agentId = (await db.agent.create({ data: { name: 'Team Agent', urn: `${org.urn}:agent`, organizationId: orgId } })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Builder', slug: 'builder' } })).id;
  taskId = (await db.agentTask.create({ data: { appId, title: 'Existing task', ownerUserId: manager, status: 'pending' } })).id;
  keyId = (await db.appKey.create({ data: { appId, keyHash: generateId(), keyPreview: 'synthetic' } })).id;
});


it('RED3350: replaces the App flag with manager automation grant doors', () => {
 const schema=buildSchema(typeDefs);
 expect((schema.getType('App') as GraphQLObjectType).getFields().runTeamSnapshotEnabled).toBeUndefined();
 expect(schema.getMutationType()!.getFields().setAppRunTeamSnapshotEnabled).toBeUndefined();
 expect(schema.getMutationType()!.getFields().setAutomationTeamSnapshotGrant).toBeDefined();
 expect(schema.getMutationType()!.getFields().revokeAutomationTeamSnapshotGrant).toBeDefined();
 expect(schema.getQueryType()!.getFields().automationTeamSnapshotGrants).toBeDefined();
});
it('RED3350: exposes a per-trigger grant, not a per-App setting',async()=>{
 const trigger=await db.agentSchedule.create({data:{id:generateId(),organizationId:orgId,appId,name:'Grant A',cron:'* * * * *',entryNodeUrn:'hrn:node:snapshot2925.example:flows:report'}});
 const out=await wire('mutation($a:ID!,$t:ID!){setAutomationTeamSnapshotGrant(appRef:$a,triggerKind:"SCHEDULE",triggerId:$t){id appId triggerId revokedAt}}',{a:appId,t:trigger.id},ctx(manager));
 expect(out.errors).toBeUndefined();
 expect(out.data.setAutomationTeamSnapshotGrant).toMatchObject({appId,triggerId:trigger.id,revokedAt:null});
});
// Set the legacy flag only if the pre-migration schema still has it. This is the red control on main;
// the replacement schema has no such column and grants never get inferred from its old value.
async function legacyOn(){
 const rows=await db.$queryRaw<Array<{exists:boolean}>>`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='apps' AND column_name='run_team_snapshot_enabled') AS exists`;
 if(rows[0]?.exists) await db.$executeRaw`UPDATE apps SET run_team_snapshot_enabled=true WHERE id=${appId}`;
}
it('RED3350: an ungranted schedule cannot borrow the App setting',async()=>{
 await legacyOn();
 const trigger=await db.agentSchedule.create({data:{id:generateId(),organizationId:orgId,appId,name:'Ungranted B',cron:'* * * * *',entryNodeUrn:'hrn:node:snapshot2925.example:flows:report'}});
 const run=await db.appRun.create({data:{id:generateId(),appId,organizationId:orgId,userId:null,triggerKind:'SCHEDULE',triggerId:trigger.id,entryNodeUrn:trigger.entryNodeUrn,status:'RUNNING'}});
 await denied(snapshotTool().execute(toolCtx(run),WINDOW),'APP_NOT_FOUND');
});
it('RED3350: MANUAL has no automation even when the old flag was on',async()=>{
 await legacyOn(); const run = await mintRun(); await db.appRun.update({where:{id:run.id},data:{triggerKind:'MANUAL',triggerId:null}}); await denied(snapshotTool().execute(toolCtx({...run,triggerKind:'MANUAL',triggerId:null}),WINDOW),'APP_NOT_FOUND');
});

it('automation A granted, B ungranted, later A runs and all descendant kinds stay isolated', async () => {
  await enable();
  const a = await mintRun();
  const bTrigger = await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId, name: 'B', cron: '* * * * *', entryNodeUrn: a.entryNodeUrn } });
  const b = await db.appRun.create({ data: { id: generateId(), appId, organizationId: orgId, userId: null, triggerKind: 'SCHEDULE', triggerId: bTrigger.id, entryNodeUrn: a.entryNodeUrn, status: 'RUNNING' } });
  const read = async (r: AppRun) => snapshotTool().execute(toolCtx(r), WINDOW);
  expect((await read(a) as any).app.id).toBe(appId);
  expect((await read(await mintRun()) as any).complete).toBe(true);
  await denied(read(b), 'APP_NOT_FOUND');
  for (const kind of ['SPAWN', 'INTEGRATION'] as const) {
    for (const [parent, admitted] of [[a, true], [b, false]] as const) {
      const child = await db.appRun.create({ data: { id: generateId(), appId, organizationId: orgId, userId: null, parentRunId: parent.id,
        triggerKind: kind, entryNodeUrn: a.entryNodeUrn, status: 'RUNNING' } });
      if (admitted) expect((await read(child) as any).app.id).toBe(appId); else await denied(read(child), 'APP_NOT_FOUND');
    }
  }
  // A MANUAL origin stops ancestry, even if someone put a granted parent id on it.
  const manual = await db.appRun.create({ data: { id: generateId(), appId, organizationId: orgId, userId: null, parentRunId: a.id,
    triggerKind: 'MANUAL', entryNodeUrn: a.entryNodeUrn, status: 'RUNNING' } });
  await denied(read(manual), 'APP_NOT_FOUND');
  await db.agentSchedule.update({ where: { id: a.triggerId! }, data: { deletedAt: new Date() } });
  await denied(read(a), 'APP_NOT_FOUND');
  const child = await db.appRun.create({ data: { id: generateId(), appId, organizationId: orgId, userId: null, parentRunId: a.id,
    triggerKind: 'SPAWN', entryNodeUrn: a.entryNodeUrn, status: 'RUNNING' } });
  await denied(read(child), 'APP_NOT_FOUND');
});
it('WEBHOOK root grant survives edit/re-adoption of that row and ends at revoke or soft-delete', async () => {
  const hook = await db.agentWebhook.create({ data: { id: generateId(), appId, organizationId: orgId, name: 'Hook', secret: generateId(), entryNodeUrn: 'hrn:node:snapshot2925.example:flows:report' } });
  const grant = await M.setAutomationTeamSnapshotGrant({}, { appRef: appId, triggerKind: 'WEBHOOK', triggerId: hook.id }, ctx(manager));
  const run = await db.appRun.create({ data: { id: generateId(), appId, organizationId: orgId, userId: null, triggerKind: 'WEBHOOK', triggerId: hook.id, entryNodeUrn: hook.entryNodeUrn, status: 'RUNNING' } });
  const principal = runContext(db, run);
  expect(await mayReadAppTasks(principal, appId)).toBe(true);
  await db.agentWebhook.update({ where: { id: hook.id }, data: { name: 'Edited', automationPin: { hash: 'new-adoption-pin' } } });
  expect(await mayReadAppTasks(principal, appId)).toBe(true);
  await M.revokeAutomationTeamSnapshotGrant({}, { id: grant.id }, ctx(manager));
  expect(await mayReadAppTasks(principal, appId)).toBe(false);
  const next = await M.setAutomationTeamSnapshotGrant({}, { appRef: appId, triggerKind: 'WEBHOOK', triggerId: hook.id }, ctx(manager));
  expect(next.id).not.toBe(grant.id);
  await db.agentWebhook.update({ where: { id: hook.id }, data: { deletedAt: new Date() } });
  expect(await mayReadAppTasks(principal, appId)).toBe(false);
});
it('#3375: a trigger deleted after root resolution refuses the non-transactional read when its locking read returns zero rows', async () => {
  await enable();
  const run = await mintRun();
  const principal = runContext(db, run);
  expect(await mayReadAppTasks(principal, appId)).toBe(true);

  // dueWakes uses this boolean gate without the anchored RepeatableRead wrapper.
  const transactions = vi.spyOn(db, '$transaction');
  let resolvedRoot: string | undefined;
  let lockedRows: unknown;
  let rootReads = 0;
  const rootDb = db.$extends({ query: { agentSchedule: {
    async findFirst({ args, query }) {
      const live = await query(args);
      rootReads++;
      expect(live?.id).toBe(run.triggerId);
      resolvedRoot = live!.id;
      await db.agentSchedule.update({ where: { id: live!.id }, data: { deletedAt: new Date() } });
      return live; // the real root was live when read; its deletion has now committed.
    },
  } } });
  const observedDb = new Proxy(rootDb, { get(target, key) {
    if (key === '$queryRaw') return async (...args: Parameters<typeof db.$queryRaw>) => {
      const rows = await rootDb.$queryRaw(...args);
      const sql = 'sql' in args[0] ? args[0].sql : args[0].join('?');
      if (sql.includes('FROM agent_schedules') && sql.includes('FOR SHARE')) {
        expect(resolvedRoot).toBe(run.triggerId);
        lockedRows = rows;
      }
      return rows;
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const admitted = await mayReadAppTasks({ ...principal, db: observedDb as unknown as Context['db'] }, appId);
    expect(rootReads).toBe(1);
    expect(lockedRows).toEqual([]); // not a fabricated empty result: the actual DB row was deleted.
    expect(transactions).not.toHaveBeenCalled();
    expect(await db.appAutomationTeamSnapshotGrant.count({ where: { appId, triggerId: run.triggerId!, revokedAt: null } })).toBe(1);
    expect(admitted).toBe(false);
  } finally {
    transactions.mockRestore();
  }
  await db.agentSchedule.update({ where: { id: run.triggerId! }, data: { deletedAt: null } });
  expect(await mayReadAppTasks(principal, appId)).toBe(true);
});

it('manager gives/lists/revokes with one event per change and stable bounded pages including revoked history', async () => {
  await enable();
  await enable();
  const grant = await db.appAutomationTeamSnapshotGrant.findFirstOrThrow();
  expect(await db.appAutomationTeamSnapshotGrant.count()).toBe(1);
  expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(1);
  const q = (extra = {}) => Q.automationTeamSnapshotGrants({}, { appRef: appId, ...extra }, ctx(manager));
  expect(await q({ limit: 0 })).toMatchObject({ items: [], total: 1, hasMore: true });
  expect((await q()).items[0].id).toBe(grant.id);
  await M.revokeAutomationTeamSnapshotGrant({}, { id: grant.id }, ctx(manager));
  await M.revokeAutomationTeamSnapshotGrant({}, { id: grant.id }, ctx(manager));
  expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(2);
  expect(await q()).toMatchObject({ items: [], total: 0, hasMore: false });
  expect((await q({ includeRevoked: true })).items[0].revokedBy).toBe(manager);
  await enable();
  expect(await q({ includeRevoked: true, limit: 1 })).toMatchObject({ total: 2, hasMore: true });
  expect(await q({ includeRevoked: true, limit: 1, offset: 1 })).toMatchObject({ total: 2, hasMore: false });
});
it.each(['member', 'key', 'run', 'impersonation'] as const)('every grant door refuses %s with no row/event effects', async kind => {
  await enable();
  const grant = await db.appAutomationTeamSnapshotGrant.findFirstOrThrow();
  const before = { rows: await db.appAutomationTeamSnapshotGrant.findMany(), events: await db.appAutomationTeamSnapshotGrantEvent.findMany() };
  const c = kind === 'member' ? ctx(member) : kind === 'key' ? ctx(undefined, { appId, appKeyId: keyId })
    : kind === 'run' ? runContext(db, await mintRun(manager)) : ctx(manager, { impersonation: { orgId } as never });
  for (const operation of [
    () => M.setAutomationTeamSnapshotGrant({}, { appRef: appId, triggerKind: 'SCHEDULE', triggerId: triggers.get(appId)! }, c),
    () => M.revokeAutomationTeamSnapshotGrant({}, { id: grant.id }, c),
    () => Q.automationTeamSnapshotGrants({}, { appRef: appId }, c),
  ]) await denied(operation(), 'FORBIDDEN');
  expect(await db.appAutomationTeamSnapshotGrant.findMany()).toEqual(before.rows);
  expect(await db.appAutomationTeamSnapshotGrantEvent.findMany()).toEqual(before.events);
});
it('foreign trigger, unknown trigger and unknown grant are uniform refusals with no audit row', async () => {
  const foreign = await schedule(otherAppId);
  for (const triggerId of [foreign, 'unknown']) await denied(M.setAutomationTeamSnapshotGrant({}, { appRef: appId, triggerKind: 'SCHEDULE', triggerId }, ctx(manager)), 'FORBIDDEN');
  await denied(M.revokeAutomationTeamSnapshotGrant({}, { id: 'unknown' }, ctx(manager)), 'FORBIDDEN');
  expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(0);
});

function auditFaultDb() {
  return new Proxy(db, { get(base, key) {
    if (key === '$transaction') return (fn: any, ...rest: any[]) => (db.$transaction as any)(async (tx: any) => fn(new Proxy(tx, { get(t, k) {
      if (k === 'appAutomationTeamSnapshotGrantEvent') return new Proxy(t[k], { get(d, op) {
        if (op === 'create') return async () => { throw new Error('audit-write-fault-3350'); };
        const value = d[op]; return typeof value === 'function' ? value.bind(d) : value;
      } });
      const value = t[k]; return typeof value === 'function' ? value.bind(t) : value;
    } })), ...rest);
    const value = (base as any)[key]; return typeof value === 'function' ? value.bind(base) : value;
  } });
}
it('a failed audit insert rolls back the give and terminal revoke together with its event', async () => {
  const triggerId = await schedule();
  const bad = ctx(manager, { db: auditFaultDb() });
  await expect(M.setAutomationTeamSnapshotGrant({}, { appRef: appId, triggerKind: 'SCHEDULE', triggerId }, bad)).rejects.toThrow('audit-write-fault-3350');
  expect(await db.appAutomationTeamSnapshotGrant.count()).toBe(0);
  expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(0);
  await enable();
  const grant = await db.appAutomationTeamSnapshotGrant.findFirstOrThrow();
  await expect(M.revokeAutomationTeamSnapshotGrant({}, { id: grant.id }, bad)).rejects.toThrow('audit-write-fault-3350');
  expect((await db.appAutomationTeamSnapshotGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt).toBeNull();
  expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(1);
});
it('MCP give/list/revoke delegates the same manager gate and atomic audit, with key/run refusals', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServerInstance } = await import('../../../mcp/server.js');
  async function clientAs(auth: Record<string, unknown>, fn: (c: any) => Promise<void>) {
    const server = createMcpServerInstance(auth as never, () => undefined, { kind: 'multi-app' });
    const client = new Client({ name: 'grant3350', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    try { await fn(client); } finally { await client.close(); await server.close(); }
  }
  const triggerId = await schedule(); let id = '';
  await clientAs({ userId: manager, roles: ['READER'] }, async c => {
    const given = await c.callTool({ name: 'hadron_set_automation_team_snapshot_grant', arguments: { app: appId, triggerKind: 'SCHEDULE', triggerId } });
    expect(given.isError).not.toBe(true); id = JSON.parse(given.content[0].text).id;
    const list = await c.callTool({ name: 'hadron_list_automation_team_snapshot_grants', arguments: { app: appId, limit: 1 } });
    expect(JSON.parse(list.content[0].text)).toMatchObject({ total: 1, hasMore: false, items: [{ id }] });
    const revoked = await c.callTool({ name: 'hadron_revoke_automation_team_snapshot_grant', arguments: { id } });
    expect(JSON.parse(revoked.content[0].text).revokedBy).toBe(manager);
  });
  const events = await db.appAutomationTeamSnapshotGrantEvent.count();
  const run = await mintRun(manager);
  for (const auth of [{ appId, appKeyId: keyId, roles: [] }, { ...runContext(db, run), db: undefined }]) {
    await clientAs(auth as never, async c => {
      for (const [name, args] of [
        ['hadron_set_automation_team_snapshot_grant', { app: appId, triggerKind: 'SCHEDULE', triggerId }],
        ['hadron_revoke_automation_team_snapshot_grant', { id }],
        ['hadron_list_automation_team_snapshot_grants', { app: appId }],
      ] as const) {
        const refused = await c.callTool({ name, arguments: args });
        expect(refused.isError).toBe(true); expect(refused.content[0].text).toContain('[forbidden]');
      }
    });
  }
  expect(await db.appAutomationTeamSnapshotGrantEvent.count()).toBe(events);
});
it('an App lookup outage propagates as a fault, not a fabricated Forbidden', async () => {
  const fault = new Error('lookup-outage-3350');
  const spy = vi.spyOn(db.app, 'findFirst').mockRejectedValueOnce(fault);
  try { await expect(Q.automationTeamSnapshotGrants({}, { appRef: appId }, ctx(manager))).rejects.toBe(fault); }
  finally { spy.mockRestore(); }
});
