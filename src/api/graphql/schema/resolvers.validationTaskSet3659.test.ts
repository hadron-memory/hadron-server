/**
 * #3659 (hrn:node:hadronmemory.com:specs:cor:dmo:160:01, ruling 0199; gate 6703640950, R1 writers
 * only, R3 broken entries carry no identity): Node.validationTasks tells a writer which tasks a
 * content-validation report for this node may name now. Every state here is driven against the
 * real recorder too: the read lists exactly what the recorder accepts.
 */
import { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { generateId } from '../../../lib/id.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { INSTALL_CONCEALED } from './installMemory.js';
import { getAccessibleMemoryIds } from './resolvers.helpers.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

type Fn = (p: unknown, a: unknown, c: Context) => Promise<any>;
const M = resolvers.Mutation as unknown as Record<string, Fn>;
const Q = resolvers.Query as unknown as Record<string, Fn>;
const N = resolvers.Node as unknown as Record<string, Fn>;

let orgId: string;
let leo: string; // writes the memory, manages nothing
let ann: string; // reads the memory only
let stranger: string; // no access
let memoryId: string;
let hiddenMemoryId: string;
let configId: string;
let v: string; // the validation task, revision 5
let w: string; // another live task
let nodeId: string;
let vUrn: string;
let wUrn: string;

const person = (userId: string, extra: Partial<Context> = {}): Context => ({ db, roles: [], userId, ...extra }) as Context;

/** Set the node's state directly, keeping the revision fingerprint current. */
async function setNode(role: string | null, isRunnable: boolean | null) {
  await db.$executeRaw`UPDATE nodes SET role = ${role}, is_runnable = ${isRunnable} WHERE id = ${nodeId}`;
  await db.$executeRaw`UPDATE nodes SET revision_content_hash = hadron_node_revision_state_hash(nodes) WHERE id = ${nodeId}`;
}
const addRule = (role: string, data: Record<string, unknown>) =>
  db.nodeRoleRule.create({ data: { id: generateId(), configId, role, ...data } });
const setRule = (data: Record<string, unknown>) => db.nodeRoleRule.updateMany({ where: { configId, role: 'guide' }, data });

const read = async (c: Context, id = nodeId) => {
  const node = await Q.node({}, { ref: id }, c);
  return N.validationTasks(node, {}, c);
};
const entry = (taskId: string, taskRef: string, revision: number) => ({ broken: false, taskId, taskRef, revision });
const BROKEN = { broken: true, taskId: null, taskRef: null, revision: null };

let runIds = 0;
const record = (c: Context, validationTaskRef: string, validationTaskRevision: number) =>
  M.recordNodeContentValidationReport({}, {
    nodeRef: nodeId, nodeRevision: 1, validationTaskRef, validationTaskRevision, outcome: 'PASS', runId: `r-${++runIds}`,
  }, c);
const refusal = async (p: Promise<unknown>) => {
  const error = await p.then(() => null, (e: unknown) => e);
  if (error instanceof GraphQLError) return error.extensions?.code;
  return (error as { code?: string } | null)?.code ?? error;
};

/** A task in a memory the writer cannot read. */
async function hiddenTask(data: Record<string, unknown> = {}) {
  return (await db.node.create({ data: { id: generateId(), memoryId: hiddenMemoryId, loc: 'hidden-validate', name: 'H', isRunnable: true, content: 'x', ...data } })).id;
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'vt-org', urn: 'vt-org' } })).id;
  const mk = async (handle: string, role: 'CONTRIBUTOR' | 'READER' | null) => {
    const u = await db.user.create({ data: { handle } });
    if (role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
    return u.id;
  };
  leo = await mk('vt-leo', 'CONTRIBUTOR');
  ann = await mk('vt-ann', 'READER');
  stranger = await mk('vt-stranger', null);
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'vt-org:mem', name: 'mem', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  const hiddenOrg = (await db.organization.create({ data: { id: generateId(), name: 'vt-hidden', urn: 'vt-hidden' } })).id;
  hiddenMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId: hiddenOrg, urn: 'vt-hidden:tasks', name: 'tasks', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  v = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'validate-v', name: 'V', isRunnable: true, content: 'check' } })).id;
  w = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'validate-w', name: 'W', isRunnable: true, content: 'check' } })).id;
  await db.$executeRaw`UPDATE nodes SET rev_seq = 5 WHERE id = ${v}`;
  vUrn = 'hrn:node:vt-org:mem:validate-v';
  wUrn = 'hrn:node:vt-org:mem:validate-w';
  configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
  await addRule('guide', { validationTaskId: v, validationTaskRequired: true });
  nodeId = (await M.createNode({}, { input: { memoryId, loc: 'doc', name: 'Doc', content: 'body', role: 'guide' } }, person(leo))).id;
});

describe('#3659 what a writer reads', () => {
  it('a. a writer who is not a manager reads V at revision 5, and memoryConfig stays not-found', async () => {
    expect(await read(person(leo))).toEqual({ state: 'READY', tasks: [entry(v, vUrn, 5)] });
    expect(await refusal(Q.memoryConfig({}, { memoryRef: memoryId }, person(leo)))).toBe('MEMORY_NOT_FOUND');
  });

  it('the answer carries nothing else from the config', async () => {
    await setRule({ validateBy: 'AGENT' });
    expect(Object.keys((await read(person(leo))).tasks[0]).sort()).toEqual(['broken', 'revision', 'taskId', 'taskRef']);
    expect(Object.keys(await read(person(leo))).sort()).toEqual(['state', 'tasks']);
  });

  it('b. the role rule (through a dotted ancestor) and the runnable key give V then W; two rules naming V give one entry', async () => {
    await addRule('task', { validationTaskId: w, validationTaskRequired: true });
    await setNode('guide.sub', true);
    expect(await read(person(leo))).toEqual({ state: 'READY', tasks: [entry(v, vUrn, 5), entry(w, wUrn, 1)] });
    await db.nodeRoleRule.updateMany({ where: { configId, role: 'task' }, data: { validationTaskId: v } });
    expect(await read(person(leo))).toEqual({ state: 'READY', tasks: [entry(v, vUrn, 5)] });
  });

  it('c. no applicable rule, a disabled rule, and an undeclared sub-role under a strict ancestor: NOT_CONFIGURED', async () => {
    const none = { state: 'NOT_CONFIGURED', tasks: [] };
    await setNode('other', false);
    expect(await read(person(leo))).toEqual(none);
    await setNode('guide', false);
    await setRule({ enabled: false });
    expect(await read(person(leo))).toEqual(none);
    await setRule({ enabled: true, strictSubRoles: true });
    await setNode('guide.undeclared', false);
    expect(await read(person(leo))).toEqual(none);
  });

  it('d. a broken reference marks its entry and the whole set, carries no identity, and leaves the healthy task listed', async () => {
    await addRule('task', { validationTaskId: w, validationTaskRequired: true });
    await setNode('guide', true);
    const broken = { state: 'BROKEN', tasks: [BROKEN, entry(w, wUrn, 1)] };
    await db.node.update({ where: { id: v }, data: { deletedAt: new Date() } });
    expect(await read(person(leo))).toEqual(broken);
    await db.node.update({ where: { id: v }, data: { deletedAt: null, isRunnable: false } });
    expect(await read(person(leo))).toEqual(broken);
    await db.node.update({ where: { id: v }, data: { isRunnable: true } });
    await setRule({ validationTaskId: null });
    expect(await read(person(leo))).toEqual(broken);
  });

  it('d. the task\'s memory deleted: BROKEN', async () => {
    const task = await hiddenTask();
    await db.orgMember.create({ data: { organizationId: (await db.memory.findUniqueOrThrow({ where: { id: hiddenMemoryId } })).organizationId!, userId: leo, role: 'READER' } });
    await setRule({ validationTaskId: task });
    await db.memory.update({ where: { id: hiddenMemoryId }, data: { deletedAt: new Date() } });
    expect(await read(person(leo))).toEqual({ state: 'BROKEN', tasks: [BROKEN] });
  });

  it('d. a rule that names no task and requires none (the FK cleared) is NOT_CONFIGURED', async () => {
    await setRule({ validationTaskId: null, validationTaskRequired: false });
    expect(await read(person(leo))).toEqual({ state: 'NOT_CONFIGURED', tasks: [] });
  });

  it('e. ruling 0199: a writer who cannot read V gets UNAVAILABLE and nothing that identifies V', async () => {
    const task = await hiddenTask();
    await setRule({ validationTaskId: task });
    const got = await read(person(leo));
    expect(got).toEqual({ state: 'UNAVAILABLE', tasks: [] });
    expect(JSON.stringify(got)).not.toContain(task);
    expect(JSON.stringify(got)).not.toContain('hidden-validate');
    expect(await refusal(record(person(leo), task, 1))).toBe('CONTENT_VALIDATION_WRONG_TASK');
  });

  it('e. a hidden live task that is also broken reads UNAVAILABLE, not BROKEN, and a resolved-away one reads BROKEN', async () => {
    const task = await hiddenTask({ isRunnable: false });
    await setRule({ validationTaskId: task });
    expect((await read(person(leo))).state).toBe('UNAVAILABLE');
    await db.node.update({ where: { id: task }, data: { deletedAt: new Date() } });
    expect((await read(person(leo))).state).toBe('BROKEN');
  });
});

describe('#3659 R1: the audience is the write\'s audience', () => {
  it('a reader who does not write the memory gets UNAVAILABLE, the same on a node with rules and one without', async () => {
    const unavailable = { state: 'UNAVAILABLE', tasks: [] };
    expect(await read(person(ann))).toEqual(unavailable);
    await setNode('other', false);
    expect(await read(person(ann))).toEqual(unavailable);
    expect(await refusal(record(person(ann), v, 1))).toBe('FORBIDDEN');
  });

  it('an anonymous reader of a PUBLIC node gets UNAVAILABLE, the same on a node with rules and one without (LOCAL 6704771677)', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { visibility: 'PUBLIC' } });
    const anonymous = { db, roles: [] } as unknown as Context;
    expect(await Q.node({}, { ref: nodeId }, anonymous)).not.toBeNull();
    const unavailable = { state: 'UNAVAILABLE', tasks: [] };
    expect(await read(anonymous)).toEqual(unavailable);
    await setNode('other', false);
    expect(await read(anonymous)).toEqual(unavailable);
    expect(await refusal(record(anonymous, v, 1))).toBe('UNAUTHENTICATED');
  });

  it('impersonation never records, so it reads UNAVAILABLE', async () => {
    expect(await read(person(leo, { impersonation: { orgId } } as Partial<Context>))).toEqual({ state: 'UNAVAILABLE', tasks: [] });
  });

  it('a request whose named session did not bind cannot record, so it reads UNAVAILABLE', async () => {
    expect(await read(person(leo, { sessionBindingRefused: true } as Partial<Context>))).toEqual({ state: 'UNAVAILABLE', tasks: [] });
  });

  it('f. a caller who cannot read the node gets the node read\'s miss, and the field answers null on a parent admitted by a wider path', async () => {
    expect(await Q.node({}, { ref: nodeId }, person(stranger))).toBeNull();
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(await N.validationTasks(node, {}, person(stranger))).toBeNull();
  });

  it('a deleted parent answers null: the recorder has no node to report on', async () => {
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    await db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } });
    expect(await N.validationTasks(node, {}, person(leo))).toBeNull();
  });

  it('a database fault propagates; it is not read as a denial', async () => {
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const broken = { ...db, memory: { ...db.memory, findUniqueOrThrow: async () => { throw new Error('db down'); } } };
    const c = person(leo, { db: broken as never, memoryReadCache: new Map([[memoryId, Promise.resolve(true)]]) } as Partial<Context>);
    await expect(N.validationTasks(node, {}, c)).rejects.toThrow('db down');
  });

  it('g. an install-concealed parent answers null without reading anything', async () => {
    expect(await N.validationTasks({ [INSTALL_CONCEALED]: true, id: nodeId, memoryId }, {}, person(leo))).toBeNull();
  });
});

describe('#3659 an install memory', () => {
  it('a writer of an install memory reads the set the recorder accepts: its write gate is the recorder\'s pre-flight', async () => {
    const admin = (await db.user.create({ data: { handle: 'vt-install-admin' } })).id;
    await db.orgMember.create({ data: { organizationId: orgId, userId: admin, role: 'ADMIN' } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'vt-install', urn: 'vt-org:vt-install', organizationId: orgId } });
    const { app } = await createDbAppWithKey(db, 'vt-install-app', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const c = person(admin, { clientId: `user:${admin}` } as Partial<Context>);
    const created = await M.createNode({}, { input: { install: { appRef: app.id, agentRef: agent.id }, loc: 'prompts:lane', name: 'Lane', content: 'x' } }, c);
    const config = (await db.memoryConfig.create({ data: { id: generateId(), memoryId: created.memoryId } })).id;
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config, role: 'guide', validationTaskId: v, validationTaskRequired: true } });
    nodeId = created.id;
    await setNode('guide', null);
    expect(await read(c)).toEqual({ state: 'READY', tasks: [entry(v, vUrn, 5)] });
    expect((await record(c, v, 5)).replayed).toBe(false);
  });
});

describe('#3659 inherited', () => {
  it('g. an inherited node read through a child answers null, for a caller who could read the base too', async () => {
    const mem = async (slug: string) => (await db.memory.create({ data: { class: 'system', organizationId: orgId, name: slug, urn: `vt-org:${slug}` } })).id;
    const baseMem = await mem('base-system');
    const childMem = await mem('child-system');
    const base = await db.agent.create({ data: { organizationId: orgId, name: 'base', urn: 'vt-org:base', visibility: 'ORGANIZATION', systemMemoryId: baseMem } });
    await db.agent.create({ data: { organizationId: orgId, name: 'child', urn: 'vt-org:child', visibility: 'ORGANIZATION', systemMemoryId: childMem, extendsAgentId: base.id } });
    await db.node.create({ data: { memoryId: baseMem, loc: 'guide-node', name: 'G', content: 'x' } });
    const admin = (await db.user.create({ data: { handle: 'vt-admin', roles: ['ADMIN'] } })).id;
    const c = person(admin, { roles: ['ADMIN'] } as Partial<Context>);
    const got = await Q.node({}, { ref: 'guide-node', memoryRef: childMem }, c);
    expect(await N.inheritedFrom(got, {}, c)).not.toBeNull();
    expect(await N.validationTasks(got, {}, c)).toBeNull();
    // Control: read directly, the same node has a set.
    const direct = await Q.node({}, { ref: 'guide-node', memoryRef: baseMem }, c);
    expect(await N.validationTasks(direct, {}, c)).toEqual({ state: 'NOT_CONFIGURED', tasks: [] });
  });
});

describe('#3659 the recorder\'s predicate, not the fold', () => {
  it('h. a session-bound App key lists a task in named PUBLIC knowledge, and the recorder accepts it', async () => {
    const { app, appKey } = await createDbAppWithKey(db, 'vt-app', orgId);
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'vt-agent', urn: 'vt-org:vt-agent' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    // The one memory a session-bound App key writes: its own bound scratch memory.
    const scratch = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'vt-org:scratch', name: 'scratch', class: 'app', appId: app.id, userMemoryOfAgentId: agent.id, visibility: null } })).id;
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, memoryId: scratch } });
    const publicMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'vt-org:pub', name: 'pub', class: 'knowledge', visibility: 'PUBLIC' } })).id;
    const task = (await db.node.create({ data: { id: generateId(), memoryId: publicMemoryId, loc: 'pub-validate', name: 'P', isRunnable: true, content: 'x' } })).id;
    const config = (await db.memoryConfig.create({ data: { id: generateId(), memoryId: scratch } })).id;
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config, role: 'guide', validationTaskId: task, validationTaskRequired: true } });
    nodeId = (await db.node.create({ data: { id: generateId(), memoryId: scratch, loc: 'doc', name: 'Doc', content: 'body', role: 'guide' } })).id;
    const key = { db, appId: app.id, appKeyId: appKey.id, sessionId: session.id, roles: [] } as unknown as Context;
    expect(await getAccessibleMemoryIds(key)).not.toContain(publicMemoryId); // the fold would call V unreadable
    expect(await read(key)).toEqual({ state: 'READY', tasks: [entry(task, 'hrn:node:vt-org:pub:pub-validate', 1)] });
    expect((await record(key, task, 1)).replayed).toBe(false);
  });
});

describe('#3659 parity: one test drives the read and the recorder', () => {
  const scenarios: Array<[string, () => Promise<unknown>]> = [
    ['one rule', async () => undefined],
    ['role and runnable rules', async () => { await addRule('task', { validationTaskId: w, validationTaskRequired: true }); await setNode('guide.sub', true); }],
    ['no rule', async () => { await setNode('other', false); }],
    ['disabled rule', async () => { await setRule({ enabled: false }); }],
    ['rule cleared', async () => { await setRule({ validationTaskId: null, validationTaskRequired: false }); }],
    ['task deleted', async () => { await db.node.update({ where: { id: v }, data: { deletedAt: new Date() } }); }],
    ['task not runnable', async () => { await db.node.update({ where: { id: v }, data: { isRunnable: false } }); }],
    ['required with no task', async () => { await setRule({ validationTaskId: null }); }],
    ['broken beside a healthy task', async () => {
      await addRule('task', { validationTaskId: w, validationTaskRequired: true }); await setNode('guide', true);
      await db.node.update({ where: { id: v }, data: { isRunnable: false } });
    }],
    ['hidden task (0199, a writer)', async () => { await setRule({ validationTaskId: await hiddenTask() }); }],
    ['hidden and broken', async () => { await setRule({ validationTaskId: await hiddenTask({ isRunnable: false }) }); }],
  ];
  const REFUSAL_OF = {
    NOT_CONFIGURED: 'CONTENT_VALIDATION_NOT_CONFIGURED',
    UNAVAILABLE: 'CONTENT_VALIDATION_WRONG_TASK',
    BROKEN: 'CONTENT_VALIDATION_TASK_BROKEN',
  } as const;

  it.each(scenarios)('%s', async (_label, arrange) => {
    await arrange();
    const set = await read(person(leo));
    if (set.state === 'READY') {
      for (const task of set.tasks) {
        expect((await record(person(leo), task.taskId, task.revision)).replayed).toBe(false);
        expect((await record(person(leo), task.taskRef, 1)).replayed).toBe(false);
        expect(await refusal(record(person(leo), task.taskRef, task.revision + 1))).toBe('CONTENT_VALIDATION_TASK_REVISION_INVALID');
      }
      const listed = set.tasks.map((t: { taskId: string }) => t.taskId);
      for (const unlisted of [v, w].filter((t) => !listed.includes(t))) {
        expect(await refusal(record(person(leo), unlisted, 1))).toBe('CONTENT_VALIDATION_WRONG_TASK');
      }
      return;
    }
    const code = REFUSAL_OF[set.state as keyof typeof REFUSAL_OF];
    for (const ref of [v, w, generateId()]) expect(await refusal(record(person(leo), ref, 1)), ref).toBe(code);
  });
});

describe('#3659 cost', () => {
  it('j. selecting the field on a list costs the same for 4 nodes as for 20, and each memory keeps its own set', async () => {
    const other = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, urn: 'vt-org:mem2', name: 'mem2', class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
    const otherConfig = (await db.memoryConfig.create({ data: { id: generateId(), memoryId: other } })).id;
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: otherConfig, role: 'guide', validationTaskId: w, validationTaskRequired: true } });
    const make = (mem: string, n: number) => Promise.all(Array.from({ length: n }, async (_, i) =>
      (await db.node.create({ data: { id: generateId(), memoryId: mem, loc: `n-${mem.slice(-6)}-${i}`, name: 'n', role: 'guide' } }))));
    const first = await make(memoryId, 10);
    const second = await make(other, 10);

    const counted = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    let queries = 0;
    (counted as any).$on('query', () => { queries += 1; });
    const cost = async (nodes: typeof first) => {
      const c = person(leo, { db: counted as never });
      queries = 0;
      const out = await Promise.all(nodes.map((n) => N.validationTasks(n, {}, c)));
      return { out, queries };
    };
    try {
      const few = await cost([...first.slice(0, 2), ...second.slice(0, 2)]);
      const many = await cost([...first, ...second]);
      expect(many.queries).toBe(few.queries);
      expect(many.out.slice(0, 10).every((s) => s.tasks[0].taskId === v)).toBe(true);
      expect(many.out.slice(10).every((s) => s.tasks[0].taskId === w)).toBe(true);
    } finally {
      await counted.$disconnect();
    }
  });
});
