/**
 * #1329 — the refusal cases the HTTP adapters do not reach: the run surface, a
 * task with no resolvable URN, a write answering to two tasks, a system write
 * with no reader, and a content-validation outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { attestedAuthoring, AuthoringAttestationError, judgeAuthoring } from '../../../lib/authoringAttestation.js';
import { hadronUpdateNode } from '../../../lib/runner/tools/nodeTools.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<Record<string, unknown>>>;

let userId: string;
let memoryId: string;
let taskId: string;
let foreignTaskId: string;
let configId: string;
let organizationId: string;
const ctx = (): Context => ({ db, roles: [], userId }) as Context;
const rule = (role: string, authorTaskId: string) =>
  db.nodeRoleRule.create({ data: { id: generateId(), configId, role, authorTaskId, authorTaskRequired: true } });
const refusal = async (promise: Promise<unknown>) => {
  const e = await promise.then(() => null, (error: unknown) => error);
  expect(e).toBeInstanceOf(AuthoringAttestationError);
  return e as AuthoringAttestationError;
};
const judge = (reader: Context | null, write: Partial<Parameters<typeof judgeAuthoring>[2]>) =>
  db.$transaction((tx) => judgeAuthoring(tx, memoryId, {
    priorRole: null, priorRunnable: null, role: 'guide', runnable: false, authoredChange: true, ...write,
  }, attestedAuthoring(reader)));

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'refuse-org', urn: 'refuse-org' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'refuse-other', urn: 'refuse-other' } });
  organizationId = org.id;
  userId = (await db.user.create({ data: { githubId: 13291, githubUsername: 'refuse-user', handle: 'refuse-user' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'refuse-org:mem', name: 'mem', class: 'knowledge' } })).id;
  taskId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'task', name: 'Task', isRunnable: true, revSeq: 2 } })).id;
  const foreign = await db.memory.create({ data: { id: generateId(), organizationId: other.id, urn: 'refuse-other:mem', name: 'hidden', class: 'knowledge' } });
  foreignTaskId = (await db.node.create({ data: { id: generateId(), memoryId: foreign.id, loc: 'task', name: 'Hidden', isRunnable: true } })).id;
  configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
});

describe('#1329 the run surface', () => {
  it('names the read a run tool has, and no CLI command', async () => {
    await rule('guide', taskId);
    await M.createNode({}, { input: { memoryId, loc: 'a', name: 'a', content: 'x', role: 'guide', authoredWith: { task: taskId, revision: 2 } } }, ctx());
    const e = await refusal(hadronUpdateNode.execute({ principal: ctx(), db, run: { id: 'run', organizationId } } as never, {
      urn: 'hrn:node:refuse-org:mem:a', content: 'y',
    }));
    expect(e.message).toContain('hadron_read_node');
    expect(e.message).not.toContain('hadron node get');
    expect(e.extensions).toMatchObject({ code: 'AUTHORING_ATTESTATION_MISSING', task: 'hrn:node:refuse-org:mem:task', taskRevision: 2 });
  });
});

describe('#1329 a task whose URN would not resolve back (#697)', () => {
  it('gives the id, and names no URN route', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { urn: 'refuse-org:app:mem' } });
    await rule('guide', taskId);
    const e = await refusal(M.createNode({}, { input: { memoryId, loc: 'a', name: 'a', content: 'x', role: 'guide' } }, ctx()));
    expect(e.extensions).toMatchObject({
      task: null, taskId, taskRevision: 2, load: { graphql: `node(ref: "${taskId}")`, mcp: null, cli: null },
    });
    expect(e.message).toContain(taskId);
    expect(e.proseFor('mcp')).toContain(taskId);
    expect(e.proseFor('mcp')).not.toContain('Load it with hadron_get_node');
  });
});

describe('#1329 a write that answers to two tasks', () => {
  it('reports the role whose task is unreadable, whichever the other is', async () => {
    await rule('guide', taskId);
    await rule('other', foreignTaskId);
    expect(await judge(ctx(), { priorRole: 'other', priorRunnable: false, role: 'guide' }))
      .toMatchObject({ refused: 'AUTHOR_TASK_BROKEN', role: 'other', recovery: { taskAccess: 'UNAVAILABLE', task: null } });
  });
});

describe('#1329 two hidden tasks', () => {
  it("names the same role whatever state either hidden task is in", async () => {
    const second = await db.node.create({ data: {
      id: generateId(), memoryId: (await db.node.findUniqueOrThrow({ where: { id: foreignTaskId } })).memoryId,
      loc: 'second', name: 'Second', isRunnable: true,
    } });
    await rule('guide', foreignTaskId);
    await rule('other', second.id);
    const write = { priorRole: 'other', priorRunnable: false, role: 'guide' };
    const both = await judge(ctx(), write);
    expect(both).toMatchObject({ refused: 'AUTHOR_TASK_BROKEN', role: 'guide' });
    await db.node.update({ where: { id: second.id }, data: { deletedAt: new Date() } });
    expect(await judge(ctx(), write)).toEqual(both);
    await db.node.update({ where: { id: second.id }, data: { deletedAt: null, isRunnable: false } });
    expect(await judge(ctx(), write)).toEqual(both);
  });
});

describe('#1329 a writer with no reader', () => {
  it('keeps the code, because git sync reports it, and discloses nothing', async () => {
    await rule('guide', foreignTaskId);
    expect(await judge(null, {})).toEqual({ refused: 'AUTHORING_ATTESTATION_MISSING', role: 'guide', recovery: null });
  });
});

describe('#1329 content validation', () => {
  it('a rule with a validator is not an authoring refusal: a matching claim writes', async () => {
    await db.nodeRoleRule.create({ data: {
      id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true,
      validationTaskId: taskId, validationTaskRequired: true, validateBy: 'AGENT',
    } });
    const node = await M.createNode({}, { input: { memoryId, loc: 'a', name: 'a', content: 'x', role: 'guide', authoredWith: { task: taskId, revision: 2 } } }, ctx());
    expect(node.id).toBeTruthy();
  });
});
