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
  const clone = (taskId: string, input: Record<string, unknown> = {}) => M.cloneAgentTask({}, { taskId, input }, as(alice));

  it('a marked source makes a marked clone; an unmarked top-level source makes an unmarked clone', async () => {
    const markedTop = await create({ title: 'Marked', project: true });
    expect(await marked((await clone(markedTop.id)).id)).toBe(true);
    const markedNested = await create({ title: 'Marked nested', parentTaskId: markedTop.id, isProject: true });
    expect(await marked((await clone(markedNested.id)).id)).toBe(true);
    // A top-level task that is not a project (a pre-#4997 shape the platform can no longer make through project: true).
    const unmarkedTop = await db.agentTask.create({ data: { appId: app.id, title: 'Unmarked top', ownerUserId: alice.id, status: 'pending' } });
    expect(unmarkedTop.parentTaskId).toBeNull();
    expect(unmarkedTop.isProject).toBe(false);
    const c = await clone(unmarkedTop.id);
    expect(c.parentTaskId, 'the clone stays top-level').toBeNull();
    expect(await marked(c.id), 'and stays unmarked').toBe(false);
  });

  it('isProject overrides the copied marker; project: true marks; a contradiction is refused', async () => {
    const markedTop = await create({ title: 'Marked', project: true });
    expect(await marked((await clone(markedTop.id, { isProject: false })).id)).toBe(false);
    const plain = await create({ title: 'Plain' });
    expect(await marked((await clone(plain.id, { isProject: true })).id)).toBe(true);
    expect(await marked((await clone(plain.id, { project: true })).id)).toBe(true);
    const e = await refusal(clone(plain.id, { project: true, isProject: false }));
    expect(e.extensions?.code).toBe('BAD_USER_INPUT');
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
});

describe('#4997 the migration', () => {
  const migrationSql = () => readFileSync(new URL('../../../../prisma/migrations/20261124150000_agent_task_is_project/migration.sql', import.meta.url), 'utf8');
  const invariants = () => readFileSync(new URL('../../../../prisma/agent-task-project-marker-invariants.sql', import.meta.url), 'utf8');

  it('carries a byte-identical copy of the invariants file, after the column and the backfill', () => {
    expect(migrationSql().endsWith(invariants())).toBe(true);
    const head = migrationSql().slice(0, migrationSql().length - invariants().length);
    expect(head).toMatch(/ADD COLUMN IF NOT EXISTS is_project BOOLEAN NOT NULL DEFAULT false/);
    expect(head.indexOf('ADD COLUMN')).toBeLessThan(head.indexOf('UPDATE agent_tasks SET is_project = true'));
  });

  it('backfills exactly the rows S1 counts as projects (top-level, not AT0), and a re-run changes nothing', async () => {
    const backfill = migrationSql().slice(0, migrationSql().length - invariants().length);
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      // The pre-migration shape for this column: no guard yet, every row unmarked.
      await client.query('DROP TRIGGER IF EXISTS trg_agent_tasks_project_marker_immutable ON agent_tasks');
      await client.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, task_number, handle, close_session_when_done, created_at) VALUES ('bf-zero', $1, 'No project', 'backlog', $2, 0, 'AT0', false, now())`, [app.id, alice.id]);
      await client.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, close_session_when_done, created_at) VALUES ('bf-top', $1, 'Top', 'pending', $2, false, now())`, [app.id, alice.id]);
      await client.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, parent_task_id, close_session_when_done, created_at) VALUES ('bf-child', $1, 'Child', 'pending', $2, 'bf-top', false, now())`, [app.id, alice.id]);
      await client.query(`INSERT INTO agent_tasks (id, app_id, title, status, owner_user_id, parent_task_id, close_session_when_done, created_at) VALUES ('bf-loose', $1, 'Loose', 'pending', $2, 'bf-zero', false, now())`, [app.id, alice.id]);
      await client.query(`UPDATE agent_tasks SET is_project = false WHERE app_id = $1`, [app.id]);
      await client.query(backfill);
      const rows = (await client.query<{ handle: string; is_project: boolean }>(`SELECT handle, is_project FROM agent_tasks WHERE app_id = $1 ORDER BY handle`, [app.id])).rows;
      const byHandle = Object.fromEntries(rows.map((r) => [r.handle, r.is_project]));
      const top = rows.find((r) => /^AT[1-9]\d*$/.test(r.handle));
      expect(top, 'the top-level task got a project number').toBeDefined();
      expect(byHandle[top!.handle]).toBe(true);
      expect(byHandle.AT0).toBe(false);
      for (const r of rows.filter((x) => x.handle.includes('.'))) expect(r.is_project, r.handle).toBe(false);
      await client.query(backfill); // idempotent: nothing left to mark, nothing unmarked
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
  /** Tree: Outer (marked, top) > Mid (marked) > Leaf; Outer > Direct; Loose (top, NOT marked) > Stray; AT0 > Orphan. */
  async function tree() {
    const outer = await create({ title: 'Outer', project: true });
    const mid = await create({ title: 'Mid', parentTaskId: outer.id, isProject: true, source: SRC });
    const leaf = await create({ title: 'Leaf', parentTaskId: mid.id, source: SRC });
    const direct = await create({ title: 'Direct', parentTaskId: outer.id, source: SRC });
    const loose = await db.agentTask.create({ data: { appId: app.id, title: 'Loose', ownerUserId: alice.id, assigneeUserId: alice.id, assignedAt: new Date(), status: 'started', startedAt: new Date() } });
    const stray = await db.agentTask.create({ data: { appId: app.id, title: 'Stray', ownerUserId: alice.id, assigneeUserId: alice.id, assignedAt: new Date(), parentTaskId: loose.id, status: 'started', startedAt: new Date(), source: SRC } });
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

  it("report 1 places an owned task under its nearest marked ancestor, and a task under an unmarked top-level task in AT0", async () => {
    const t = await tree();
    const r = await loadStartedOwned(db, app.id);
    const groups = r.byOwner.flatMap((o) => o.byProject);
    const at = (handle: string) => [...(groups.find((g) => g.project.handle === handle)?.tasks.ids ?? [])].sort();
    const h = async (id: string) => (await db.agentTask.findUniqueOrThrow({ where: { id }, select: { handle: true } })).handle!;
    expect(at(await h(t.outer.id))).toEqual([t.mid.id, t.direct.id].sort());
    expect(at(await h(t.mid.id))).toEqual([t.leaf.id]);
    expect(at('AT0')).toEqual([t.stray.id, t.orphan.id].sort());
    expect(groups.find((g) => g.project.handle === 'AT0')?.project.noProject).toBe(true);
    expect(groups.map((g) => g.project.handle)).not.toContain(await h(t.loose.id));
    const midGroup = groups.find((g) => g.project.taskId === t.mid.id);
    expect(midGroup?.project.title, 'a nested project resolves its own row').toBe('Mid');
  });
});
