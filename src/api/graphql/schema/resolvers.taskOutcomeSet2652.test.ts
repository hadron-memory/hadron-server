/**
 * #2652 (cor:agt:050:30, slice a): a team's closed outcome set, read at finish time from `schema:task-outcomes` in
 * the Team Agent's system memory through #2420's schema-node resolver. Outside the set is refused and changes
 * nothing; no set keeps any one word.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let org: any, app: any, owner: any, assignee: any, agent: any, systemMemory: any, task: any;
const ctx = (userId = owner.id) => ({ db, userId, roles: ['READER'] });
const code = (c: string) => ({ extensions: { code: c } });
const putSet = (data: unknown, memoryId = systemMemory.id) =>
  db.node.create({ data: { id: generateId(), memoryId, loc: 'schema:task-outcomes', name: 'Task outcomes', data: data as any } });
const finish = (outcome: string, taskId = task.id) =>
  M.finishAgentTask({}, { taskId, result: { outcome, summary: 'S' } }, ctx(assignee.id));
const stored = (id = task.id) => db.agentTask.findUniqueOrThrow({ where: { id } });
const finishedEvents = (id = task.id) => db.agentTeamEvent.findMany({ where: { taskId: id, type: 'task.finished' } });
async function startedTask(title = 'T') {
  const t = await M.createAgentTask({}, { input: { appRef: app.id, title, source: 's', assignee: { user: assignee.id } } }, ctx());
  await M.startAgentTask({}, { taskId: t.id }, ctx(assignee.id));
  return t;
}
async function expectRefusedUnchanged(outcome: string, c: string) {
  const before = await stored();
  await expect(finish(outcome)).rejects.toMatchObject(code(c));
  expect(await stored()).toEqual(before);
  expect(before.status).toBe('started');
  expect(await finishedEvents()).toHaveLength(0);
}
async function secondTeamAgent() {
  const otherMemory = await db.memory.create({ data: { organizationId: org.id, name: 'Other system', urn: `${org.urn}:other-system`, class: 'system' } });
  await db.node.create({ data: { id: generateId(), memoryId: otherMemory.id, loc: 'roles:other', name: 'Other' } });
  const other = await db.agent.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other`, systemMemoryId: otherMemory.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: other.id } });
  return otherMemory;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Outcomes', urn: `outcomes-${generateId()}.test` } });
  [owner, assignee] = await Promise.all(['owner', 'assignee'].map((handle) => db.user.create({ data: { handle } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Outcomes', urn: `${org.urn}:outcomes` } });
  for (const u of [owner, assignee]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  systemMemory = await db.memory.create({ data: { organizationId: org.id, name: 'Team system', urn: `${org.urn}:team-system`, class: 'system' } });
  await db.node.create({ data: { id: generateId(), memoryId: systemMemory.id, loc: 'roles:lead', name: 'Lead' } });
  agent = await db.agent.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, systemMemoryId: systemMemory.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  task = await startedTask();
});

describe('#2652 — a team with an outcome set', () => {
  beforeEach(async () => { await putSet({ outcomes: ['approved', 'changes-requested'] }); });

  it('a finish inside the set succeeds', async () => {
    const out = await finish('changes-requested');
    expect(out).toMatchObject({ status: 'finished', resultOutcome: 'changes-requested' });
    expect((await finishedEvents()).map((e) => e.payload)).toEqual([expect.objectContaining({ outcome: 'changes-requested' })]);
  });

  it('a finish outside it is refused: the task stays started, no event (S1)', async () => {
    await expectRefusedUnchanged('done', 'TASK_OUTCOME_NOT_IN_SET');
  });

  it('matching is exact: case differs, so it is outside the set', async () => {
    await expectRefusedUnchanged('Approved', 'TASK_OUTCOME_NOT_IN_SET');
  });

  it('the refusal does not echo the set', async () => {
    const err = await finish('done').catch((e: unknown) => e as Error);
    expect(String(err.message)).not.toContain('changes-requested');
  });

  it('a finished task keeps its outcome after the set changes', async () => {
    await finish('approved');
    await db.node.updateMany({ where: { memoryId: systemMemory.id, loc: 'schema:task-outcomes' }, data: { data: { outcomes: ['pass', 'fail'] } } });
    expect(await stored()).toMatchObject({ status: 'finished', resultOutcome: 'approved' });
    const next = await startedTask('Next');
    await expect(finish('approved', next.id)).rejects.toMatchObject(code('TASK_OUTCOME_NOT_IN_SET'));
    expect((await finish('pass', next.id)).resultOutcome).toBe('pass');
  });
});

describe('#2652 — no set, and sets that cannot be used', () => {
  it('no set: any one word, as before', async () => {
    expect((await finish('whatever-word')).resultOutcome).toBe('whatever-word');
  });

  it('no Team Agent at all: any one word', async () => {
    await db.node.deleteMany({ where: { memoryId: systemMemory.id, loc: 'roles:lead' } });
    expect((await finish('anything')).resultOutcome).toBe('anything');
  });

  it('two Team Agents and no set on either: any one word, as before', async () => {
    await secondTeamAgent();
    expect((await finish('anything')).resultOutcome).toBe('anything');
  });

  it('two Team Agents and a set on one of them: unusable, refused', async () => {
    const other = await secondTeamAgent();
    await putSet({ outcomes: ['approved'] }, other.id);
    await expectRefusedUnchanged('approved', 'TASK_OUTCOME_SET_UNUSABLE');
  });

  it('the set is found through the Agent base chain', async () => {
    const baseMemory = await db.memory.create({ data: { organizationId: org.id, name: 'Base system', urn: `${org.urn}:base-system`, class: 'system' } });
    const base = await db.agent.create({ data: { organizationId: org.id, name: 'Base', urn: `${org.urn}:base`, systemMemoryId: baseMemory.id } });
    await db.agent.update({ where: { id: agent.id }, data: { extendsAgentId: base.id } });
    await putSet({ outcomes: ['approved'] }, baseMemory.id);
    await expectRefusedUnchanged('done', 'TASK_OUTCOME_NOT_IN_SET');
    expect((await finish('approved')).resultOutcome).toBe('approved');
  });

  it.each([
    ['no data', null],
    ['a bare list', ['approved']],
    ['no outcomes key', { values: ['approved'] }],
    ['an empty list', { outcomes: [] }],
    ['a non-string entry', { outcomes: ['approved', 7] }],
    ['an entry that is not one word', { outcomes: ['approved', 'two words'] }],
    ['too many entries', { outcomes: Array.from({ length: 101 }, (_, i) => `o${i}`) }],
  ])('a set with %s is unusable: every finish is refused, unchanged', async (_, data) => {
    await putSet(data);
    await expectRefusedUnchanged('approved', 'TASK_OUTCOME_SET_UNUSABLE');
  });

  it('100 entries is the most a set may hold', async () => {
    await putSet({ outcomes: Array.from({ length: 100 }, (_, i) => `o${i}`) });
    expect((await finish('o99')).resultOutcome).toBe('o99');
  });

  it('the assignee and transition checks come first: a non-assignee still gets TASK_NOT_ASSIGNEE', async () => {
    await putSet({ outcomes: ['approved'] });
    await expect(M.finishAgentTask({}, { taskId: task.id, result: { outcome: 'done' } }, ctx(owner.id))).rejects.toMatchObject(code('TASK_NOT_ASSIGNEE'));
  });
});
