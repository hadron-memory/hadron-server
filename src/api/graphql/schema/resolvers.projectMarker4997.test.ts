/**
 * #4997 (S2 of the team metrics, epic #3781): an explicit project marker on tasks.
 * hrn:node:hadronmemory.com:specs:cor:agt:050:01 (Project marker), :02 (What a clone does) and
 * hrn:node:hadronmemory.com:specs:cor:agt:150 (A project; What a project counts, R4: count once, nearest marked ancestor).
 *
 * - The marker is set only at create (`project: true` makes a top-level task AND marks it; `isProject` marks any task),
 *   never changed afterwards (the database refuses a direct change), and AT0 is never marked.
 * - A clone keeps the source's marker unless the call overrides it.
 * - The metrics read the marker, not the old "top-level task other than AT0" rule: every task is counted once, under its
 *   nearest marked ancestor, or in the visible "No project" bucket (AT0).
 * - The migration backfills exactly the rows S1 counts today, so no figure changes at deploy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError, buildASTSchema, parse } from 'graphql';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { loadStartedOwned, loadStartedProjects } from '../../../lib/agentTasks/teamMetrics.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError; }
  return expect.fail('expected a refusal');
}

let alice: { id: string };
let app: { id: string };
const as = (u: { id: string }): Context => ({ db, userId: u.id, roles: ['READER'] });
const create = (input: Record<string, unknown>) => M.createAgentTask({}, { input: { appRef: app.id, assignee: { user: alice.id }, ...input } }, as(alice));
const marked = async (id: string) => (await db.agentTask.findUniqueOrThrow({ where: { id }, select: { isProject: true } })).isProject;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'p-org', urn: `p-org-${suffix}.com` } });
  alice = await db.user.create({ data: { id: generateId(), handle: `pa-${generateId()}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: alice.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'P', urn: `${org.urn}:p` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: alice.id, role: 'member' } });
});

describe('#4997 create sets the marker (cor:agt:050:01 Project marker)', () => {
  it('project: true makes a top-level task AND marks it', async () => {
    const p = await create({ title: 'Top', project: true });
    expect(p.parentTaskId).toBeNull();
    expect(await marked(p.id)).toBe(true);
  });

  it('isProject marks a task under AT0 and a nested task; without either the marker is false', async () => {
    const underZero = await create({ title: 'Under AT0', isProject: true });
    expect(underZero.handle).toMatch(/^AT0\.\d+$/);
    expect(await marked(underZero.id)).toBe(true);
    const top = await create({ title: 'Top', project: true });
    const nested = await create({ title: 'Nested', parentTaskId: top.id, isProject: true });
    expect(await marked(nested.id)).toBe(true);
    const plain = await create({ title: 'Plain', parentTaskId: top.id });
    expect(await marked(plain.id)).toBe(false);
    expect(await marked((await create({ title: 'No project' })).id)).toBe(false);
  });

  it('a batch create keeps each item\'s own marker', async () => {
    const made = await M.createAgentTasks({}, { appRef: app.id, tasks: [
      { task: { title: 'Batch project', project: true } },
      { task: { title: 'Batch plain' } },
      { task: { title: 'Batch marked under AT0', isProject: true } },
    ] }, as(alice));
    expect(await Promise.all(made.map((t: { id: string }) => marked(t.id)))).toEqual([true, false, true]);
  });

  it('project: true with isProject: false is refused as a contradiction, and nothing is created', async () => {
    const before = await db.agentTask.count({ where: { appId: app.id } });
    const e = await refusal(create({ title: 'Contradiction', project: true, isProject: false }));
    expect(e.extensions?.code).toBe('BAD_USER_INPUT');
    expect(e.message).toMatch(/project: true .*isProject: false/);
    expect(await db.agentTask.count({ where: { appId: app.id } })).toBe(before);
  });

  it('AgentTask.isProject is a non-null Boolean, and no update input can carry the marker', async () => {
    const schema = buildASTSchema(typeof typeDefs === 'string' ? parse(typeDefs) : typeDefs);
    const update = schema.getType('UpdateAgentTaskInput') as any;
    expect(update, 'the update input exists').toBeDefined();
    expect(Object.keys(update.getFields())).not.toContain('isProject');
    expect(Object.keys(update.getFields())).not.toContain('project');
    const task = schema.getType('AgentTask') as any;
    expect(String(task.getFields().isProject.type)).toBe('Boolean!');
  });
});

describe('#4997 a clone keeps the marker unless overridden (cor:agt:050:02)', () => {
  const clone = (taskId: string, input: Record<string, unknown> = {}) => M.cloneAgentTask({}, { taskRef: taskId, input }, as(alice));

  it('a marked source makes a marked clone; an unmarked nested source makes an unmarked clone', async () => {
    const markedTop = await create({ title: 'Marked', project: true });
    const top = await clone(markedTop.id);
    expect(top.parentTaskId, 'a top-level source makes a top-level clone').toBeNull();
    expect(await marked(top.id)).toBe(true);
    const markedNested = await create({ title: 'Marked nested', parentTaskId: markedTop.id, isProject: true });
    expect(await marked((await clone(markedNested.id)).id)).toBe(true);
    const plainNested = await create({ title: 'Plain nested', parentTaskId: markedTop.id });
    expect(await marked((await clone(plainNested.id)).id)).toBe(false);
  });

  it('isProject overrides the copied marker; project: true marks; a contradiction is refused', async () => {
    const markedTop = await create({ title: 'Marked', project: true });
    const parent = await create({ title: 'Parent', project: true });
    const moved = await clone(markedTop.id, { isProject: false, parentTaskId: parent.id });
    expect(moved.parentTaskId).toBe(parent.id);
    expect(await marked(moved.id), 'a clone given a parent may drop the marker').toBe(false);
    const underZero = await clone(markedTop.id, { project: false });
    expect(await marked(underZero.id), 'project: false places it under AT0, unmarked').toBe(false);
    const plain = await create({ title: 'Plain' });
    expect(await marked((await clone(plain.id, { isProject: true })).id)).toBe(true);
    expect(await marked((await clone(plain.id, { project: true })).id)).toBe(true);
    const e = await refusal(clone(plain.id, { project: true, isProject: false }));
    expect(e.extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('a top-level clone with isProject: false is the same contradiction, refused before any write (Bindi F2)', async () => {
    const markedTop = await create({ title: 'Marked', project: true });
    const before = await db.agentTask.count({ where: { appId: app.id } });
    const e = await refusal(clone(markedTop.id, { isProject: false }));
    expect(e.extensions?.code).toBe('BAD_USER_INPUT');
    expect(e.message).toMatch(/project: true makes a project/);
    expect(await db.agentTask.count({ where: { appId: app.id } })).toBe(before);
  });
});

describe('#4997 the database keeps the marker permanent and AT0 unmarked', () => {
  it('a direct change of is_project is refused both ways; AT0 cannot be marked on insert or update', async () => {
    const p = await create({ title: 'Top', project: true });
    const plain = await create({ title: 'Plain' });
    await expect(db.$executeRawUnsafe(`UPDATE agent_tasks SET is_project = false WHERE id = $1`, p.id)).rejects.toThrow(/is_project is set at creation and never changed/);
    await expect(db.$executeRawUnsafe(`UPDATE agent_tasks SET is_project = true WHERE id = $1`, plain.id)).rejects.toThrow(/is_project is set at creation and never changed/);
    const zero = await db.agentTask.findFirstOrThrow({ where: { appId: app.id, handle: 'AT0' } });
    expect(zero.isProject).toBe(false);
    await expect(db.$executeRawUnsafe(`UPDATE agent_tasks SET is_project = true WHERE id = $1`, zero.id)).rejects.toThrow(/check_violation|is_project|chk_agent_tasks_at0_unmarked/);
    const other = await db.app.create({ data: { id: generateId(), organizationId: (await db.app.findUniqueOrThrow({ where: { id: app.id } })).organizationId, name: 'Q', urn: `q-${generateId()}.test:q` } });
    await expect(db.agentTask.create({ data: { appId: other.id, title: 'No project', ownerUserId: alice.id, status: 'backlog', taskNumber: 0, handle: 'AT0', isProject: true } }))
      .rejects.toThrow(/chk_agent_tasks_at0_unmarked/);
  });

  it('an insert that does not name is_project (a server without the column, mid-rollout) still marks a top-level task; AT0 and children stay unmarked (Bindi F2)', async () => {
    await create({ title: 'Seed' }); // makes this App's AT0
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      // The column list the previous image's Prisma client sends: no is_project, so the column default applies.
      const top = (await client.query<{ id: string; handle: string; is_project: boolean }>(
        `INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, close_session_when_done, created_at) VALUES ($1, $2, 'Old pod project', 'pending', $3, false, now()) RETURNING id, handle, is_project`,
        [generateId(), app.id, alice.id])).rows[0]!;
      expect(top.handle).toMatch(/^AT[1-9]\d*$/);
      expect(top.is_project).toBe(true);
      const child = (await client.query<{ is_project: boolean }>(
        `INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, parent_task_id, close_session_when_done, created_at) VALUES ($1, $2, 'Child', 'pending', $3, $4, false, now()) RETURNING is_project`,
        [generateId(), app.id, alice.id, top.id])).rows[0]!;
      expect(child.is_project).toBe(false);
    } finally {
      await client.end();
    }
    expect((await db.agentTask.findFirstOrThrow({ where: { appId: app.id, handle: 'AT0' } })).isProject).toBe(false);
  });
});

describe('#4997 the migration', () => {
  const migrationSql = () => readFileSync(new URL('../../../../prisma/migrations/20261124150000_agent_task_is_project/migration.sql', import.meta.url), 'utf8');
  const invariants = () => readFileSync(new URL('../../../../prisma/agent-task-project-marker-invariants.sql', import.meta.url), 'utf8');

  it('carries a byte-identical copy of the invariants file, after the column and the backfill', () => {
    expect(migrationSql().endsWith(invariants())).toBe(true);
    const head = migrationSql().slice(0, migrationSql().length - invariants().length);
    expect(head).toMatch(/ADD COLUMN IF NOT EXISTS is_project BOOLEAN NOT NULL DEFAULT false/);
    expect(head.indexOf('ADD COLUMN')).toBeLessThan(head.indexOf('UPDATE agent_tasks SET is_project = true'));
    expect(head.indexOf('DROP TRIGGER IF EXISTS trg_agent_tasks_project_marker_immutable')).toBeGreaterThan(-1);
    expect(head.indexOf('DROP TRIGGER IF EXISTS trg_agent_tasks_project_marker_immutable')).toBeLessThan(head.indexOf('UPDATE agent_tasks SET is_project = true'));
  });

  it('backfills exactly the rows S1 counts as projects (top-level, not AT0), with the guard already installed (Bindi F3), and a re-run changes nothing', async () => {
    const migration = migrationSql();
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      // A pushed schema: post-push.sql already installed both triggers. The rows are made unmarked with the triggers
      // switched off for the set-up only, then switched back on, so the migration runs against the guard.
      await client.query('ALTER TABLE agent_tasks DISABLE TRIGGER trg_agent_tasks_project_marker_immutable');
      await client.query('ALTER TABLE agent_tasks DISABLE TRIGGER trg_agent_tasks_project_marker_top_level');
      await client.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, task_number, handle, close_session_when_done, created_at) VALUES ('bf-zero', $1, 'No project', 'backlog', $2, 0, 'AT0', false, now())`, [app.id, alice.id]);
      await client.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, close_session_when_done, created_at) VALUES ('bf-top', $1, 'Top', 'pending', $2, false, now())`, [app.id, alice.id]);
      await client.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, parent_task_id, close_session_when_done, created_at) VALUES ('bf-child', $1, 'Child', 'pending', $2, 'bf-top', false, now())`, [app.id, alice.id]);
      await client.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, parent_task_id, close_session_when_done, created_at) VALUES ('bf-loose', $1, 'Loose', 'pending', $2, 'bf-zero', false, now())`, [app.id, alice.id]);
      await client.query(`UPDATE agent_tasks SET is_project = false WHERE app_id = $1`, [app.id]);
      await client.query('ALTER TABLE agent_tasks ENABLE TRIGGER trg_agent_tasks_project_marker_immutable');
      await client.query('ALTER TABLE agent_tasks ENABLE TRIGGER trg_agent_tasks_project_marker_top_level');
      await client.query(migration);
      const rows = (await client.query<{ handle: string; is_project: boolean }>(`SELECT handle, is_project FROM agent_tasks WHERE app_id = $1 ORDER BY handle`, [app.id])).rows;
      const byHandle = Object.fromEntries(rows.map((r) => [r.handle, r.is_project]));
      const top = rows.find((r) => /^AT[1-9]\d*$/.test(r.handle));
      expect(top, 'the top-level task got a project number').toBeDefined();
      expect(byHandle[top!.handle]).toBe(true);
      expect(byHandle.AT0).toBe(false);
      for (const r of rows.filter((x) => x.handle.includes('.'))) expect(r.is_project, r.handle).toBe(false);
      await client.query(migration); // idempotent: nothing left to mark, nothing unmarked
      const guards = (await client.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'agent_tasks'::regclass AND tgname LIKE 'trg_agent_tasks_project_marker_%' ORDER BY tgname`)).rows;
      expect(guards.map((g) => g.tgname), 'the migration leaves both triggers installed').toEqual(['trg_agent_tasks_project_marker_immutable', 'trg_agent_tasks_project_marker_top_level']);
      const again = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_tasks WHERE app_id = $1 AND is_project`, [app.id])).rows[0]!.n;
      expect(again).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});

describe('#4997 the metrics read the marker (cor:agt:150 A project, R4: count once, nearest marked ancestor)', () => {
  const SRC = 'https://example.test/issues/1';
  /** Tree: Outer (marked, top, sourced) > Mid (marked) > Leaf; Outer > Direct; AT0 > Loose (NOT marked) > Stray; AT0 > Orphan. */
  async function tree() {
    const outer = await create({ title: 'Outer', project: true, source: SRC });
    const mid = await create({ title: 'Mid', parentTaskId: outer.id, isProject: true, source: SRC });
    const leaf = await create({ title: 'Leaf', parentTaskId: mid.id, source: SRC });
    const direct = await create({ title: 'Direct', parentTaskId: outer.id, source: SRC });
    const loose = await create({ title: 'Loose' });
    const stray = await create({ title: 'Stray', parentTaskId: loose.id, source: SRC });
    const orphan = await create({ title: 'Orphan', source: SRC });
    await db.agentTask.updateMany({ where: { appId: app.id, handle: { not: 'AT0' } }, data: { status: 'started', startedAt: new Date() } });
    return { outer, mid, leaf, direct, loose, stray, orphan };
  }

  it('report 2 lists every started MARKED task, nested ones too, and never an unmarked top-level task', async () => {
    const t = await tree();
    const r = await loadStartedProjects(db, app.id);
    expect(r.items.map((i) => i.project.taskId)).toEqual([t.outer.id, t.mid.id]);
    expect(r.items.map((i) => i.project.taskId)).not.toContain(t.loose.id);
  });

  it("report 2 counts each task once, under its nearest marked ancestor: Mid under Outer, Leaf under Mid only", async () => {
    const t = await tree();
    const r = await loadStartedProjects(db, app.id);
    const started = (id: string) => [...r.items.find((i) => i.project.taskId === id)!.children.find((c) => c.status === 'STARTED')!.tasks.ids].sort();
    expect(started(t.outer.id)).toEqual([t.mid.id, t.direct.id].sort());
    expect(started(t.mid.id)).toEqual([t.leaf.id]);
  });

  it("report 1 places an owned task under the nearest marked task among itself and its ancestors (a project under its own row, as S1 did, Bindi F1); an unmarked chain is in AT0", async () => {
    const t = await tree();
    const r = await loadStartedOwned(db, app.id);
    const groups = r.byOwner.flatMap((o) => o.byProject);
    const at = (handle: string) => [...(groups.find((g) => g.project.handle === handle)?.tasks.ids ?? [])].sort();
    const h = async (id: string) => (await db.agentTask.findUniqueOrThrow({ where: { id }, select: { handle: true } })).handle!;
    expect(at(await h(t.outer.id)), 'a started, sourced top-level project stays in its own row').toEqual([t.outer.id, t.direct.id].sort());
    expect(at(await h(t.mid.id))).toEqual([t.mid.id, t.leaf.id].sort());
    expect(at('AT0')).toEqual([t.stray.id, t.orphan.id].sort());
    expect(groups.find((g) => g.project.handle === 'AT0')?.project.noProject).toBe(true);
    expect(groups.map((g) => g.project.handle)).not.toContain(await h(t.loose.id));
    const midGroup = groups.find((g) => g.project.taskId === t.mid.id);
    expect(midGroup?.project.title, 'a nested project resolves its own row').toBe('Mid');
  });

  it("the nearest-project lookup stays in the task's own App: another App's marked task with the same handle is never its project", async () => {
    const org = await db.app.findUniqueOrThrow({ where: { id: app.id }, select: { organizationId: true, urn: true } });
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.organizationId, name: 'Q', urn: `${org.urn}-q` }, select: { id: true } });
    await db.appMember.create({ data: { appId: other.id, userId: alice.id, role: 'member' } });
    const inOther = (input: Record<string, unknown>) => M.createAgentTask({}, { input: { appRef: other.id, assignee: { user: alice.id }, ...input } }, as(alice));
    // The same creation order in both Apps, so the handles match: AT1 > AT1.1 > AT1.1.1. The middle one is marked only in Q.
    const theirTop = await inOther({ title: 'Theirs', project: true });
    const theirMid = await inOther({ title: 'Their mid', parentTaskId: theirTop.id, isProject: true });
    const theirLeaf = await inOther({ title: 'Their leaf', parentTaskId: theirMid.id, source: SRC });
    const ourTop = await create({ title: 'Ours', project: true });
    const ourMid = await create({ title: 'Our mid', parentTaskId: ourTop.id });
    const ourLeaf = await create({ title: 'Our leaf', parentTaskId: ourMid.id, source: SRC });
    await db.agentTask.updateMany({ where: { appId: { in: [app.id, other.id] }, handle: { not: 'AT0' } }, data: { status: 'started', startedAt: new Date() } });
    const handle = async (id: string) => (await db.agentTask.findUniqueOrThrow({ where: { id }, select: { handle: true } })).handle!;
    expect(await handle(ourMid.id), 'precondition: the middle tasks share a handle').toBe(await handle(theirMid.id));
    expect(await marked(theirMid.id)).toBe(true);
    expect(await marked(ourMid.id)).toBe(false);

    const groups = (await loadStartedOwned(db, app.id)).byOwner.flatMap((o) => o.byProject);
    expect(groups.map((g) => g.project.taskId)).toEqual([ourTop.id]);
    expect([...groups[0]!.tasks.ids]).toEqual([ourLeaf.id]);
    const ours = await loadStartedProjects(db, app.id);
    expect(ours.items.map((i) => i.project.taskId)).toEqual([ourTop.id]);
    const ourStarted = ours.items[0]!.children.find((c) => c.status === 'STARTED')!.tasks.ids;
    expect([...ourStarted].sort()).toEqual([ourMid.id, ourLeaf.id].sort());
    const theirGroups = (await loadStartedOwned(db, other.id)).byOwner.flatMap((o) => o.byProject);
    expect([...(theirGroups.find((g) => g.project.taskId === theirMid.id)?.tasks.ids ?? [])]).toEqual([theirLeaf.id]);
  });
});
