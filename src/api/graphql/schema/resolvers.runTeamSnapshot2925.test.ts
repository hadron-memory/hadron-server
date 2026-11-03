/** #2925 / ruling0112: the run read is opt-in, own-App and never a task actor. */
import { ApolloServer } from '@apollo/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { resolveRunTools } from '../../../lib/runner/tools/index.js';
import { loadApp, mayReadAppTasks, resolveTaskActor } from './resolvers.agentTask.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';
import type { AppRun } from '../../../generated/prisma/index.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn(async () => {}) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const M = resolvers.Mutation as any, Q = resolvers.Query as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
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
  return db.appRun.create({ data: { organizationId: orgId, appId: forApp, userId, triggerKind: 'MANUAL',
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

it('ships the nullable masked App field and person-manager mutation for client siblings', () => {
  const schema = buildSchema(typeDefs);
  expect(String((schema.getType('App') as GraphQLObjectType).getFields().runTeamSnapshotEnabled?.type)).toBe('Boolean');
  const m = schema.getMutationType()!.getFields().setAppRunTeamSnapshotEnabled;
  expect(m?.args.map(a => `${a.name}:${a.type}`)).toEqual(['appRef:ID!', 'enabled:Boolean!']);
  expect(String(m?.type)).toBe('App!');
});
it('existing and newly created Apps default off on the wire', async () => {
  const out = await wire('query($id:ID!){app(ref:$id){id runTeamSnapshotEnabled}}', { id: appId }, ctx(manager));
  expect(out.errors).toBeUndefined();
  expect(out.data.app).toMatchObject({ id: appId, runTeamSnapshotEnabled: false });
});
it.each(['org-admin', 'app-owner', 'personal-owner'] as const)('only a managing person toggles on and back off: %s', async kind => {
  const c = ctx(kind === 'org-admin' ? manager : kind === 'app-owner' ? owner : personalOwner);
  const id = kind === 'personal-owner' ? personalAppId : appId;
  for (const enabled of [true, false]) {
    const out = await setting(enabled, c, id);
    expect(out.errors).toBeUndefined();
    expect(out.data.setAppRunTeamSnapshotEnabled).toEqual({ id, runTeamSnapshotEnabled: enabled });
  }
});
it.each(['member', 'own-key', 'run', 'worker', 'impersonation'] as const)('%s cannot change the setting even when the human/App would manage', async kind => {
  let c = kind === 'member' ? ctx(member) : ctx(manager);
  if (kind === 'own-key') c = ctx(undefined, { appId, appKeyId: keyId });
  if (kind === 'run') c = runContext(db, await mintRun(manager));
  if (kind === 'impersonation') c = ctx(manager, { impersonation: { orgId } as never });
  const out = kind === 'worker'
    ? await runAsActor({ workerId, agentId }, () => setting(true, c)) : await setting(true, c);
  expect(out.data).toBeNull();
  expect(out.errors?.[0].extensions.code).toBe('FORBIDDEN');
  const row = await db.app.findUniqueOrThrow({ where: { id: appId } }) as any;
  expect(row.runTeamSnapshotEnabled).toBe(false);
});
it('a default-off run cannot bypass opt-in through the existing worker list', async () => {
  await denied(Q.workers({}, { appRef: appId }, runContext(db, await mintRun())), 'FORBIDDEN');
});
it('an enabled own-App run reads tasks without becoming an actor; other Apps remain concealed', async () => {
  await enable();
  const principal = runContext(db, await mintRun());
  expect(await mayReadAppTasks(principal, appId)).toBe(true);
  expect(await mayReadAppTasks(principal, otherAppId)).toBe(false);
  expect(await resolveTaskActor(principal, (await loadApp(principal, appId))!)).toBeNull();
  const page = await Q.agentTasks({}, { appRef: appId }, principal);
  expect(page.map((t: { id: string }) => t.id)).toContain(taskId);
  await denied(Q.agentTasks({}, { appRef: otherAppId }, principal), 'APP_NOT_FOUND');
  expect(await Q.agentTask({}, { id: taskId }, principal)).toMatchObject({ id: taskId });
});
it('a user-backed run still yields no TaskActor and generic create/update/assign are refused without writes', async () => {
  const principal = runContext(db, await mintRun(manager));
  expect(await resolveTaskActor(principal, (await loadApp(principal, appId))!)).toBeNull();
  const before = await db.agentTask.count();
  await denied(M.createAgentTask({}, { input: { appRef: appId, title: 'forged' } }, principal), 'APP_NOT_FOUND');
  await denied(M.updateAgentTask({}, { taskId, input: { title: 'forged' } }, principal), 'TASK_NOT_FOUND');
  await denied(M.assignAgentTask({}, { taskId, assignee: { worker: workerId } }, principal), 'TASK_NOT_FOUND');
  expect(await db.agentTask.count()).toBe(before);
  expect(await db.agentTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ title: 'Existing task', assigneeWorkerId: null });
});
it('setting revocation applies to the next read with the same run context', async () => {
  await enable();
  const principal = runContext(db, await mintRun());
  expect((await Q.agentTasks({}, { appRef: appId }, principal)).length).toBeGreaterThan(0);
  expect((await setting(false)).errors).toBeUndefined();
  await denied(Q.agentTasks({}, { appRef: appId }, principal), 'APP_NOT_FOUND');
});
it.each(['app', 'org', 'run-ended', 'run-forged'] as const)('the live read gate refuses %s on its next read', async kind => {
  await enable();
  const run = await mintRun();
  const principal = runContext(db, run);
  expect(await mayReadAppTasks(principal, appId)).toBe(true);
  if (kind === 'app') await db.app.update({ where: { id: appId }, data: { deletedAt: new Date() } });
  if (kind === 'org') await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
  if (kind === 'run-ended') await db.appRun.update({ where: { id: run.id }, data: { status: 'COMPLETED' } });
  if (kind === 'run-forged') principal.clientId = `run:${generateId()}`;
  await denied(Q.agentTasks({}, { appRef: appId }, principal), 'APP_NOT_FOUND');
});
it('registers one cost-zero snapshot tool with no caller-App or credential arguments', () => {
  const tool = snapshotTool();
  expect(tool.cost).toBe(0);
  expect(tool.policyAction ?? `tool.${tool.name}`).toBe('tool.hadron_team_snapshot');
  expect(Object.keys((tool.inputSchema as any).properties).sort()).toEqual(['cursor', 'since', 'until']);
  expect(tool.description).toMatch(/untrusted/i);
});
it('a userless run snapshots only its enabled App, never an App supplied as data', async () => {
  await enable();
  const tool = snapshotTool();
  const c = toolCtx(await mintRun());
  const out = await tool.execute(c, WINDOW) as any;
  expect(out.complete).toBe(true);
  expect(out.app.id).toBe(appId);
  expect(out.roster.map((w: any) => w.worker.id)).toContain(workerId);
  expect(out.tasks.map((t: any) => t.id)).toContain(taskId);
  for (const arg of ['appId', 'appRef', 'userId', 'runId']) {
    await denied(tool.execute(c, { ...WINDOW, [arg]: otherAppId }), 'TEAM_SNAPSHOT_INVALID_ARGUMENT');
  }
});
