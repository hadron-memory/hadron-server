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
  const row = await db.app.findUniqueOrThrow({ where: { id: appId } });
  expect(row.runTeamSnapshotEnabled).toBe(false);
});
it('preserves the legacy default-off own-App worker list', async () => {
  const page = await Q.workers({}, { appRef: appId }, runContext(db, await mintRun()));
  expect(page.items.map((worker: { id: string }) => worker.id)).toContain(workerId);
});
it('an enabled own-App run reads tasks without becoming an actor; other Apps remain concealed', async () => {
  await enable();
  const principal = runContext(db, await mintRun());
  expect(await mayReadAppTasks(principal, appId)).toBe(true);
  expect(await mayReadAppTasks(principal, otherAppId)).toBe(false);
  await withReadableApp(principal, appId, async (...args) => { expect(args).toHaveLength(2); }, true);
  const page = await Q.agentTasks({}, { appRef: appId }, principal);
  expect(page.map((t: { id: string }) => t.id)).toContain(taskId);
  await denied(Q.agentTasks({}, { appRef: otherAppId }, principal), 'APP_NOT_FOUND');
  expect(await Q.agentTask({}, { id: taskId }, principal)).toMatchObject({ id: taskId });
});
it('an opted-in foreign App remains concealed on every run team read', async () => {
  await enable();
  await enable(otherAppId);
  const foreign = await db.agentTask.create({ data: { appId: otherAppId, title: 'Foreign task', ownerUserId: manager, status: 'pending' } });
  const foreignApp = await db.app.findUniqueOrThrow({ where: { id: otherAppId } });
  expect(foreign.handle).not.toBeNull();
  const principal = runContext(db, await mintRun());
  await denied(Q.agentTasks({}, { appRef: otherAppId }, principal), 'APP_NOT_FOUND');
  await denied(Q.teamRoster({}, { appRef: otherAppId }, principal), 'APP_NOT_FOUND');
  await denied(Q.workers({}, { appRef: otherAppId }, principal), 'FORBIDDEN');
  expect(await Q.agentTask({}, { id: foreign.id }, principal)).toBeNull();
  expect(await Q.agentTask({}, { id: `hrn:agenttask:${foreignApp.urn}:${foreign.handle}` }, principal)).toBeNull();
});
it('a userless run cannot use the new read arm for generic create/update/assign writes', async () => {
  await enable();
  const principal = runContext(db, await mintRun());
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

it('pages tasks without dropping equal timestamps and carries the bounded window in its cursor', async () => {
  await enable();
  await db.agentTask.createMany({ data: Array.from({ length: 105 }, (_, n) => ({ appId, title: `Paged ${n}`, ownerUserId: manager, status: 'pending' })) });
  const c = toolCtx(await mintRun());
  const tool = snapshotTool();
  const first = await tool.execute(c, WINDOW) as any;
  expect(first).toMatchObject({ complete: false, incompleteReason: 'page_limit', hasMore: true });
  expect(typeof first.cursor).toBe('string');
  const second = await tool.execute(c, { ...WINDOW, cursor: first.cursor }) as any;
  expect(second).toMatchObject({ complete: true, incompleteReason: null, hasMore: false, cursor: null });
  const ids = [...first.tasks, ...second.tasks].map(t => t.id);
  expect(ids).toHaveLength(106);
  expect(new Set(ids).size).toBe(106);
  expect(first.acquiredAt).toMatch(/Z$/);
  await denied(tool.execute(c, { ...WINDOW, since: '2026-10-19T00:00:00Z', cursor: first.cursor }), 'TEAM_SNAPSHOT_INVALID_ARGUMENT');
  await db.app.update({ where: { id: appId }, data: { runTeamSnapshotEnabled: false } });
  await denied(tool.execute(c, { ...WINDOW, cursor: first.cursor }), 'APP_NOT_FOUND');
});
it('includes live work plus ended work in the half-open window, not unrelated Apps or AT0', async () => {
  await enable();
  const data = (title: string, status: string, extra = {}) => ({ appId, title, status, ownerUserId: manager, ...(status === 'finished' ? { startedAt: new Date('2026-10-19T00:00:00Z'), assignedAt: new Date('2026-10-19T00:00:00Z'), assigneeUserId: manager, resultOutcome: 'succeeded' } : {}), ...extra });
  await db.agentTask.createMany({ data: [
    data('finished-in', 'finished', { finishedAt: new Date(WINDOW.since) }),
    data('finished-end', 'finished', { finishedAt: new Date(WINDOW.until) }),
    data('cancelled-in', 'cancelled', { cancelledAt: new Date('2026-10-20T12:00:00Z') }),
    data('foreign', 'pending', { appId: otherAppId }),
    data('No project', 'backlog', { handle: 'AT0', taskNumber: 0n }),
  ] });
  const result = await snapshotTool().execute(toolCtx(await mintRun()), WINDOW) as any;
  expect(result.tasks.map((t: any) => t.title).sort()).toEqual(['Existing task', 'cancelled-in', 'finished-in'].sort());
});
it.each([
  {}, { since: 'garbage' }, { since: '2026-02-30T00:00:00Z' },
  { since: '2026-10-20T00:00:00+00:00' }, { since: WINDOW.until, until: WINDOW.since },
  { since: '2025-01-01T00:00:00Z', until: WINDOW.until }, { ...WINDOW, cursor: 'garbage' },
])('refuses invalid UTC windows and cursors with one typed code: %j', async args => {
  await enable();
  await denied(snapshotTool().execute(toolCtx(await mintRun()), args), 'TEAM_SNAPSHOT_INVALID_ARGUMENT');
});

it('the existing teamRoster read shares the run arm, while host and event capabilities stay closed', async () => {
  await enable();
  const principal = runContext(db, await mintRun());
  const roster = await Q.teamRoster({}, { appRef: appId }, principal);
  expect(roster.workers.map((w: any) => w.workerId)).toContain(workerId);
  await denied(Q.teamRoster({}, { appRef: otherAppId }, principal), 'APP_NOT_FOUND');
  await denied(Q.agentTeamEvents({}, { appRef: appId }, principal), 'APP_NOT_FOUND');
});

it.each(['off', 'app-deleted', 'org-deleted', 'run-ended'] as const)('rechecks %s after waiting for the authority anchor', async kind => {
  await enable();
  const c = toolCtx(await mintRun());
  const tool = snapshotTool();
  let unlock!: () => void, ready!: () => void;
  const held = new Promise<void>(r => { ready = r; });
  const release = new Promise<void>(r => { unlock = r; });
  const holder = db.$transaction(async tx => {
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }, { kind: 'org', id: orgId }], 'exclusive');
    if (kind === 'off') await tx.app.update({ where: { id: appId }, data: { runTeamSnapshotEnabled: false } });
    if (kind === 'app-deleted') await tx.app.update({ where: { id: appId }, data: { deletedAt: new Date() } });
    if (kind === 'org-deleted') await tx.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    if (kind === 'run-ended') await tx.appRun.update({ where: { id: c.run.id }, data: { status: 'COMPLETED' } });
    ready(); await release;
  }, { timeout: 20_000 });
  await held;
  const read = tool.execute(c, WINDOW).then(() => null, e => e);
  try { await waitForLockWaitersOfType(db, 'advisory', 1); }
  finally { unlock(); await holder; }
  expect((await read)?.extensions.code).toBe('APP_NOT_FOUND');
});
it('rechecks a manager demotion after waiting for the setting write lock', async () => {
  let unlock!: () => void, ready!: () => void;
  const held = new Promise<void>(r => { ready = r; });
  const release = new Promise<void>(r => { unlock = r; });
  const holder = db.$transaction(async tx => {
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }, { kind: 'org', id: orgId }], 'exclusive');
    await tx.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: manager } }, data: { role: 'CONTRIBUTOR' } });
    ready(); await release;
  }, { timeout: 20_000 });
  await held;
  const write = setting(true);
  try { await waitForLockWaitersOfType(db, 'advisory', 1); }
  finally { unlock(); await holder; }
  expect((await write).errors?.[0].extensions.code).toBe('FORBIDDEN');
  expect((await db.app.findUniqueOrThrow({ where: { id: appId } })).runTeamSnapshotEnabled).toBe(false);
});

it('a source failure is typed and never returns a partial snapshot or echoes database diagnostics', async () => {
  await enable();
  const roster = await import('../../../lib/agentTasks/roster.js');
  const original = new Error('private-source-sentinel');
  const spy = vi.spyOn(roster, 'loadTeamRoster').mockRejectedValueOnce(original);
  const privateLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const err = await snapshotTool().execute(toolCtx(await mintRun()), WINDOW).then(() => null, e => e);
    expect(err?.extensions?.code).toBe('TEAM_SNAPSHOT_SOURCE_FAILED');
    expect(err.message).not.toContain('private-source-sentinel');
    expect(JSON.stringify(err)).not.toContain('private-source-sentinel');
    expect(privateLog).toHaveBeenCalledWith('[run-tool] internal_fault', expect.objectContaining({ error: original, requestId: expect.any(String), site: 'hadron_team_snapshot' }));
    expect(err.cause).toBe(original);
  } finally { spy.mockRestore(); privateLog.mockRestore(); }
});
it('an oversized roster is explicitly non-continuable, never an empty complete roster', async () => {
  await enable();
  await db.worker.createMany({ data: Array.from({ length: 1000 }, (_, n) => ({ ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: `Member ${n}`, slug: `member-${n}` })) });
  const out = await snapshotTool().execute(toolCtx(await mintRun()), WINDOW) as any;
  expect(out).toMatchObject({ complete: false, incompleteReason: 'nested_truncated', hasMore: false, cursor: null, roster: [] });
  expect(out.tasks.map((t: any) => t.id)).toContain(taskId);
});

// Xanthos #70403: the new arm is userless; #2925 does not globally change existing user-backed runs.
it('preserves a user-backed run’s existing TaskActor and task write; #3311 now refuses its scope revoke', async () => {
  const principal = runContext(db, await mintRun(manager));
  expect(await resolveTaskActor(principal, (await loadApp(principal, appId))!)).toMatchObject({ kind: 'user', userId: manager });
  expect(await mayReadAppTasks(principal, appId)).toBe(true); // default-off is not a new denial on its legacy person arm.
  expect((await Q.agentTasks({}, { appRef: appId }, principal)).map((task: { id: string }) => task.id)).toContain(taskId);
  expect(await Q.agentTask({}, { id: taskId }, principal)).toMatchObject({ id: taskId });
  const transact = vi.spyOn(db, '$transaction');
  try {
    await Q.teamRoster({}, { appRef: appId }, principal);
    expect(transact).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
  } finally { transact.mockRestore(); }
  const created = await M.createAgentTask({}, { input: { appRef: appId, title: 'Legacy user-backed write' } }, principal);
  await M.updateAgentTask({}, { taskId: created.id, input: { title: 'Legacy edit' } }, principal);
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: created.id } })).title).toBe('Legacy edit');
  await M.grantAppKeyScope({}, { id: keyId, scope: 'attention:deliver' }, ctx(manager));
  // #3311 (cor:dmo:050:12 S6, CHECKED gate 6603872229: "run" is one of the refused principals at every revoke door,
  // as on the membership writes, ruling 0082): revoking a key's scope is a person acting as themselves, or their held
  // worker on an instruction, never an App's own run. This line used to pin the legacy admission; it is the one
  // deliberate narrowing, so the run's attempt is refused and writes nothing.
  await expect(M.revokeAppKeyScope({}, { id: keyId, scope: 'attention:deliver' }, principal)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  expect((await db.appKeyScope.findFirstOrThrow({ where: { appKeyId: keyId, scope: 'attention:deliver' } })).revokedAt).toBeNull();
});

it('an outage in the new run read transaction propagates instead of becoming not-found', async () => {
  await enable();
  const principal = runContext(db, await mintRun());
  await expect(inRunTeamReadTx(principal, appId, () => null, async c => {
    await c.db.$queryRaw`SELECT id FROM app_runs WHERE id = ${principal.clientId!.slice(4)} FOR SHARE`;
    throw new Error('synthetic run-read outage');
  })).rejects.toThrow('synthetic run-read outage');
});

it('keeps the longer transaction budget confined to run team reads', async () => {
  await enable();
  const transact = vi.spyOn(db, '$transaction');
  try {
    await withReadableApp(ctx(undefined, { appId, appKeyId: keyId }), appId, async () => true);
    expect(transact).toHaveBeenCalled();
    for (const call of transact.mock.calls) expect(call[1]?.timeout).toBeUndefined();
    transact.mockClear();
    await inRunTeamReadTx(runContext(db, await mintRun()), appId, () => false, async () => true);
    expect(transact).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ timeout: 20_000 }));
  } finally { transact.mockRestore(); }
});
it('reads one coherent run-team view while concurrent task state changes', async () => {
  await enable();
  await inRunTeamReadTx(runContext(db, await mintRun()), appId, () => { throw new Error('unexpected refusal'); }, async c => {
    const count = await c.db.agentTask.count({ where: { appId } });
    await db.agentTask.create({ data: { appId, title: 'Concurrent task', ownerUserId: manager, status: 'pending' } });
    expect(await c.db.agentTask.count({ where: { appId } })).toBe(count);
  });
});

it.each(['impersonation', 'user-binding', 'org-binding', 'tool-run-binding'] as const)('refuses a forged run snapshot binding: %s', async kind => {
  await enable();
  const run = await mintRun();
  const c = toolCtx(run);
  if (kind === 'impersonation') c.principal.impersonation = { orgId } as never;
  if (kind === 'user-binding') c.principal.userId = manager;
  if (kind === 'org-binding') c.principal.organizationId = (await db.organization.create({ data: { name: 'Other live org', urn: `other-${generateId()}.example` } })).id;
  if (kind === 'tool-run-binding') c.principal.clientId = `run:${(await mintRun()).id}`;
  await denied(snapshotTool().execute(c, WINDOW), 'APP_NOT_FOUND');
});
it('the new tool uses live own-App opt-in even for a run backed by a nonparticipant user', async () => {
  const run = await mintRun(outsider);
  const c = toolCtx(run);
  await denied(snapshotTool().execute(c, WINDOW), 'APP_NOT_FOUND');
  await enable();
  expect((await snapshotTool().execute(c, WINDOW) as { app: { id: string } }).app.id).toBe(appId);
});
it.each(['key', 'run', 'outsider', 'personal-outsider'] as const)('masks the nullable App flag for an unauthorized nested reader: %s', async kind => {
  const c = kind === 'key' ? ctx(undefined, { appId, appKeyId: keyId }) : kind === 'run' ? runContext(db, await mintRun()) : ctx(outsider);
  const id = kind === 'personal-outsider' ? personalAppId : appId;
  expect(await (resolvers.App as any).runTeamSnapshotEnabled({ id }, {}, c)).toBeNull();
});

it('preserves legacy own-App worker list, by-ref, held-worker and chat metadata reads independently of opt-in', async () => {
  const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
  const memory = await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: `${app.urn}-shared`, name: 'shared', class: 'app', appId, sharedMemoryOfAgentId: agentId } });
  const channel = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:team', name: 'Team', createdBy: manager });
  await db.app.update({ where: { id: appId }, data: { defaultChannelId: channel.channel.id } });
  await db.worker.update({ where: { id: workerId }, data: { heldByUserId: manager, heldAt: new Date() } });
  const principal = runContext(db, await mintRun());
  for (const enabled of [false, true, false]) {
    await db.app.update({ where: { id: appId }, data: { runTeamSnapshotEnabled: enabled } });
    expect(await Q.worker({}, { ref: workerId }, principal)).toMatchObject({ id: workerId });
    const page = await Q.workers({}, { appRef: appId }, principal);
    expect(page.items.map((worker: { id: string }) => worker.id)).toContain(workerId);
    const held = await Q.heldWorkers({}, { userRef: manager }, principal);
    expect(held.items.map((worker: { id: string }) => worker.id)).toContain(workerId);
    const chat = await Q.teamChatMessages({}, { appRef: appId, untagged: true, advanceReadState: false }, principal);
    expect(chat.items).toEqual([]);
  }
});
