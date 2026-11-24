/**
 * #4168 (hrn:node:hadronmemory.com:specs:cor:dmo:060:17, S1-S7): Query.nodeAuthoringCheck tells a
 * writer, without writing, whether a proposed node write and its authoredWith claim would pass the
 * authoring attestation check. Every verdict here is also driven against the real write, so the
 * read can neither pass what the write refuses nor refuse what it accepts.
 */
import { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

type Fn = (p: unknown, a: unknown, c: Context) => Promise<any>;
const M = resolvers.Mutation as unknown as Record<string, Fn>;
const Q = resolvers.Query as unknown as Record<string, Fn>;

let orgId: string;
let ann: string; // writes the memory, manages nothing
let ben: string; // reads the memory only
let carol: string; // no access at all
let memoryId: string;
let hiddenMemoryId: string;
let configId: string;
let taskId: string; // the author task, revision 4
let otherTaskId: string;
let nodeId: string;
const TASK_URN = 'hrn:node:ac-org:mem:author-task';

const person = (userId: string, extra: Partial<Context> = {}): Context => ({ db, roles: [], userId, ...extra }) as Context;
const addRule = (role: string, data: Record<string, unknown> = {}) =>
  db.nodeRoleRule.create({ data: { id: generateId(), configId, role, authorTaskId: taskId, authorTaskRequired: true, ...data } });
const check = (c: Context, input: Record<string, unknown>) => Q.nodeAuthoringCheck({}, { input }, c);
const code = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (error: unknown) => error);
  if (e instanceof GraphQLError) return e.extensions?.code;
  return (e as { code?: string } | null)?.code ?? e; // the typed not-found errors carry `code`
};
const refusedWrite = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (error: unknown) => error);
  return e instanceof GraphQLError ? e : null;
};
/** Everything a write would leave behind, for the no-write pins. */
async function footprint() {
  return {
    nodes: await db.node.findMany({ orderBy: { id: 'asc' } }),
    revisions: await db.nodeRevision.count(),
    usage: await db.usageEvent.count(),
  };
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'ac-org', urn: 'ac-org' } })).id;
  const mk = async (handle: string, role: 'CONTRIBUTOR' | 'READER' | null) => {
    const u = await db.user.create({ data: { handle } });
    if (role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
    return u.id;
  };
  ann = await mk('ac-ann', 'CONTRIBUTOR');
  ben = await mk('ac-ben', 'READER');
  carol = await mk('ac-carol', null);
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'ac-org:mem', name: 'mem', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  const hiddenOrg = (await db.organization.create({ data: { id: generateId(), name: 'ac-hidden', urn: 'ac-hidden' } })).id;
  hiddenMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId: hiddenOrg, urn: 'ac-hidden:tasks', name: 'tasks', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  taskId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'author-task', name: 'T', isRunnable: true, content: 'how' } })).id;
  otherTaskId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'other-task', name: 'O', isRunnable: true, content: 'how' } })).id;
  await db.$executeRaw`UPDATE nodes SET rev_seq = 4 WHERE id = ${taskId}`;
  configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
  nodeId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'doc', name: 'Doc', content: 'body', role: null } })).id;
  await addRule('guide');
});

describe('#4168 S1 a pass writes nothing, and the write is then accepted', () => {
  it('passes for the right task at the current revision and leaves no trace', async () => {
    const before = await footprint();
    const verdict = await check(person(ann), { ref: nodeId, role: 'guide', authoredWith: { task: taskId, revision: 4 } });
    expect(verdict).toMatchObject({ state: 'PASS' });
    expect(verdict.code ?? null).toBeNull();
    expect(await footprint()).toEqual(before);
    const written = await M.updateNode({}, { input: { id: nodeId, role: 'guide', content: 'new', authoredWith: { task: taskId, revision: 4 } } }, person(ann));
    expect(written.id).toBe(nodeId);
  });

  it('accepts the task by its URN, as the write does', async () => {
    expect(await check(person(ann), { ref: nodeId, role: 'guide', authoredWith: { task: TASK_URN, revision: 4 } })).toMatchObject({ state: 'PASS' });
  });
});

describe('#4168 S2 the refusals are the write\'s, with the write\'s recovery', () => {
  const cases: Array<[string, Record<string, unknown> | null, string]> = [
    ['no claim', null, 'AUTHORING_ATTESTATION_MISSING'],
    ['a stale revision', { revision: 3 }, 'AUTHORING_ATTESTATION_STALE'],
    ['another task', { useOther: true, revision: 1 }, 'AUTHORING_ATTESTATION_WRONG_TASK'],
  ];
  for (const [label, claimSpec, expected] of cases) {
    it(`${label}: REFUSED ${expected}, naming task and revision exactly as the write does`, async () => {
      const authoredWith = claimSpec === null ? undefined
        : { task: claimSpec.useOther ? otherTaskId : taskId, revision: claimSpec.revision as number };
      const verdict = await check(person(ann), { ref: nodeId, role: 'guide', authoredWith });
      expect(verdict).toMatchObject({ state: 'REFUSED', code: expected, role: 'guide' });
      expect(verdict.recovery).toMatchObject({ taskAccess: 'READABLE', task: TASK_URN, taskId, taskRevision: 4 });
      const refused = await refusedWrite(M.updateNode({}, { input: { id: nodeId, role: 'guide', content: 'new', ...(authoredWith ? { authoredWith } : {}) } }, person(ann)));
      expect(refused?.extensions).toMatchObject({ code: expected, role: 'guide', taskAccess: 'READABLE', task: TASK_URN, taskId, taskRevision: 4 });
      expect(verdict.message).toBe(refused?.message);
    });
  }
});

describe('#4168 S3 a reader who does not write gets one uniform answer', () => {
  it('UNAVAILABLE on a node with a rule and on one without, before any rule is looked at', async () => {
    const plain = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'plain', name: 'P', content: 'x' } })).id;
    const withRule = await check(person(ben), { ref: nodeId, role: 'guide' });
    const without = await check(person(ben), { ref: plain });
    expect(withRule).toEqual({ state: 'UNAVAILABLE', code: null, role: null, message: null, recovery: null });
    expect(without).toEqual(withRule);
  });

  it('is the same for a new node, whatever role it names', async () => {
    const guide = await check(person(ben), { memoryId, loc: 'fresh', role: 'guide' });
    const none = await check(person(ben), { memoryId, loc: 'fresh2', role: 'nothing' });
    expect(guide).toEqual(none);
    expect(guide.state).toBe('UNAVAILABLE');
  });

  it('an impersonated caller is UNAVAILABLE, as the write would refuse them', async () => {
    expect((await check(person(ann, { impersonation: { actorUserId: ben } } as never), { ref: nodeId, role: 'guide' })).state).toBe('UNAVAILABLE');
  });
});

describe('#4168 S4 a task the caller cannot read is never disclosed', () => {
  it('REFUSED AUTHOR_TASK_BROKEN with no id, reference, revision or load route, even for an exact claim', async () => {
    const hidden = (await db.node.create({ data: { id: generateId(), memoryId: hiddenMemoryId, loc: 'hidden-task', name: 'H', isRunnable: true } })).id;
    await db.nodeRoleRule.updateMany({ where: { configId, role: 'guide' }, data: { authorTaskId: hidden } });
    const verdict = await check(person(ann), { ref: nodeId, role: 'guide', authoredWith: { task: hidden, revision: 1 } });
    expect(verdict).toMatchObject({ state: 'REFUSED', code: 'AUTHOR_TASK_BROKEN', recovery: { taskAccess: 'UNAVAILABLE', task: null, taskId: null, taskRevision: null, load: null } });
    const text = JSON.stringify(verdict);
    expect(text).not.toContain(hidden);
    expect(text).not.toContain('hidden-task');
    expect(text).not.toContain('ac-hidden');
    const refused = await refusedWrite(M.updateNode({}, { input: { id: nodeId, role: 'guide', content: 'n', authoredWith: { task: hidden, revision: 1 } } }, person(ann)));
    expect(refused?.extensions?.code).toBe('AUTHOR_TASK_BROKEN');
  });
});

describe('#4168 S5 a broken rule is the write\'s broken-rule refusal, with no identity', () => {
  it('a deleted task, an unrunnable task and a cleared task pointer all read the same', async () => {
    const answers: unknown[] = [];
    await db.node.update({ where: { id: taskId }, data: { deletedAt: new Date() } });
    answers.push(await check(person(ann), { ref: nodeId, role: 'guide', authoredWith: { task: taskId, revision: 4 } }));
    await db.node.update({ where: { id: taskId }, data: { deletedAt: null, isRunnable: false } });
    answers.push(await check(person(ann), { ref: nodeId, role: 'guide', authoredWith: { task: taskId, revision: 4 } }));
    await db.nodeRoleRule.updateMany({ where: { configId, role: 'guide' }, data: { authorTaskId: null } });
    answers.push(await check(person(ann), { ref: nodeId, role: 'guide', authoredWith: { task: taskId, revision: 4 } }));
    expect(answers[0]).toMatchObject({ state: 'REFUSED', code: 'AUTHOR_TASK_BROKEN', recovery: { taskAccess: 'UNAVAILABLE', taskId: null } });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });
});

describe('#4168 S6 no rule is a pass, as at write time', () => {
  it('passes with no claim for a role that has no rule', async () => {
    expect(await check(person(ann), { ref: nodeId, role: 'plain' })).toMatchObject({ state: 'PASS' });
    expect(await check(person(ann), { ref: nodeId })).toMatchObject({ state: 'PASS' });
  });

  it('a disabled rule is no rule', async () => {
    await db.nodeRoleRule.updateMany({ where: { configId, role: 'guide' }, data: { enabled: false } });
    expect(await check(person(ann), { ref: nodeId, role: 'guide' })).toMatchObject({ state: 'PASS' });
  });
});

describe('#4168 S7 a caller who cannot read the node gets the node read\'s not-found', () => {
  it('by ref: NODE_NOT_FOUND, the same as for a missing node', async () => {
    expect(await code(check(person(carol), { ref: nodeId, role: 'guide' }))).toBe('NODE_NOT_FOUND');
    expect(await code(check(person(carol), { ref: generateId(), role: 'guide' }))).toBe('NODE_NOT_FOUND');
  });

  it('by memory and loc: MEMORY_NOT_FOUND, the same as for a missing memory', async () => {
    expect(await code(check(person(carol), { memoryId, loc: 'doc', role: 'guide' }))).toBe('MEMORY_NOT_FOUND');
    expect(await code(check(person(carol), { memoryId: generateId(), loc: 'doc', role: 'guide' }))).toBe('MEMORY_NOT_FOUND');
  });

  it('a soft-deleted node reads as not-found', async () => {
    await db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } });
    expect(await code(check(person(ann), { ref: nodeId, role: 'guide' }))).toBe('NODE_NOT_FOUND');
  });
});

describe('#4168 a proposed write judged on the node before and after', () => {
  it('a new node by memory and loc answers for the role it would take', async () => {
    expect(await check(person(ann), { memoryId, loc: 'brand-new', role: 'guide' })).toMatchObject({ state: 'REFUSED', code: 'AUTHORING_ATTESTATION_MISSING' });
    expect(await check(person(ann), { memoryId, loc: 'brand-new', role: 'guide', authoredWith: { task: taskId, revision: 4 } })).toMatchObject({ state: 'PASS' });
    expect(await db.node.count({ where: { memoryId, loc: 'brand-new' } })).toBe(0);
  });

  it('a memory and loc that name an existing node judge it as that node', async () => {
    await db.node.update({ where: { id: nodeId }, data: { role: 'guide' } });
    expect(await check(person(ann), { memoryId, loc: 'doc' })).toMatchObject({ state: 'REFUSED', code: 'AUTHORING_ATTESTATION_MISSING' });
  });

  it('clearing a governed role cannot shed its requirement', async () => {
    await db.node.update({ where: { id: nodeId }, data: { role: 'guide' } });
    expect(await check(person(ann), { ref: nodeId, role: null })).toMatchObject({ state: 'REFUSED', code: 'AUTHORING_ATTESTATION_MISSING' });
  });

  it('omitting the role keeps the node\'s own', async () => {
    await db.node.update({ where: { id: nodeId }, data: { role: 'guide' } });
    expect(await check(person(ann), { ref: nodeId })).toMatchObject({ state: 'REFUSED', code: 'AUTHORING_ATTESTATION_MISSING' });
  });

  it('a write that changes no authored content needs no claim', async () => {
    await db.node.update({ where: { id: nodeId }, data: { role: 'guide' } });
    expect(await check(person(ann), { ref: nodeId, changesAuthoredContent: false })).toMatchObject({ state: 'PASS' });
  });
});

describe('#4168 nothing else from the memory\'s configuration', () => {
  it('the answer has exactly the verdict fields, and memoryConfig stays not-found to the writer', async () => {
    expect(Object.keys(await check(person(ann), { ref: nodeId, role: 'guide' })).sort()).toEqual(['code', 'message', 'recovery', 'role', 'state']);
    expect(Object.keys((await check(person(ann), { ref: nodeId, role: 'guide' })).recovery).sort()).toEqual(['load', 'task', 'taskAccess', 'taskId', 'taskRevision']);
    expect(await code(Q.memoryConfig({}, { memoryRef: memoryId }, person(ann)))).toBe('MEMORY_NOT_FOUND');
  });

  it('a pass says nothing of the procedure having been followed', async () => {
    const verdict = await check(person(ann), { ref: nodeId, role: 'guide', authoredWith: { task: taskId, revision: 4 } });
    expect(JSON.stringify(verdict)).not.toMatch(/follow|execut|proof/i);
  });
});

describe('#4168 no write', () => {
  it('a refusal and a pass leave the footprint of the memory unchanged', async () => {
    const before = await footprint();
    await check(person(ann), { ref: nodeId, role: 'guide' });
    await check(person(ann), { memoryId, loc: 'x', role: 'guide', authoredWith: { task: taskId, revision: 4 } });
    expect(await footprint()).toEqual(before);
  });
});
