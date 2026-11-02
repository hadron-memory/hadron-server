/**
 * #3132 (hrn:node:hadronmemory.com:specs:cor:agt:120:03, :050:23, :050:11, :050:01; V41, V45 point 12, rulings:0009):
 * claims of untracked tracker items by an App's own key and by a headless run of the App, and the run tools.
 *
 * GitHub is faked at `fetch` (the #2485 seam), as in untrackedTaskItems3125.test.ts.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { lockWorkersForAssignment } from '../../../lib/agentTasks/workerLock.js';
import { taskStallTick } from '../../../jobs/taskStallEvaluator.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { resolveRunTools } from '../../../lib/runner/tools/index.js';
import { admitAndExecuteTool, ToolDeniedError } from '../../../lib/runner/toolAdmission.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from '../../../lib/runner/tools/types.js';
import { resolvers, type Context } from './resolvers.js';
import { createStartedClaimFor, loadApp } from './resolvers.agentTask.js';
import { typeDefs } from './typeDefs.js';
import { readFileSync } from 'node:fs';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;

const INSTALLATION_ID = 313203;
const TOKEN = 'ghs_SYNTHETIC3132tokenNEVERreal000000000000';
const APP_KEY_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

// --- fake GitHub (one page per repository; open issues only) ---------------------------------

let repos: Record<string, Array<{ number: number; title: string; url: string; createdAt: string }>>;
let calls: number;

async function fakeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = String(url);
  calls++;
  if (u.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      token: TOKEN, expires_at: '2026-11-02T07:00:00Z', permissions: body.permissions,
      repository_selection: 'selected', repositories: body.repositories.map((n: string) => ({ id: 1, full_name: `acme/${n}` })),
    }), { status: 201 });
  }
  if (u === 'https://api.github.com/graphql') {
    const { name } = JSON.parse(String(init?.body)).variables as { name: string };
    return new Response(JSON.stringify({
      data: { repository: { issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: (repos[name] ?? []).map((i) => ({
          ...i, updatedAt: '2026-10-30T10:00:00Z',
          labels: { nodes: [], pageInfo: { hasNextPage: false } },
          closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
        })),
      } } },
    }), { status: 200 });
  }
  return new Response('unexpected url', { status: 599 });
}
const issue = (n: number) => ({ number: n, title: `widgets issue ${n}`, url: `https://github.com/acme/widgets/issues/${n}`, createdAt: `2026-10-${String(n).padStart(2, '0')}T10:00:00Z` });

// --- fixtures -------------------------------------------------------------------------------

let org: any, app: any, otherApp: any, agentId: string;
let member: any, member2: any, outsider: any, anne: any, zed: any;
let keyX: any, keyY: any;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
const keyCtx = (appId: string, appKeyId: string, extra: Partial<Context> = {}): Context => ({ db, appId, appKeyId, roles: [], ...extra });
const claim = (args: Record<string, unknown>, c: Context) => M.claimUntrackedTaskItems({}, { appRef: app.id, integration: 'gh', ...args }, c);
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e: any) { return { message: e?.message, code: e?.extensions?.code, extensions: e?.extensions }; }
  throw new Error('expected a refusal');
};
// #2553: AT0, the App's reserved "No project" row, is not a claim.
const claimedTasks = () => db.agentTask.findMany({ where: { appId: app.id, externalId: { not: null } } });
const eventsOf = (taskId: string) => db.agentTeamEvent.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const noWrites = async () => {
  expect(await claimedTasks()).toEqual([]);
  expect(await db.agentTeamEvent.count({ where: { actorAppKeyId: { not: null } } })).toBe(0);
};

async function mintRun(extra: Record<string, unknown> = {}, forApp = app.id): Promise<AppRun> {
  return db.appRun.create({
    data: { id: generateId(), organizationId: org.id, appId: forApp, triggerKind: 'MANUAL', entryNodeUrn: 'ut-org::mem::flow:entry', status: 'RUNNING', ...extra },
  });
}
const toolCtx = (run: AppRun): RunToolContext => ({ log: vi.fn(), db, run, principal: runContext(db, run) });
const tool = (name: string) => resolveRunTools([name]).tools.find((t) => t.name === name)!;

beforeEach(async () => {
  await cleanDb(db);
  repos = { widgets: [issue(1), issue(2)] };
  calls = 0;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubEnv('GITHUB_APP_ID', '3132300');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', APP_KEY_PEM);

  const suffix = generateId().slice(-8);
  org = await db.organization.create({ data: { name: 'ut', urn: `ut32-${suffix}.test`, githubInstallationId: INSTALLATION_ID } });
  agentId = (await db.agent.create({ data: { name: 'Agent', urn: `${org.urn}:agent`, organizationId: org.id } })).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  [member, member2, outsider] = await Promise.all(['m1', 'm2', 'out'].map((h) => db.user.create({ data: { handle: `ut3132-${h}-${suffix}` } })));
  for (const u of [member, member2]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  await db.appMember.create({ data: { appId: otherApp.id, userId: outsider.id, role: 'member' } });
  const worker = (appId: string, name: string) => db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name, slug: name.toLowerCase(), heldByUserId: member.id, heldAt: new Date() },
    select: { id: true },
  });
  anne = await worker(app.id, 'Anne');
  zed = await worker(otherApp.id, 'Zed');
  const key = (appId: string) => db.appKey.create({ data: { appId, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
  [keyX, keyY] = await Promise.all([key(app.id), key(otherApp.id)]);
  await db.app.update({ where: { id: app.id }, data: { properties: { taskIntegrations: [{ name: 'gh', provider: 'github', repositories: ['acme/widgets'] }] } as never } });
  await db.app.update({ where: { id: otherApp.id }, data: { properties: { taskIntegrations: [{ name: 'gh-other', provider: 'github', repositories: ['acme/widgets'] }] } as never } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ANNE = () => ({ worker: anne.id });
const OWNER = () => ({ user: member.id });

// --- the App key's claim --------------------------------------------------------------------

describe("an App key's claim (cor:agt:120:03, V45 point 12)", () => {
  it('without an assignee is TASK_ASSIGNEE_REQUIRED, before any GitHub call, writing nothing', async () => {
    expect((await refusal(claim({ owner: OWNER() }, keyCtx(app.id, keyX.id)))).code).toBe('TASK_ASSIGNEE_REQUIRED');
    expect(calls).toBe(0);
    await noWrites();
  });

  it('with an assignee and no owner is TASK_OWNER_REQUIRED, before any GitHub call (a key acts for nobody)', async () => {
    expect((await refusal(claim({ assignee: ANNE() }, keyCtx(app.id, keyX.id)))).code).toBe('TASK_OWNER_REQUIRED');
    expect(calls).toBe(0);
    await noWrites();
  });

  it('naming a worker and an owner creates the task started, assigned to that worker, owned as named', async () => {
    const r = await claim({ assignee: ANNE(), owner: OWNER() }, keyCtx(app.id, keyX.id));
    expect(r).toMatchObject({ complete: true, incompleteReason: null, refusalCode: null });
    expect(r.tasks).toHaveLength(1);
    const [t] = await claimedTasks();
    expect(t).toMatchObject({
      status: 'started', assigneeWorkerId: anne.id, assigneeUserId: null, ownerUserId: member.id, ownerWorkerId: null,
      externalId: 'https://github.com/acme/widgets/issues/1',
      createdBy: null, createdByWorkerId: null, createdByAgentId: null, createdByRunId: null, assignedBy: null, assignedByWorkerId: null,
    });
    expect(t!.startedAt).not.toBeNull();
  });

  it('records task.created, task.assigned, task.started with the key as actor and the worker assignee as subject, all in one transaction', async () => {
    await claim({ assignee: ANNE(), owner: OWNER() }, keyCtx(app.id, keyX.id));
    const [t] = await claimedTasks();
    const ev = await eventsOf(t!.id);
    expect(ev.map((e) => e.type)).toEqual(['task.created', 'task.assigned', 'task.started']);
    for (const e of ev) {
      expect(e).toMatchObject({ actorAppKeyId: keyX.id, actorUserId: null, actorWorkerId: null, actorAgentId: null, actorRunId: null, subjectWorkerId: anne.id, subjectUserId: null });
    }
    // One transaction: the task row and its events were written by the same transaction id.
    const xmins = await db.$queryRaw<Array<{ x: string }>>`
      SELECT xmin::text AS x FROM agent_team_events WHERE task_id = ${t!.id}
      UNION SELECT xmin::text FROM agent_tasks WHERE id = ${t!.id}`;
    expect(xmins).toHaveLength(1);
  });

  it('a person assignee is recorded as the subject user, never as the actor', async () => {
    await claim({ assignee: { user: member2.id }, owner: OWNER() }, keyCtx(app.id, keyX.id));
    const [t] = await claimedTasks();
    expect(t).toMatchObject({ assigneeUserId: member2.id, status: 'started' });
    for (const e of await eventsOf(t!.id)) {
      expect(e).toMatchObject({ actorAppKeyId: keyX.id, actorUserId: null, subjectUserId: member2.id, subjectWorkerId: null });
    }
  });

  it('raises no not-started alarm for the claimed task', async () => {
    await claim({ assignee: ANNE(), owner: OWNER() }, keyCtx(app.id, keyX.id));
    const [t] = await claimedTasks();
    await taskStallTick(db, new Date(Date.now() + 7 * 24 * 3600_000));
    expect(await db.agentTeamEvent.count({ where: { taskId: t!.id, type: 'stall.not-started' } })).toBe(0);
  });

  it('an assignee or owner outside the App is refused exactly as createAgentTask refuses it, before any GitHub call', async () => {
    const viaCreate = async (input: Record<string, unknown>) => refusal(M.createAgentTask({}, { input: { appRef: app.id, title: 't', ...input } }, ctx(member.id)));
    const a = await refusal(claim({ assignee: { worker: zed.id }, owner: OWNER() }, keyCtx(app.id, keyX.id)));
    expect(a).toEqual(await viaCreate({ assignee: { worker: zed.id } }));
    expect(a.code).toBe('TASK_ASSIGNEE_INVALID');
    const o = await refusal(claim({ assignee: ANNE(), owner: { user: outsider.id } }, keyCtx(app.id, keyX.id)));
    expect(o).toEqual(await viaCreate({ owner: { user: outsider.id } }));
    expect(o.code).toBe('TASK_OWNER_INVALID');
    expect(calls).toBe(0);
    await noWrites();
  });

  it("App B's key naming A's integration answers as missing, the same whether A has it or not", async () => {
    const asB = (appRef: string, integration: string) => refusal(M.claimUntrackedTaskItems({}, { appRef, integration, assignee: { worker: zed.id }, owner: { user: outsider.id } }, keyCtx(otherApp.id, keyY.id)));
    const onA = await asB(app.id, 'gh');
    const ownGh = await asB(otherApp.id, 'gh');
    await db.app.update({ where: { id: app.id }, data: { properties: {} as never } });
    expect(await asB(app.id, 'gh')).toEqual(onA);
    expect(await asB(otherApp.id, 'gh')).toEqual(ownGh);
    expect(onA.code).toBe('APP_NOT_FOUND');
    expect(ownGh).toEqual(await asB(otherApp.id, 'nothing-here'));
    expect(ownGh.code).toBe('TASK_INTEGRATION_NOT_FOUND');
    expect(calls).toBe(0);
    await noWrites();
  });

  it('a revoked key is APP_NOT_FOUND and writes nothing', async () => {
    await db.appKey.update({ where: { id: keyX.id }, data: { revokedAt: new Date() } });
    expect((await refusal(claim({ assignee: ANNE(), owner: OWNER() }, keyCtx(app.id, keyX.id)))).code).toBe('APP_NOT_FOUND');
    expect(calls).toBe(0);
    await noWrites();
  });

  it('the key of a deleted App, or of an App whose org is deleted, is APP_NOT_FOUND and writes nothing', async () => {
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect((await refusal(claim({ assignee: ANNE(), owner: OWNER() }, keyCtx(app.id, keyX.id)))).code).toBe('APP_NOT_FOUND');
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: null } });
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect((await refusal(claim({ assignee: ANNE(), owner: OWNER() }, keyCtx(app.id, keyX.id)))).code).toBe('APP_NOT_FOUND');
    expect(calls).toBe(0);
    await noWrites();
  });

  it('a key request carrying a worker session is APP_KEY_SESSION_BOUND and writes nothing', async () => {
    const r = await refusal(runAsActor({ workerId: anne.id, agentId }, () => claim({ assignee: ANNE(), owner: OWNER() }, keyCtx(app.id, keyX.id))));
    expect(r.code).toBe('APP_KEY_SESSION_BOUND');
    expect(calls).toBe(0);
    await noWrites();
  });

  it('a person or worker claims for themselves: naming an assignee or owner is BAD_USER_INPUT, before any GitHub call', async () => {
    expect((await refusal(claim({ assignee: ANNE() }, ctx(member.id)))).code).toBe('BAD_USER_INPUT');
    expect((await refusal(claim({ owner: OWNER() }, ctx(member.id)))).code).toBe('BAD_USER_INPUT');
    expect(calls).toBe(0);
  });

  it('TASK_CLAIM_PRINCIPAL_UNSUPPORTED is gone from the schema and the code', () => {
    expect(typeDefs).not.toContain('TASK_CLAIM_PRINCIPAL_UNSUPPORTED');
    const src = readFileSync(new URL('./resolvers.untrackedTaskItems.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('TASK_CLAIM_PRINCIPAL_UNSUPPORTED');
  });
});

// --- the key write gate under the locks -----------------------------------------------------

describe("the key's claim write is judged under the App's anchors (held locks, not timing)", () => {
  const item = { title: 'held', url: 'https://github.com/acme/widgets/issues/9' };
  const parties = () => ({ owner: { userId: member.id }, assignee: { workerId: anne.id } });
  const anchors = () => [{ kind: 'app' as const, id: app.id }, { kind: 'org' as const, id: org.id }];

  it('a revocation that commits while the claim waits on the anchors leaves the claim refused, nothing written', async () => {
    const fresh = (await loadApp(ctx(), app.id))!;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const revoker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, anchors(), 'exclusive');
      await tx.appKey.update({ where: { id: keyX.id }, data: { revokedAt: new Date() } });
      await held;
    }, { timeout: 20_000 });
    // The revoker holds the anchors before the claim asks for them.
    await new Promise((r) => setTimeout(r, 50));
    const p = refusal(createStartedClaimFor(keyCtx(app.id, keyX.id), fresh, { kind: 'appKey', appKeyId: keyX.id }, item, parties()));
    await waitForLockWaitersOfType(db, 'advisory', 1);
    release();
    await revoker;
    expect((await p).code).toBe('APP_NOT_FOUND');
    await noWrites();
  });

  it('a claim that holds the anchors first commits, and the revocation waits for it', async () => {
    const fresh = (await loadApp(ctx(), app.id))!;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // Hold the assignee's per-worker lock: the claim takes the anchors SHARED, then waits here.
    const holder = db.$transaction(async (tx) => { await lockWorkersForAssignment(tx, [anne.id]); await held; }, { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 50));
    const claiming = createStartedClaimFor(keyCtx(app.id, keyX.id), fresh, { kind: 'appKey', appKeyId: keyX.id }, item, parties());
    await waitForLockWaitersOfType(db, 'advisory', 1);
    let revokedAt: Date | null = null;
    const revoker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, anchors(), 'exclusive');
      revokedAt = new Date();
      await tx.appKey.update({ where: { id: keyX.id }, data: { revokedAt } });
    }, { timeout: 20_000 });
    await waitForLockWaitersOfType(db, 'advisory', 2);
    release();
    await holder;
    const task = await claiming;
    await revoker;
    expect(task).toMatchObject({ status: 'started', assigneeWorkerId: anne.id });
    expect(revokedAt).not.toBeNull();
    expect((await db.agentTeamEvent.findMany({ where: { taskId: task!.id } })).every((e) => e.actorAppKeyId === keyX.id)).toBe(true);
  });
});

// --- no wider key writes ---------------------------------------------------------------------

describe('the claim is the only task write a key makes (cor:agt:050:23)', () => {
  let taskId: string;
  beforeEach(async () => {
    const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'existing', assignee: { user: member.id } } }, ctx(member.id));
    taskId = t.id;
  });
  const k = () => keyCtx(app.id, keyX.id);
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['createAgentTask', () => M.createAgentTask({}, { input: { appRef: app.id, title: 'by key', owner: { user: member.id } } }, k())],
    ['startAgentTask', () => M.startAgentTask({}, { taskId }, k())],
    ['finishAgentTask', () => M.finishAgentTask({}, { taskId, result: { outcome: 'done' } }, k())],
    ['assignAgentTask', () => M.assignAgentTask({}, { taskId, assignee: ANNE() }, k())],
    ['reassignAgentTask', () => M.reassignAgentTask({}, { taskId, assignee: ANNE() }, k())],
    ['cancelAgentTask', () => M.cancelAgentTask({}, { taskId }, k())],
    ['parkAgentTask', () => M.parkAgentTask({}, { taskId }, k())],
    ['recordAgentTaskProgress', () => M.recordAgentTaskProgress({}, { taskId }, k())],
    ['setAgentTaskPriority', () => M.setAgentTaskPriority({}, { taskRef: taskId, priority: 3 }, k())],
  ];
  for (const [name, call] of cases) {
    it(`${name} by the App's own key is still refused, writing nothing`, async () => {
      const before = await db.agentTask.findUniqueOrThrow({ where: { id: taskId } });
      const r = await refusal(call());
      expect(['APP_NOT_FOUND', 'TASK_NOT_FOUND']).toContain(r.code);
      expect(await db.agentTask.findUniqueOrThrow({ where: { id: taskId } })).toEqual(before);
      expect(await db.agentTask.count({ where: { appId: app.id, title: 'by key' } })).toBe(0);
    });
  }
});

// --- the run's claim and the run tools -------------------------------------------------------

describe('a run claims through hadron_task_untracked_claim', () => {
  it('the tools: list costs 0, claim costs 1 (one item per call)', () => {
    const { tools, unknown } = resolveRunTools(['hadron_task_untracked_list', 'hadron_task_untracked_claim']);
    expect(unknown).toEqual([]);
    expect(tools.find((t) => t.name === 'hadron_task_untracked_list')?.cost).toBe(0);
    expect(tools.find((t) => t.name === 'hadron_task_untracked_claim')?.cost).toBe(1);
  });

  it("a run of A lists A's items", async () => {
    const run = await mintRun();
    const page: any = await tool('hadron_task_untracked_list').execute(toolCtx(run), { integration: 'gh' });
    expect(page.items.map((i: any) => i.url)).toEqual(['https://github.com/acme/widgets/issues/1', 'https://github.com/acme/widgets/issues/2']);
  });

  it('a run acting for a person: owner = that person, started for the worker named, the run as actor and the worker as subject', async () => {
    const run = await mintRun({ userId: member.id });
    const out: any = await tool('hadron_task_untracked_claim').execute(toolCtx(run), { integration: 'gh', assignee: ANNE() });
    expect(out.task).toMatchObject({ status: 'started', externalId: 'https://github.com/acme/widgets/issues/1' });
    const [t] = await claimedTasks();
    expect(t).toMatchObject({ ownerUserId: member.id, assigneeWorkerId: anne.id, createdByRunId: run.id, createdBy: null, assignedBy: null });
    const ev = await eventsOf(t!.id);
    expect(ev.map((e) => e.type)).toEqual(['task.created', 'task.assigned', 'task.started']);
    for (const e of ev) expect(e).toMatchObject({ actorRunId: run.id, actorUserId: null, actorWorkerId: null, actorAppKeyId: null, subjectWorkerId: anne.id, subjectUserId: null });
    expect(await claimedTasks()).toHaveLength(1);
  });

  it('the subject user is recorded when the run does not resolve the assignee, and not when it is the person the run acts for', async () => {
    const run = await mintRun({ userId: member.id });
    await tool('hadron_task_untracked_claim').execute(toolCtx(run), { integration: 'gh', assignee: { user: member.id } });
    await tool('hadron_task_untracked_claim').execute(toolCtx(run), { integration: 'gh', assignee: { user: member2.id } });
    const [self, other] = await db.agentTask.findMany({ where: { appId: app.id, externalId: { not: null } }, orderBy: { externalId: 'asc' } });
    for (const e of await eventsOf(self!.id)) expect(e.subjectUserId).toBeNull();
    for (const e of await eventsOf(other!.id)) expect(e).toMatchObject({ subjectUserId: member2.id, actorRunId: run.id, actorUserId: null });
  });

  it('a run that acts for no person and names no owner is TASK_OWNER_REQUIRED; with no assignee TASK_ASSIGNEE_REQUIRED; before any GitHub call', async () => {
    const run = await mintRun();
    expect((await refusal(tool('hadron_task_untracked_claim').execute(toolCtx(run), { integration: 'gh', assignee: ANNE() }))).code).toBe('TASK_OWNER_REQUIRED');
    expect((await refusal(tool('hadron_task_untracked_claim').execute(toolCtx(run), { integration: 'gh', owner: OWNER() }))).code).toBe('TASK_ASSIGNEE_REQUIRED');
    expect(calls).toBe(0);
    const out: any = await tool('hadron_task_untracked_claim').execute(toolCtx(run), { integration: 'gh', assignee: ANNE(), owner: { worker: anne.id } });
    expect(out.task.status).toBe('started');
  });

  it("a run of B naming A's integration answers as missing, the same whether A has it or not; naming A's App is APP_NOT_FOUND", async () => {
    const run = await mintRun({ userId: outsider.id }, otherApp.id);
    const args = { integration: 'gh', assignee: { worker: zed.id } };
    const viaClaim = await refusal(tool('hadron_task_untracked_claim').execute(toolCtx(run), args));
    const viaList = await refusal(tool('hadron_task_untracked_list').execute(toolCtx(run), { integration: 'gh' }));
    const named = await refusal(tool('hadron_task_untracked_list').execute(toolCtx(run), { integration: 'gh', appRef: app.id }));
    await db.app.update({ where: { id: app.id }, data: { properties: {} as never } });
    expect(await refusal(tool('hadron_task_untracked_claim').execute(toolCtx(run), args))).toEqual(viaClaim);
    expect(await refusal(tool('hadron_task_untracked_list').execute(toolCtx(run), { integration: 'gh' }))).toEqual(viaList);
    expect(viaClaim.code).toBe('TASK_INTEGRATION_NOT_FOUND');
    expect(viaList.code).toBe('TASK_INTEGRATION_NOT_FOUND');
    expect(named.code).toBe('APP_NOT_FOUND');
    expect(calls).toBe(0);
    expect(await claimedTasks()).toEqual([]);
  });

  it('a finished run lists and claims nothing: APP_NOT_FOUND', async () => {
    const run = await mintRun({ userId: member.id, status: 'COMPLETED' });
    expect((await refusal(tool('hadron_task_untracked_list').execute(toolCtx(run), { integration: 'gh' }))).code).toBe('APP_NOT_FOUND');
    expect((await refusal(tool('hadron_task_untracked_claim').execute(toolCtx(run), { integration: 'gh', assignee: ANNE() }))).code).toBe('APP_NOT_FOUND');
    expect(calls).toBe(0);
    expect(await claimedTasks()).toEqual([]);
  });

  it('a claim whose activation is denied writes nothing and calls no tracker', async () => {
    const run = await mintRun({ userId: member.id });
    const asked: Array<[string, number]> = [];
    const p = admitAndExecuteTool(tool('hadron_task_untracked_claim'), { integration: 'gh', assignee: ANNE() }, {
      toolCtx: toolCtx(run),
      onToolCall: async (action, cost) => { asked.push([action, cost]); return false; },
    });
    await expect(p).rejects.toBeInstanceOf(ToolDeniedError);
    expect(asked).toEqual([['tool.hadron_task_untracked_claim', 1]]);
    expect(calls).toBe(0);
    expect(await claimedTasks()).toEqual([]);
  });
});
