/**
 * #4414 (#4360 S5), cor:agt:050:30 r15: a finished task records the role tasks (runnable instruction nodes) its
 * assignee followed, `workedFromRoleTaskRefs`: optional, at most 10, judged before any write, kept as
 * {nodeId, urn, revision} in the order given, immutable with the result. Mirrors the #2662 findings pins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { readFileSync, readdirSync } from 'node:fs';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { safeNodeUrnV2 } from '../../../lib/urnEmit.js';
import { ROLE_TASK_REFS_MAX } from '../../../lib/agentTasks/roleTaskRefs.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const R = resolvers as any, M = R.Mutation;
let org: any, app: any, owner: any, assignee: any, outsider: any, task: any, mem: any, hidden: any;
const ctx = (userId = assignee.id) => ({ db, userId, roles: ['READER'] });
const finish = (refs?: unknown, c = ctx()) => M.finishAgentTask({}, { taskId: task.id, result: { outcome: 'succeeded', summary: 'S', evidence: 'E', ...(refs === undefined ? {} : { workedFromRoleTaskRefs: refs }) } }, c);
const stored = () => db.agentTask.findUniqueOrThrow({ where: { id: task.id } });
const events = () => db.agentTeamEvent.findMany({ where: { taskId: task.id, type: 'task.finished' } });
const node = (m: any, loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: { id: generateId(), memoryId: m.id, loc, name: loc, isRunnable: true, ...extra } });
const urnOf = (m: any, n: any) => safeNodeUrnV2(m.urn, n.loc);
const refusal = { extensions: { code: 'TASK_ROLE_TASK_REFS_INVALID' } };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Roletasks', urn: `roletasks-${generateId()}.test` } });
  const other = await db.organization.create({ data: { name: 'Other', urn: `other-${generateId()}.test` } });
  [owner, assignee, outsider] = await Promise.all(['owner', 'assignee', 'outsider'].map(handle => db.user.create({ data: { handle } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Roletasks', urn: `${org.urn}:roletasks` } });
  for (const u of [owner, assignee]) {
    await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: 'READER' } });
  }
  mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:roles`, name: 'roles', class: 'knowledge' } });
  hidden = await db.memory.create({ data: { id: generateId(), organizationId: other.id, urn: `${other.urn}:secret`, name: 'secret', class: 'knowledge' } });
  task = await M.createAgentTask({}, { input: { appRef: app.id, title: 'T', source: 's', assignee: { user: assignee.id } } }, ctx(owner.id));
  await M.startAgentTask({}, { taskId: task.id }, ctx());
});

describe('#4414 workedFromRoleTaskRefs on finish', () => {
  it('stores two valid references in the order given as {nodeId, urn, revision}, ids or URNs alike', async () => {
    const a = await node(mem, 'tasks:alpha'); const b = await node(mem, 'tasks:beta', { revSeq: 4 });
    await finish([urnOf(mem, b), a.id]);
    const expected = [{ nodeId: b.id, urn: urnOf(mem, b), revision: 4 }, { nodeId: a.id, urn: urnOf(mem, a), revision: 1 }];
    expect((await stored()).resultWorkedFromRoleTaskRefs).toEqual(expected);
    expect(R.AgentTask.result(await stored()).workedFromRoleTaskRefs).toEqual(expected);
  });
  it('keeps the revision the node had at finish, not its later one', async () => {
    const a = await node(mem, 'tasks:alpha'); await finish([a.id]);
    await db.node.update({ where: { id: a.id }, data: { revSeq: 9 } });
    expect(R.AgentTask.result(await stored()).workedFromRoleTaskRefs).toEqual([{ nodeId: a.id, urn: urnOf(mem, a), revision: 1 }]);
  });
  it('the task event is unchanged: no new field, no reference', async () => {
    const a = await node(mem, 'tasks:alpha'); await finish([a.id]);
    expect((await events()).map(e => e.payload)).toEqual([{ outcome: 'succeeded' }]);
  });
  it('a finish without the field stores NULL and keeps the old result and event byte shapes', async () => {
    await finish();
    expect((await stored()).resultWorkedFromRoleTaskRefs).toBeNull();
    expect(R.AgentTask.result(await stored())).toEqual({ outcome: 'succeeded', summary: 'S', evidence: 'E' });
    expect((await events()).map(e => e.payload)).toEqual([{ outcome: 'succeeded' }]);
  });
  it('null is the same as omitted', async () => {
    await finish(null); expect((await stored()).resultWorkedFromRoleTaskRefs).toBeNull();
  });
  it('an empty list is accepted and stored as an empty list', async () => {
    await finish([]); expect((await stored()).resultWorkedFromRoleTaskRefs).toEqual([]);
    expect(R.AgentTask.result(await stored()).workedFromRoleTaskRefs).toEqual([]);
  });
  it('accepts ten references', async () => {
    const ns = await Promise.all(Array.from({ length: ROLE_TASK_REFS_MAX }, (_, i) => node(mem, `tasks:n${i}`)));
    await finish(ns.map(n => n.id));
    expect(((await stored()).resultWorkedFromRoleTaskRefs as any[]).map(r => r.nodeId)).toEqual(ns.map(n => n.id));
  });

  describe('refusals leave the task STARTED and write nothing', () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['an unreadable node', async () => [(await node(hidden, 'tasks:secret')).id]],
      ['a missing node', async () => [generateId()]],
      ['a missing URN', async () => [`hrn:node:${mem.urn.replace(':', '.')}:tasks:nope`]],
      ['a non-runnable node', async () => [(await node(mem, 'notes:plain', { isRunnable: false })).id]],
      ['a hard-deleted node', async () => { const n = await node(mem, 'tasks:hard'); await db.node.delete({ where: { id: n.id } }); return [n.id]; }],
      ['a URN with invalid syntax', async () => ['hrn:node:::not a urn']],
      ['a node with no runnable flag', async () => [(await node(mem, 'notes:unset', { isRunnable: null })).id]],
      ['a soft-deleted node', async () => [(await node(mem, 'tasks:gone', { deletedAt: new Date() })).id]],
      ['the same node twice', async () => { const n = await node(mem, 'tasks:dup'); return [n.id, n.id]; }],
      ['an id and the URN of the same node', async () => { const n = await node(mem, 'tasks:dup'); return [n.id, urnOf(mem, n)]; }],
      ['eleven references', async () => (await Promise.all(Array.from({ length: ROLE_TASK_REFS_MAX + 1 }, (_, i) => node(mem, `tasks:n${i}`)))).map(n => n.id)],
      ['a valid node beside an invalid one', async () => [(await node(mem, 'tasks:ok')).id, generateId()]],
      ['a non-string entry', async () => [42]],
      ['a blank entry', async () => ['  ']],
      ['a value that is not a list', async () => ({})],
    ];
    it.each(cases)('%s', async (_name, build) => {
      const refs = await build();
      const before = await stored();
      await expect(finish(refs)).rejects.toMatchObject(refusal);
      expect(await stored()).toEqual(before);
      expect((await stored()).status).toBe('started');
      expect(await events()).toHaveLength(0);
    });
    it('the unreadable refusal and the missing refusal are byte-identical (no existence oracle)', async () => {
      const unreadable = await finish([(await node(hidden, 'tasks:secret')).id]).catch((e: any) => e);
      const missing = await finish([generateId()]).catch((e: any) => e);
      expect(unreadable.message).toBe(missing.message);
      expect(unreadable.extensions).toEqual(missing.extensions);
      expect(JSON.stringify(unreadable.extensions)).not.toContain('secret');
    });
  });

  it('the lazy result path returns the list too: a wide row that omits the findings payload reloads the full row (list/tree/relation reads)', async () => {
    const a = await node(mem, 'tasks:alpha'); await finish([a.id]);
    const wide = await db.agentTask.findUniqueOrThrow({ where: { id: task.id }, omit: { resultFindings: true } });
    expect(Object.hasOwn(wide, 'resultFindings')).toBe(false);
    const result = await R.AgentTask.result(wide, {}, ctx());
    expect(result.workedFromRoleTaskRefs).toEqual([{ nodeId: a.id, urn: urnOf(mem, a), revision: 1 }]);
    expect(await R.AgentTask.result(wide, {}, ctx(outsider.id))).toBeNull();
  });
  it('only the assignee sets it (as for the rest of the result)', async () => {
    const a = await node(mem, 'tasks:alpha'); const before = await stored();
    await expect(finish([a.id], ctx(owner.id))).rejects.toMatchObject({ extensions: { code: 'TASK_NOT_ASSIGNEE' } });
    expect(await stored()).toEqual(before);
  });
  it('is read by whoever may read the task, and not by an outsider', async () => {
    const a = await node(mem, 'tasks:alpha'); await finish([a.id]);
    expect(await R.Query.agentTask({}, { id: task.id }, ctx(outsider.id))).toBeNull();
    const seen = await R.Query.agentTask({}, { id: task.id }, ctx(owner.id));
    expect(R.AgentTask.result(seen).workedFromRoleTaskRefs).toHaveLength(1);
  });
  it('a second finish cannot replace the list', async () => {
    const a = await node(mem, 'tasks:alpha'); const b = await node(mem, 'tasks:beta'); await finish([a.id]);
    const before = await stored();
    await expect(finish([b.id])).rejects.toMatchObject({ extensions: { code: 'TASK_ENDED' } });
    expect(await stored()).toEqual(before);
  });
});

it('GraphQL: the input takes [ID!], the result returns the typed list; a bad reference writes nothing', async () => {
  const schema = buildSchema(typeDefs);
  expect(schema.getType('AgentTaskRoleTaskRef')).toBeDefined();
  expect((schema.getType('AgentTaskResultInput') as any).getFields().workedFromRoleTaskRefs.type.toString()).toBe('[ID!]');
  expect((schema.getType('AgentTaskResult') as any).getFields().workedFromRoleTaskRefs.type.toString()).toBe('[AgentTaskRoleTaskRef!]');
  const fieldResolver = (parent: any, args: any, c: any, info: any) => { const fn = R[info.parentType.name]?.[info.fieldName]; return typeof fn === 'function' ? fn(parent, args, c, info) : defaultFieldResolver(parent, args, c, info); };
  const before = await stored();
  const bad = await graphql({ schema, source: 'mutation($id:ID!,$r:[ID!]){finishAgentTask(taskId:$id,result:{outcome:"done",workedFromRoleTaskRefs:$r}){id}}', variableValues: { id: task.id, r: [generateId()] }, contextValue: ctx(), fieldResolver });
  expect(bad.errors?.[0]?.extensions?.code).toBe('TASK_ROLE_TASK_REFS_INVALID'); expect(await stored()).toEqual(before);
  const a = await node(mem, 'tasks:alpha');
  const good = await graphql({ schema, source: 'mutation($id:ID!,$r:[ID!]){finishAgentTask(taskId:$id,result:{outcome:"done",workedFromRoleTaskRefs:$r}){result{outcome workedFromRoleTaskRefs{nodeId urn revision}}}}', variableValues: { id: task.id, r: [a.id] }, contextValue: ctx(), fieldResolver });
  expect(good.errors).toBeUndefined();
  expect(good.data).toEqual({ finishAgentTask: { result: { outcome: 'done', workedFromRoleTaskRefs: [{ nodeId: a.id, urn: urnOf(mem, a), revision: 1 }] } } });
});

describe('the database guard (as agent_task_findings_immutable)', () => {
  it('refuses a value on an open task and any change after finish', async () => {
    const a = await node(mem, 'tasks:alpha');
    const one = [{ nodeId: a.id, urn: urnOf(mem, a), revision: 1 }];
    await expect(db.agentTask.update({ where: { id: task.id }, data: { resultWorkedFromRoleTaskRefs: one } })).rejects.toThrow();
    await finish([a.id]);
    await expect(db.agentTask.update({ where: { id: task.id }, data: { resultWorkedFromRoleTaskRefs: [] } })).rejects.toThrow();
    await expect(db.agentTask.update({ where: { id: task.id }, data: { resultWorkedFromRoleTaskRefs: null as any } })).rejects.toThrow();
    expect((await stored()).resultWorkedFromRoleTaskRefs).toEqual(one);
  });
  it('the CHECK refuses a list of eleven, and a non-list, even written directly (finishing in the same statement, so only the CHECK can say no)', async () => {
    const mk = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ nodeId: `n${i}`, urn: `u${i}`, revision: 1 })));
    const write = (json: string) => db.$executeRaw`UPDATE agent_tasks SET status = 'finished', result_outcome = 'x', finished_at = now(), result_worked_from_role_task_refs = ${json}::jsonb WHERE id = ${task.id}`;
    await expect(write(mk(ROLE_TASK_REFS_MAX + 1))).rejects.toThrow(/chk_agent_task_role_task_refs/);
    await expect(write('{"a":1}')).rejects.toThrow(/chk_agent_task_role_task_refs/);
    await expect(write(mk(ROLE_TASK_REFS_MAX))).resolves.toBe(1);
  });
  it('SQL NULL and JSON null both mean none', async () => {
    await finish();
    await db.$executeRaw`UPDATE agent_tasks SET result_worked_from_role_task_refs = 'null'::jsonb WHERE id = ${task.id}`;
    expect(R.AgentTask.result(await stored())).toEqual({ outcome: 'succeeded', summary: 'S', evidence: 'E' });
  });
  it('the migration carries the exact post-push guard file and post-push.sql includes it', () => {
    const sql = readFileSync('prisma/agent-task-role-task-refs-invariants.sql', 'utf8');
    const dir = readdirSync('prisma/migrations').filter(d => d.endsWith('_agent_task_role_task_refs')).sort().pop()!;
    expect(readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8')).toContain(sql);
    expect(readFileSync('prisma/post-push.sql', 'utf8')).toContain('agent-task-role-task-refs-invariants.sql');
  });
});
