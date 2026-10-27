/**
 * #2553 (epic #1704, T12, rev 6): every AgentTask has a hierarchical, immutable handle `AT<n>(.<n>)*`: a project is
 * numbered per App (AT3), a task within its parent (AT3.405, AT3.405.16). `AT0` is the reserved project "No project",
 * the parent of every task made with no project (AT0.388). An alias for the id, never a replacement: numbers are
 * permanent, parentage is fixed at creation, and a handle that names no readable task answers byte-identically to an
 * unknown id (cor:agt:050:01 Proposed handle paragraph, cor:agt:050:21).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const T = (resolvers as any).AgentTask as Record<string, (t: any, a: unknown, c: Context) => unknown>;

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError; }
  return expect.fail('expected a refusal');
}

let org: { id: string; urn: string };
let alice: { id: string }; // ADMIN member of the org, AppMember of X and Y: belongs to two Apps
let bob: { id: string };   // AppMember of X only: belongs to one App
let eve: { id: string };   // belongs to no App
let appX: { id: string; urn: string };
let appY: { id: string; urn: string };
let appZ: { id: string; urn: string }; // another org; alice cannot read it
let keyX: { id: string };
let agentId: string;
let anne: { id: string };

const as = (u: { id: string }): Context => ({ db, userId: u.id, roles: ['READER'] });
const keyCtx = (): Context => ({ db, appId: appX.id, appKeyId: keyX.id, roles: [] });
const mk = (app: { id: string }, title: string, u = alice) => M.createAgentTask({}, { input: { appRef: app.id, title } }, as(u));
const user = (githubId: number) => db.user.create({ data: { id: generateId(), githubId, githubUsername: `u${githubId}-${generateId().slice(0, 6)}`, roles: ['READER'] }, select: { id: true } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'h-org', urn: `h-org-${suffix}.com` } });
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'z-org', urn: `z-org-${suffix}.com` } });
  alice = await user(99_201);
  bob = await user(99_202);
  eve = await user(99_203);
  const zed = await user(99_204);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: alice.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: zed.id, role: 'ADMIN' } });
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  appZ = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Z', urn: `${otherOrg.urn}:z` } });
  await db.appMember.create({ data: { appId: appX.id, userId: alice.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appY.id, userId: alice.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appX.id, userId: bob.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appZ.id, userId: zed.id, role: 'member' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, as(alice));
  agentId = agent.id;
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: appX.id, agentId, name: 'Anne', slug: 'anne' }, select: { id: true } });
  keyX = await db.appKey.create({ data: { id: generateId(), appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
});

/** A project: a top-level task (AT1, AT2, ...). */
const project = (app: { id: string }, title: string, u = alice, extra: Record<string, unknown> = {}) =>
  M.createAgentTask({}, { input: { appRef: app.id, title, project: true, ...extra } }, as(u));
/** A task with no project: AT0.<n>. */
const handleOf = (t: any) => T.handle!(t, {}, as(alice)) as string;

describe('numbering', () => {
  it('N parallel creates with no project get distinct gap-free numbers under AT0; another App counts on its own', async () => {
    const made = await Promise.all(Array.from({ length: 8 }, (_, i) => mk(appX, `t${i}`)));
    expect(made.map((t: any) => handleOf(t)).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `AT0.${i + 1}`).sort());
    expect(handleOf(await mk(appY, 'first on Y'))).toBe('AT0.1');
  });

  it('projects are numbered per App from 1, tasks within a project from 1, deeper tasks per parent', async () => {
    const p1: any = await project(appX, 'epic one', alice, { assignee: { user: bob.id } });
    const p2: any = await project(appX, 'epic two', alice, { assignee: { user: bob.id } });
    expect([handleOf(p1), handleOf(p2)]).toEqual(['AT1', 'AT2']);
    const c1: any = await M.createAgentTask({}, { input: { parentTaskId: p1.id, title: 'c1', assignee: { user: bob.id } } }, as(bob));
    const c2: any = await M.createAgentTask({}, { input: { parentTaskId: 'AT1', title: 'c2' } }, as(bob));
    const d1: any = await M.createAgentTask({}, { input: { parentTaskId: 'AT1.1', title: 'd1' } }, as(bob));
    const other: any = await M.createAgentTask({}, { input: { parentTaskId: 'AT2', title: 'o1' } }, as(bob));
    expect([c1, c2, d1, other].map(handleOf)).toEqual(['AT1.1', 'AT1.2', 'AT1.1.1', 'AT2.1']);
    expect(await T.taskNumber!(d1, {}, as(alice))).toBe(1);
    expect(d1.parentTaskId).toBe(c1.id);
    expect(await refusal(project(appX, 'x', alice, { parentTaskId: p1.id }))).toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(handleOf(await project(appY, 'Y epic'))).toBe('AT1');
  });

  it('AT0 exists once per App before its first task, owned by the creator, a backlog row named "No project"; projects start at 1', async () => {
    await mk(appX, 'a');
    const zero = await db.agentTask.findMany({ where: { appId: appX.id, handle: 'AT0' } });
    expect(zero).toHaveLength(1);
    expect(zero[0]).toMatchObject({ title: 'No project', status: 'backlog', taskNumber: 0n, parentTaskId: null, ownerUserId: alice.id, assigneeUserId: null });
    const counter = await db.agentTaskCounter.findMany({ where: { appId: appX.id, parentTaskId: null } });
    expect(counter.map((c) => c.lastNumber)).toEqual([0n]);
    await mk(appX, 'b');
    expect(await db.agentTask.count({ where: { appId: appX.id, handle: 'AT0' } })).toBe(1);
    expect(handleOf(await project(appX, 'first project'))).toBe('AT1');
  });

  it('nothing else can take 0: only the AT0 row may carry it, and a writer that states no number never gets it', async () => {
    await mk(appX, 'a');
    const raw = await db.agentTask.create({ data: { appId: appX.id, title: 'raw project', ownerUserId: alice.id } });
    expect(raw.handle).toBe('AT1');
    const bad = [
      { title: 'zero project', ownerUserId: alice.id, taskNumber: 0n, handle: 'AT0' }, // a second AT0
      { title: 'zero below', ownerUserId: alice.id, taskNumber: 0n, handle: 'AT1.0', parentTaskId: raw.id },
      { title: 'zero lookalike', ownerUserId: alice.id, taskNumber: 0n, handle: 'AT00' },
    ];
    for (const data of bad) await expect(db.agentTask.create({ data: { appId: appX.id, ...data } })).rejects.toThrow();
  });

  it('a committed number is permanent: cancelling does not free it, a rolled-back create returns it', async () => {
    const a: any = await mk(appX, 'a');
    await M.cancelAgentTask({}, { taskId: a.id }, as(alice));
    expect(handleOf(await mk(appX, 'b'))).toBe('AT0.2');
    await expect(db.$transaction(async (tx) => {
      await tx.agentTask.create({ data: { appId: appX.id, title: 'doomed', ownerUserId: alice.id, parentTaskId: a.parentTaskId } });
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    expect(handleOf(await mk(appX, 'after'))).toBe('AT0.3');
  });

  it('a writer that states no number still gets number and handle; number, handle and parent can never change', async () => {
    const t: any = await mk(appX, 'a');
    const row = await db.agentTask.create({ data: { appId: appX.id, title: 'raw', ownerUserId: alice.id, parentTaskId: t.parentTaskId } });
    expect([row.taskNumber, row.handle]).toEqual([2n, 'AT0.2']);
    const other = await db.agentTask.create({ data: { appId: appX.id, title: 'proj', ownerUserId: alice.id } });
    await expect(db.agentTask.update({ where: { id: row.id }, data: { taskNumber: 9n } })).rejects.toThrow(/permanent/);
    await expect(db.agentTask.update({ where: { id: row.id }, data: { handle: 'AT0.9' } })).rejects.toThrow(/permanent/);
    await expect(db.agentTask.update({ where: { id: row.id }, data: { parentTaskId: other.id } })).rejects.toThrow(/permanent/);
    await expect(db.agentTask.update({ where: { id: row.id }, data: { parentTaskId: null } })).rejects.toThrow(/permanent/);
    await expect(db.agentTask.create({ data: { appId: appX.id, title: 'dup', ownerUserId: alice.id, parentTaskId: t.parentTaskId, taskNumber: 1n, handle: 'AT0.1' } })).rejects.toThrow();
  });

  it('a reparent attempt is refused on every surface: no input takes a parent after creation', () => {
    const update = typeDefs.match(/input \w*(?:Update|Edit|Move|Reparent)\w*AgentTask\w* \{[^}]*\}/g) ?? [];
    for (const block of update) expect(block).not.toMatch(/parentTaskId/);
    const ops = Object.keys(M).filter((n) => /agenttask/i.test(n));
    expect(ops.filter((n) => /(move|reparent|update|edit)/i.test(n))).toEqual([]);
  });

  it('depth is bounded: a task under a 16-deep path is refused with TASK_TOO_DEEP, the 16th level is allowed', async () => {
    let parent = await db.agentTask.create({ data: { appId: appX.id, title: 'root', ownerUserId: bob.id, assigneeUserId: bob.id, assignedAt: new Date(), status: 'started', startedAt: new Date() } });
    for (let i = 1; i < 16; i += 1) {
      parent = await db.agentTask.create({ data: { appId: appX.id, title: `l${i}`, ownerUserId: bob.id, assigneeUserId: bob.id, assignedAt: new Date(), status: 'started', startedAt: new Date(), parentTaskId: parent.id } });
    }
    expect(parent.handle!.split('.')).toHaveLength(16);
    const e = await refusal(M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'too deep' } }, as(bob)));
    expect(e.extensions?.code).toBe('TASK_TOO_DEEP');
  });

  it('every task is created in the same transaction as its counter: creates under two parents and two Apps do not contend', async () => {
    const [pa, pb]: any[] = await Promise.all([project(appX, 'pa', alice, { assignee: { user: bob.id } }), project(appX, 'pb', alice, { assignee: { user: bob.id } })]);
    const made = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => M.createAgentTask({}, { input: { parentTaskId: pa.id, title: `a${i}` } }, as(bob))),
      ...Array.from({ length: 4 }, (_, i) => M.createAgentTask({}, { input: { parentTaskId: pb.id, title: `b${i}` } }, as(bob))),
      mk(appY, 'y'),
    ]);
    const handles = made.map(handleOf);
    expect(handles.filter((h: string) => h.startsWith(`${handleOf(pa)}.`)).sort()).toEqual([1, 2, 3, 4].map((n) => `${handleOf(pa)}.${n}`));
    expect(handles.filter((h: string) => h.startsWith(`${handleOf(pb)}.`)).sort()).toEqual([1, 2, 3, 4].map((n) => `${handleOf(pb)}.${n}`));
  });

  it('barrier: a create waiting on its parent counter blocks no other write in the App, then takes the next number', async () => {
    const t: any = await mk(appX, 'to cancel');
    const zeroId = t.parentTaskId as string;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM agent_task_counters WHERE parent_task_id = ${zeroId} FOR UPDATE`;
      locked();
      await held;
    });
    await lockedP;
    let createDone = false;
    const blockedCreate = mk(appX, 'waits on the counter').then((r: any) => { createDone = true; return r; });
    await waitForLockWaiters(db, 1);
    // A write to another task of the same App is not stuck behind the create: the App row is only an anchor.
    const cancelled = await M.cancelAgentTask({}, { taskId: t.id }, as(alice));
    expect(cancelled.status).toBe('cancelled');
    expect(createDone).toBe(false);
    release();
    await holder;
    expect(handleOf(await blockedCreate)).toBe('AT0.2');
  });

  it('a create racing task writes in the same App neither deadlocks nor duplicates a number', async () => {
    const seeded: any[] = await Promise.all(Array.from({ length: 4 }, (_, i) => mk(appX, `s${i}`)));
    const results = await Promise.all([
      ...seeded.map((t: any) => M.cancelAgentTask({}, { taskId: t.id }, as(alice))),
      ...Array.from({ length: 4 }, (_, i) => mk(appX, `n${i}`)),
    ]);
    expect(results).toHaveLength(8);
    const rows = await db.agentTask.findMany({ where: { appId: appX.id, handle: { startsWith: 'AT0.' } } });
    expect(new Set(rows.map((r) => r.handle)).size).toBe(8);
  });
});

describe('AT0 is the platform\'s own row (rev 6)', () => {
  it('reads by id or handle but never lists; `parentTaskId: AT0` and rootsOnly list the tasks with no project', async () => {
    const t: any = await mk(appX, 'no project');
    const pr: any = await project(appX, 'a project');
    const zero = await Q.agentTask({}, { id: 'AT0' }, as(bob));
    expect(zero).toMatchObject({ title: 'No project', status: 'backlog' });
    expect(await T.handle!(zero, {}, as(bob))).toBe('AT0');
    const all = await Q.agentTasks({}, { appRef: appX.id }, as(alice));
    expect(all.map((r: any) => r.id).sort()).toEqual([t.id, pr.id].sort());
    const under = await Q.agentTasks({}, { appRef: appX.id, parentTaskId: 'AT0' }, as(alice));
    expect(under.map((r: any) => r.id)).toEqual([t.id]);
    const roots = await Q.agentTasks({}, { appRef: appX.id, rootsOnly: true }, as(alice));
    expect(roots.map((r: any) => r.id).sort()).toEqual([t.id, pr.id].sort());
    expect(await Q.agentTasks({}, { appRef: appX.id, status: ['BACKLOG'] }, as(alice))).toEqual([]);
  });

  it('every operation on AT0 is refused with TASK_PROJECT_ZERO_FIXED and leaves the row unchanged', async () => {
    await mk(appX, 'a', bob);
    const snap = async () => JSON.stringify(await db.agentTask.findFirstOrThrow({ where: { appId: appX.id, handle: 'AT0' } }), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const before = await snap();
    const args = { taskId: 'AT0', assignee: { user: bob.id }, result: { outcome: 'succeeded', summary: 's' } };
    // Every mutation that takes a task, by the handle and by the qualified handle: one refusal code for all of them.
    const ops = ['assignAgentTask', 'parkAgentTask', 'makeAgentTaskReady', 'reassignAgentTask', 'startAgentTask', 'recordAgentTaskProgress', 'finishAgentTask', 'cancelAgentTask'];
    expect(ops.every((n) => typeof M[n] === 'function')).toBe(true);
    for (const name of ops) {
      for (const taskId of ['AT0', `hrn:agenttask:${appX.urn}:AT0`]) {
        expect((await refusal(M[name]({}, { ...args, taskId }, as(bob)))).extensions?.code, name).toBe('TASK_PROJECT_ZERO_FIXED');
      }
    }
    expect(await snap()).toBe(before);
    await expect(db.agentTask.update({ where: { id: (await db.agentTask.findFirstOrThrow({ where: { appId: appX.id, handle: 'AT0' } })).id }, data: { status: 'pending' } })).rejects.toThrow(/stays in backlog/);
  });

  it('naming AT0 as the parent is refused (by handle, by id, with an App, with project); a plain create takes the root path', async () => {
    const first = await mk(appX, 'seed', bob);
    const zero = await db.agentTask.findFirstOrThrow({ where: { appId: appX.id, handle: 'AT0' } });
    const before = await db.agentTask.count({ where: { appId: appX.id } });
    for (const input of [
      { parentTaskId: 'AT0', title: 'x' },
      { parentTaskId: zero.id, title: 'x' },
      { appRef: appX.id, parentTaskId: 'AT0', title: 'x' },
      { parentTaskId: 'AT0', project: true, title: 'x' },
    ]) {
      await expect(M.createAgentTask({}, { input }, as(bob))).rejects.toThrow();
    }
    expect(await db.agentTask.count({ where: { appId: appX.id } })).toBe(before);
    const plain: any = await M.createAgentTask({}, { input: { appRef: appX.id, title: 'plain' } }, as(bob));
    expect(handleOf(plain)).toBe('AT0.2');
    expect(handleOf(first)).toBe('AT0.1');
  });

  it('the stall owner chain stops below AT0: its fallback owner is not a parent owner', async () => {
    const { ownerChain } = await import('../../../lib/agentTasks/stall.js');
    const t: any = await mk(appX, 'rooted', bob);
    const zero = await db.agentTask.findFirstOrThrow({ where: { appId: appX.id, handle: 'AT0' } });
    await db.agentTask.update({ where: { id: zero.id }, data: { ownerUserId: alice.id } });
    const chain = await ownerChain(db, t.id);
    expect(chain.filter((p: any) => !p.via).map((p: any) => p.userId)).toEqual([bob.id]);
  });

  it('createApp gives the new App its AT0 in the same transaction, owned by the creator, before any task', async () => {
    const created: any = await M.createApp({}, { orgRef: org.id, agentRef: agentId, name: 'Fresh' }, as(alice));
    const zero = await db.agentTask.findMany({ where: { appId: created.id, handle: 'AT0' } });
    expect(zero).toHaveLength(1);
    expect(zero[0]).toMatchObject({ title: 'No project', status: 'backlog', taskNumber: 0n });
    expect(zero[0]!.ownerUserId).toBe(alice.id);
    expect(await db.agentTask.count({ where: { appId: created.id } })).toBe(1);
    const first: any = await mk(created, 'first', alice);
    expect(handleOf(first)).toBe('AT0.1');
  });

  it('the matcher and the stall evaluator never see it (backlog only)', async () => {
    await mk(appX, 'a');
    const zero = await db.agentTask.findFirstOrThrow({ where: { appId: appX.id, handle: 'AT0' } });
    expect(zero.status).toBe('backlog');
    expect(readFileSync(new URL('../../../lib/agentTasks/matcher.ts', import.meta.url), 'utf8')).toContain("status: 'pending'");
  });

  it('the App-create helper is idempotent and gives every App exactly one AT0', async () => {
    const { ensureProjectZero } = await import('../../../lib/agentTasks/projectZero.js');
    const ids = await db.$transaction(async (tx) => [
      await ensureProjectZero(tx, appX.id, { userId: alice.id }),
      await ensureProjectZero(tx, appX.id, { userId: bob.id }),
    ]);
    expect(ids[0]).toBe(ids[1]);
    expect(await db.agentTask.count({ where: { appId: appX.id, handle: 'AT0' } })).toBe(1);
    expect(await db.$transaction((tx) => ensureProjectZero(tx, appY.id, null))).toBeNull();
  });
});

describe('the migration', () => {
  const migrationSql = () => readFileSync(new URL('../../../../prisma/migrations/20261027060000_agent_task_number/migration.sql', import.meta.url), 'utf8');
  const invariants = () => readFileSync(new URL('../../../../prisma/agent-task-number-invariants.sql', import.meta.url), 'utf8');

  it('carries a byte-identical copy of the invariants file', () => {
    expect(migrationSql().endsWith(invariants())).toBe(true);
  });

  it('backfills legacy rows: parentless tasks under AT0 in created_at order, children per parent, counters at the counts, and a re-run changes nothing', async () => {
    const backfill = migrationSql().slice(0, migrationSql().length - invariants().length);
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      // The pre-migration shape: no number, no handle, no triggers or checks yet.
      await client.query(`
        DROP TRIGGER IF EXISTS trg_agent_tasks_assign_number ON agent_tasks;
        DROP TRIGGER IF EXISTS trg_agent_tasks_number_immutable ON agent_tasks;
        ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS chk_agent_tasks_handle;
        ALTER TABLE agent_tasks ALTER COLUMN task_number DROP NOT NULL;
        ALTER TABLE agent_tasks ALTER COLUMN handle DROP NOT NULL;`);
      const ins = (id: string, app: string, parent: string | null, at: string) => client.query(
        `INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, parent_task_id, close_session_when_done, created_at)
         VALUES ($1, $2, $1, 'pending', $3, $4, false, $5)`, [id, app, alice.id, parent, at]);
      await ins('legacy-a', appX.id, null, '2026-01-01T00:00:00Z');
      await ins('legacy-b', appX.id, null, '2026-01-02T00:00:00Z');
      await ins('legacy-b1', appX.id, 'legacy-b', '2026-01-03T00:00:00Z');
      await ins('legacy-b2', appX.id, 'legacy-b', '2026-01-04T00:00:00Z');
      await ins('legacy-b11', appX.id, 'legacy-b1', '2026-01-05T00:00:00Z');
      await ins('legacy-y', appY.id, null, '2026-01-01T00:00:00Z');
      await client.query(backfill);
      const read = async () => (await client.query(`SELECT id, handle, task_number::int AS n, (SELECT handle FROM agent_tasks p WHERE p.id = t.parent_task_id) AS parent FROM agent_tasks t WHERE app_id IN ($1, $2) ORDER BY app_id, handle`, [appX.id, appY.id])).rows;
      const once = await read();
      const byId = Object.fromEntries(once.map((r) => [r.id, r.handle]));
      expect(byId).toMatchObject({ 'legacy-a': 'AT0.1', 'legacy-b': 'AT0.2', 'legacy-b1': 'AT0.2.1', 'legacy-b2': 'AT0.2.2', 'legacy-b11': 'AT0.2.1.1', 'legacy-y': 'AT0.1' });
      const tops = (await client.query(`SELECT handle FROM agent_tasks WHERE app_id = $1 AND parent_task_id IS NULL`, [appX.id])).rows;
      expect(tops).toEqual([{ handle: 'AT0' }]);
      const counters = (await client.query(
        `SELECT t.handle AS parent, c.last_number::int AS n FROM agent_task_counters c LEFT JOIN agent_tasks t ON t.id = c.parent_task_id WHERE c.app_id = $1 ORDER BY t.handle NULLS FIRST`, [appX.id])).rows;
      expect(counters).toEqual([{ parent: null, n: 0 }, { parent: 'AT0', n: 2 }, { parent: 'AT0.2', n: 2 }, { parent: 'AT0.2.1', n: 1 }]);
      await client.query(backfill);
      expect(await read()).toEqual(once);
      await client.query(invariants());
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});

describe('resolution (item 3, 4, 5)', () => {
  it('a person in exactly one App reads by bare handle, case-insensitively; id still works', async () => {
    const t: any = await mk(appX, 'x1', bob);
    expect((await Q.agentTask({}, { id: 'AT0.1' }, as(bob)))?.id).toBe(t.id);
    expect((await Q.agentTask({}, { id: 'at0.1' }, as(bob)))?.id).toBe(t.id);
    expect((await Q.agentTask({}, { id: t.id }, as(bob)))?.id).toBe(t.id);
  });

  it('every task operation takes the handle', async () => {
    // Only the parent's assignee creates its children, so the parent is assigned to bob.
    const t: any = await M.createAgentTask({}, { input: { appRef: appX.id, title: 'ops', assignee: { user: bob.id } } }, as(bob));
    expect((await Q.agentTaskTree({}, { root: 'AT0.1' }, as(bob)))?.map((r: any) => r.id)).toEqual([t.id]);
    const child: any = await M.createAgentTask({}, { input: { parentTaskId: 'AT0.1', title: 'child' } }, as(bob));
    expect(child.parentTaskId).toBe(t.id);
    expect((await Q.agentTasks({}, { appRef: appX.id, parentTaskId: 'AT0.1' }, as(bob))).map((r: any) => r.id)).toEqual([child.id]);
    const events = await Q.agentTeamEvents({}, { appRef: appX.id, taskId: 'AT0.1.1' }, as(bob));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e: any) => e.taskId === child.id)).toBe(true);
    const cancelled = await M.cancelAgentTask({}, { taskId: 'AT0.1.1' }, as(bob));
    expect(cancelled.id).toBe(child.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('an App key reads by bare handle within its own App only', async () => {
    const x: any = await mk(appX, 'x1');
    await mk(appY, 'y1');
    expect((await Q.agentTask({}, { id: 'AT0.1' }, keyCtx()))?.id).toBe(x.id);
    expect(await Q.agentTask({}, { id: 'AT0.2' }, keyCtx())).toBeNull();
  });

  it('a worker session resolves a bare handle in the session\'s App', async () => {
    const x: any = await mk(appX, 'x1');
    const y: any = await mk(appY, 'y1');
    await mk(appY, 'y2');
    const got = await runAsActor({ workerId: anne.id, agentId }, () => Q.agentTask({}, { id: 'AT0.1' }, as(alice)));
    expect(got?.id).toBe(x.id);
    expect(got?.id).not.toBe(y.id);
    expect(await runAsActor({ workerId: anne.id, agentId }, () => Q.agentTask({}, { id: 'AT0.2' }, as(alice)))).toBeNull();
  });

  it('a person in several Apps: a bare handle is refused "qualify it", the same whether or not the number exists', async () => {
    await mk(appX, 'x1');
    const exists = await refusal(Q.agentTask({}, { id: 'AT0.1' }, as(alice)));
    const absent = await refusal(Q.agentTask({}, { id: 'AT0.999' }, as(alice)));
    expect(exists.extensions?.code).toBe('TASK_HANDLE_QUALIFY');
    expect(absent.extensions?.code).toBe('TASK_HANDLE_QUALIFY');
    expect(exists.message).toBe(absent.message);
    expect({ ...exists.extensions, taskId: null }).toEqual({ ...absent.extensions, taskId: null });
    const mutation = await refusal(M.cancelAgentTask({}, { taskId: 'AT0.1' }, as(alice)));
    expect(mutation.extensions?.code).toBe('TASK_HANDLE_QUALIFY');
  });

  it('the qualified form names the App by its URN, and resolves for a person in several Apps', async () => {
    const y: any = await mk(appY, 'y1');
    await mk(appX, 'x1');
    expect((await Q.agentTask({}, { id: `hrn:agenttask:${appY.urn}:AT0.1` }, as(alice)))?.id).toBe(y.id);
    expect((await Q.agentTask({}, { id: `hrn:agenttask:${appX.urn}:at0.1` }, as(alice)))?.id).not.toBe(y.id);
  });

  it('unknown, foreign-App and unreadable-App handles answer byte-identically to an unknown id, echo included', async () => {
    const z: any = await mk(appZ, 'z1', (await db.appMember.findFirstOrThrow({ where: { appId: appZ.id } }).then((m) => ({ id: m.userId }))));
    expect(z.taskNumber).toBeDefined();
    await mk(appX, 'x1', bob);
    const unknownId = generateId();
    const probes = [
      { input: unknownId },
      { input: 'AT0.999' },
      { input: `hrn:agenttask:${appZ.urn}:AT0.1` }, // an App bob cannot read
      { input: `hrn:agenttask:${appZ.urn}:AT0.999` },
      { input: `hrn:agenttask:no-such.org:app:AT0.1` },
    ];
    for (const who of [bob]) {
      for (const p of probes) {
        const e = await refusal(M.cancelAgentTask({}, { taskId: p.input }, as(who)));
        expect(e.extensions?.code).toBe('TASK_NOT_FOUND');
        expect(e.message).toBe('Task not found.');
        expect(e.extensions?.taskId).toBe(p.input);
        expect(Object.keys(e.extensions ?? {}).sort()).toEqual(['code', 'taskId']);
        expect(await Q.agentTask({}, { id: p.input }, as(who))).toBeNull();
      }
    }
    // The same for a person in no App, for a key asking about another App, and for a worker session.
    for (const p of probes) {
      expect(await Q.agentTask({}, { id: p.input }, as(eve))).toBeNull();
      expect(await Q.agentTask({}, { id: p.input }, keyCtx())).toBeNull();
      expect(await runAsActor({ workerId: anne.id, agentId }, () => Q.agentTask({}, { id: p.input }, as(alice)))).toBeNull();
    }
    expect((await refusal(M.cancelAgentTask({}, { taskId: 'AT0.1' }, as(eve)))).extensions?.code).toBe('TASK_NOT_FOUND');
  });

  it('a person who belongs to no App is told nothing a stranger would not hear', async () => {
    await mk(appX, 'x1');
    const e = await refusal(M.cancelAgentTask({}, { taskId: 'AT0.1' }, as(eve)));
    const f = await refusal(M.cancelAgentTask({}, { taskId: 'AT0.777' }, as(eve)));
    expect(e.extensions).toEqual({ code: 'TASK_NOT_FOUND', taskId: 'AT0.1' });
    expect(f.extensions).toEqual({ code: 'TASK_NOT_FOUND', taskId: 'AT0.777' });
  });

  it.each(['AT', 'AT-1', 'AT0312', 'AT03', 'AT3.0', 'AT3.05', 'AT3.', 'AT3..4', 'AT.3', 'AT312 ', ' AT312', 'AT99999999999999999999', 'AT1.9223372036854775808', 'XAT1', 'AT1x', `AT1${'.1'.repeat(16)}`])(
    'a malformed handle %j falls through to the unknown-id answer',
    async (bad) => {
      await mk(appX, 'x1', bob);
      expect(await Q.agentTask({}, { id: bad }, as(bob))).toBeNull();
      expect((await refusal(M.cancelAgentTask({}, { taskId: bad }, as(bob)))).extensions).toEqual({ code: 'TASK_NOT_FOUND', taskId: bad });
    },
  );

  it('AT0 and AT0.<n> are valid handles; a valid handle for no task is unknown, never an error', async () => {
    await mk(appX, 'x1', bob);
    expect((await Q.agentTask({}, { id: 'AT0' }, as(bob)))?.title).toBe('No project');
    for (const unknown of ['AT0.388', 'AT3.12', 'AT9223372036854775807', 'AT1.9223372036854775807']) {
      expect(await Q.agentTask({}, { id: unknown }, as(bob))).toBeNull();
    }
  });

  it('a task keeps its own source link: AT0.388 is not issue #388', async () => {
    const t: any = await M.createAgentTask({}, { input: { appRef: appX.id, title: 'linked', source: 'https://github.com/o/r/issues/388' } }, as(bob));
    expect(t.source).toBe('https://github.com/o/r/issues/388');
    expect(handleOf(t)).toBe('AT0.1');
  });
});
