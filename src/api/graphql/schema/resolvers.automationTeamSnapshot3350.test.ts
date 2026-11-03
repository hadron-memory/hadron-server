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
const setting = (enabled: boolean, c = ctx(manager), appRef = appId) => wire(
  'mutation($app:ID!,$enabled:Boolean!){setAppRunTeamSnapshotEnabled(appRef:$app,enabled:$enabled){id runTeamSnapshotEnabled}}',
  { app: appRef, enabled }, c,
);
async function enable(appRef = appId) {
  const out = await setting(true, ctx(manager), appRef);
  expect(out.errors).toBeUndefined();
  expect(out.data.setAppRunTeamSnapshotEnabled.runTeamSnapshotEnabled).toBe(true);
}
async function mintRun(userId: string | null = null, forApp = appId): Promise<AppRun> {
  return db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId: forApp, userId, triggerKind: 'MANUAL',
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
  await cleanDb(db);
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
 const out=await wire('mutation($a:ID!,$t:ID!){setAutomationTeamSnapshotGrant(appRef:$a,triggerKind:SCHEDULE,triggerId:$t){id appId triggerId revokedAt}}',{a:appId,t:trigger.id},ctx(manager));
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
 await legacyOn();await denied(snapshotTool().execute(toolCtx(await mintRun()),WINDOW),'APP_NOT_FOUND');
});
