/**
 * #2649 (hrn:node:hadronmemory.com:specs:cor:agt:050:01 References → Shape; :09 Editing): a task's ordered, typed
 * references `{kind, target, label?}`. Set at create and through the one edit call, read by whoever reads the task,
 * filterable in `agentTasks(reference:)` inside the App read gate. GraphQL only (#2937).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let org: any, app: any, other: any, owner: any, manager: any, member: any, assignee: any, outsider: any;
const ctx = (userId: string = owner.id): Context => ({ db, userId, roles: ['READER'] });

const ISSUE = 'https://github.com/hadron-memory/hadron-server/issues/2649';
const PR = 'https://github.com/hadron-memory/hadron-server/pull/3104';
const NODE = 'hrn:node:hadronmemory.com:dev:preflight';
const TASK = 'hrn:agenttask:hadronmemory.com:hadron-dev-team:AT0.3910';
const URL_REF = 'http://example.com/a?b=c#d';
const three = [
  { kind: 'PULL_REQUEST', target: PR, label: 'the PR' },
  { kind: 'ISSUE', target: ISSUE },
  { kind: 'NODE', target: NODE, label: '' },
];

const create = (input: Record<string, unknown>, userId: string = owner.id) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'T', ...input } }, ctx(userId));
const edit = (taskId: string, input: Record<string, unknown>, userId: string = owner.id) =>
  M.updateAgentTask({}, { taskId, input }, ctx(userId));
const list = (args: Record<string, unknown>, userId: string = owner.id, appRef: string = app.id) =>
  Q.agentTasks(null, { appRef, ...args }, ctx(userId));
const edited = (taskId: string) => db.agentTeamEvent.findMany({ where: { taskId, type: 'task.edited' } });
const stored = async (taskId: string) => (await db.agentTask.findUniqueOrThrow({ where: { id: taskId } }) as any).references;

let api: ApolloServer<Context>;
async function gql(query: string, variables: Record<string, unknown>, userId: string = owner.id) {
  const r = await api.executeOperation({ query, variables }, { contextValue: ctx(userId) });
  if (r.body.kind !== 'single') throw new Error('unexpected body');
  return r.body.singleResult as { data?: any; errors?: any[] };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Refs', urn: `refs-${generateId()}.test` } });
  [owner, manager, member, assignee, outsider] = await Promise.all(
    ['owner', 'manager', 'member', 'assignee', 'outsider'].map(h => db.user.create({ data: { handle: `refs2649-${h}` } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Refs', urn: `${org.urn}:refs` } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  for (const [u, role] of [[owner, 'member'], [manager, 'owner'], [member, 'member'], [assignee, 'member']] as const) {
    await db.appMember.create({ data: { appId: app.id, userId: u.id, role } });
  }
  await db.appMember.create({ data: { appId: other.id, userId: outsider.id, role: 'member' } });
  api = new ApolloServer<Context>({ typeDefs, resolvers });
});

describe('references round-trip (#2649)', () => {
  it('create stores the ordered list as given and GraphQL reads it back in order, label null when absent or empty', async () => {
    const t = await create({ references: three });
    expect(await stored(t.id)).toEqual([
      { kind: 'pull_request', target: PR, label: 'the PR' },
      { kind: 'issue', target: ISSUE, label: null },
      { kind: 'node', target: NODE, label: null },
    ]);
    await api.start();
    try {
      const r = await gql('query($id:ID!){agentTask(id:$id){references{kind target label}}}', { id: t.id });
      expect(r.errors).toBeUndefined();
      expect(r.data.agentTask.references).toEqual([
        { kind: 'PULL_REQUEST', target: PR, label: 'the PR' },
        { kind: 'ISSUE', target: ISSUE, label: null },
        { kind: 'NODE', target: NODE, label: null },
      ]);
      // A task with none reads an empty list, never null.
      const bare = await create({});
      const b = await gql('query($id:ID!){agentTask(id:$id){references{kind}}}', { id: bare.id });
      expect(b.data.agentTask.references).toEqual([]);
    } finally { await api.stop(); }
  });

  it('every kind takes its well-formed target, including both agent-task URN leaves', async () => {
    const all = [
      { kind: 'ISSUE', target: ISSUE }, { kind: 'PULL_REQUEST', target: PR }, { kind: 'NODE', target: NODE },
      { kind: 'TASK', target: TASK }, { kind: 'TASK', target: 'hrn:agenttask:hadronmemory.com:hadron-dev-team:01a196792d3e76e3ad614c42f85d17ad' },
      { kind: 'URL', target: URL_REF }, { kind: 'URL', target: 'https://example.com' },
    ];
    const t = await create({ references: all });
    expect((await stored(t.id)).map((r: any) => r.target)).toEqual(all.map(r => r.target));
  });

  it('through the SDL: create and edit take references, the enum and label round-trip', async () => {
    await api.start();
    try {
      const c = await gql(`mutation($i:CreateAgentTaskInput!){createAgentTask(input:$i){id references{kind target label}}}`,
        { i: { appRef: app.id, title: 'SDL', references: [{ kind: 'TASK', target: TASK, label: 'parent' }] } });
      expect(c.errors).toBeUndefined();
      expect(c.data.createAgentTask.references).toEqual([{ kind: 'TASK', target: TASK, label: 'parent' }]);
      const u = await gql(`mutation($id:ID!,$i:UpdateAgentTaskInput!){updateAgentTask(taskId:$id,input:$i){references{kind target}}}`,
        { id: c.data.createAgentTask.id, i: { references: [{ kind: 'URL', target: URL_REF }, { kind: 'ISSUE', target: ISSUE }] } });
      expect(u.errors).toBeUndefined();
      expect(u.data.updateAgentTask.references).toEqual([{ kind: 'URL', target: URL_REF }, { kind: 'ISSUE', target: ISSUE }]);
    } finally { await api.stop(); }
  });

  it('any creator sets references at creation, as it sets the title, even one who may not write the properties', async () => {
    // member creates a root task owned by someone else: not a properties writer for it (cor:agt:050:28), still sets references.
    const t = await create({ owner: { user: owner.id }, properties: { k: 1 }, references: [{ kind: 'ISSUE', target: ISSUE }] }, member.id);
    expect(await stored(t.id)).toEqual([{ kind: 'issue', target: ISSUE, label: null }]);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).properties).toBeNull();
  });
});

describe('references edit (#2649, cor:agt:050:09)', () => {
  it('a named list replaces the whole list in order; task.edited names references and never a value', async () => {
    const t = await create({ references: three });
    const out = await edit(t.id, { references: [{ kind: 'NODE', target: NODE, label: 'PRIVATE-LABEL' }, { kind: 'URL', target: URL_REF }] });
    expect(out.id).toBe(t.id);
    expect(await stored(t.id)).toEqual([
      { kind: 'node', target: NODE, label: 'PRIVATE-LABEL' },
      { kind: 'url', target: URL_REF, label: null },
    ]);
    const events = await edited(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ fields: ['references'] });
    const json = JSON.stringify(events);
    expect(json).not.toContain('PRIVATE-LABEL');
    expect(json).not.toContain('example.com');
  });

  it('an edit naming the same list changes nothing and records nothing', async () => {
    const t = await create({ references: three });
    const before = (await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).updatedAt;
    await edit(t.id, { references: three });
    expect(await edited(t.id)).toHaveLength(0);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).updatedAt).toEqual(before);
  });

  it('reordering is a change', async () => {
    const t = await create({ references: three });
    await edit(t.id, { references: [three[1], three[0], three[2]] });
    expect((await stored(t.id)).map((r: any) => r.kind)).toEqual(['issue', 'pull_request', 'node']);
    expect(await edited(t.id)).toHaveLength(1);
  });

  it('null and an empty list both clear; omission leaves the list alone', async () => {
    const a = await create({ references: three });
    await edit(a.id, { title: 'only title' });
    expect(await stored(a.id)).toHaveLength(3);
    await edit(a.id, { references: null });
    expect(await stored(a.id)).toEqual([]);
    const b = await create({ references: three });
    await edit(b.id, { references: [] });
    expect(await stored(b.id)).toEqual([]);
  });

  it('only whoever may edit the task changes them: the assignee is refused, a manager is admitted', async () => {
    const t = await create({ references: three, assignee: { user: assignee.id } });
    await expect(edit(t.id, { references: [] }, assignee.id)).rejects.toMatchObject({ extensions: { code: 'TASK_NOT_OWNER' } });
    expect(await stored(t.id)).toHaveLength(3);
    await edit(t.id, { references: [] }, manager.id);
    expect(await stored(t.id)).toEqual([]);
  });

  it('an ended task refuses a references edit', async () => {
    const t = await create({ references: three });
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    await expect(edit(t.id, { references: [] })).rejects.toMatchObject({ extensions: { code: expect.stringMatching(/^TASK_/) } });
    expect(await stored(t.id)).toHaveLength(3);
  });
});

describe('references refusals write nothing (#2649)', () => {
  const malformed: Array<[string, string]> = [
    ['ISSUE', 'hadron-memory/hadron-server#2649'],
    ['ISSUE', 'http://github.com/hadron-memory/hadron-server/issues/2649'],
    ['ISSUE', '#2649'],
    ['PULL_REQUEST', 'http://github.com/x/y/pull/1'],
    ['PULL_REQUEST', 'https://'],
    ['NODE', 'hrn:mem:hadronmemory.com:dev'],
    ['NODE', 'hrn:node:hadronmemory.com:dev'],
    ['NODE', 'dev:preflight'],
    ['NODE', 'urn:node:hadronmemory.com:dev:preflight'],
    ['TASK', 'AT0.3910'],
    ['TASK', '01a196792d3e76e3ad614c42f85d17ad'],
    ['TASK', 'hrn:agenttask:x'],
    ['TASK', NODE],
    ['URL', 'ftp://example.com/x'],
    ['URL', 'javascript:alert(1)'],
    ['URL', 'example.com'],
    ['URL', ' https://example.com'],
    ['URL', 'https://example.com/a b'],
    ['URL', ''],
  ];
  it.each(malformed)('create refuses %s target %j with BAD_USER_INPUT and makes no task', async (kind, target) => {
    const before = await db.agentTask.count();
    await expect(create({ references: [{ kind: 'ISSUE', target: ISSUE }, { kind, target }] })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.agentTask.count()).toBe(before);
  });

  it.each(malformed)('edit refuses %s target %j with BAD_USER_INPUT and changes nothing', async (kind, target) => {
    const t = await create({ references: three, title: 'Keep' });
    await expect(edit(t.id, { title: 'Changed', references: [{ kind, target }] })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const row = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } }) as any;
    expect(row.title).toBe('Keep');
    expect(row.references).toHaveLength(3);
    expect(await edited(t.id)).toHaveLength(0);
  });

  it('an unknown kind is refused', async () => {
    await expect(create({ references: [{ kind: 'BOGUS', target: URL_REF }] })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  const atCap = Array.from({ length: 20 }, (_, i) => ({ kind: 'URL', target: `https://example.com/${i}` }));
  const longTarget = `https://example.com/${'a'.repeat(512 - 'https://example.com/'.length)}`;
  it('caps: 20 references, a 512-character target and a 120-character label are accepted', async () => {
    expect(longTarget).toHaveLength(512);
    const t = await create({ references: atCap });
    expect(await stored(t.id)).toHaveLength(20);
    const u = await create({ references: [{ kind: 'URL', target: longTarget, label: 'l'.repeat(120) }] });
    expect((await stored(u.id))[0].label).toHaveLength(120);
  });

  const overCap: Array<[string, unknown[]]> = [
    ['21 references', [...atCap, { kind: 'URL', target: 'https://example.com/20' }]],
    ['a 513-character target', [{ kind: 'URL', target: `${longTarget}b` }]],
    ['a 121-character label', [{ kind: 'URL', target: URL_REF, label: 'l'.repeat(121) }]],
  ];
  it.each(overCap)('over a cap (%s) refuses create and edit with nothing written', async (_name, refs) => {
    const before = await db.agentTask.count();
    await expect(create({ references: refs })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.agentTask.count()).toBe(before);
    const t = await create({ references: three });
    await expect(edit(t.id, { references: refs })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await stored(t.id)).toHaveLength(3);
    expect(await edited(t.id)).toHaveLength(0);
  });

  it('the database refuses a list that is not an array or holds over 20 items', async () => {
    const t = await create({});
    await expect(db.agentTask.update({ where: { id: t.id }, data: { references: { kind: 'url' } } as any })).rejects.toThrow(/chk_agent_tasks_references/);
    await expect(db.agentTask.update({ where: { id: t.id }, data: { references: Array.from({ length: 21 }, () => ({})) } as any })).rejects.toThrow(/chk_agent_tasks_references/);
  });
});

describe('source unchanged (#2649)', () => {
  it('source is stored, filtered and held fixed exactly as before; references never touch it', async () => {
    const t = await create({ source: 'opaque-source', references: three });
    expect(t.source).toBe('opaque-source');
    expect((await list({ source: 'opaque-source' })).map((r: any) => r.id)).toEqual([t.id]);
    await expect(edit(t.id, { source: 'other' })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await edit(t.id, { references: [] });
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).source).toBe('opaque-source');
  });

  it('references are never copied into the properties', async () => {
    const t = await create({ references: three });
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).properties).toBeNull();
  });
});

describe('agentTasks(reference:) filter (#2649)', () => {
  it('matches the exact target, with the kind when given; ignores the label; no prefix or substring match', async () => {
    const a = await create({ title: 'a', references: [{ kind: 'ISSUE', target: ISSUE, label: 'x' }, { kind: 'NODE', target: NODE }] });
    const b = await create({ title: 'b', references: [{ kind: 'URL', target: ISSUE, label: 'y' }] });
    const c = await create({ title: 'c', references: [{ kind: 'ISSUE', target: `${ISSUE}0` }] });
    await create({ title: 'd' });
    const ids = async (reference: Record<string, unknown>) => (await list({ reference })).map((r: any) => r.title).sort();
    expect(await ids({ target: ISSUE })).toEqual(['a', 'b']);
    expect(await ids({ kind: 'ISSUE', target: ISSUE })).toEqual(['a']);
    expect(await ids({ kind: 'URL', target: ISSUE })).toEqual(['b']);
    expect(await ids({ target: NODE })).toEqual(['a']);
    expect(await ids({ target: ISSUE.slice(0, -1) })).toEqual([]);
    expect(await ids({ target: `${ISSUE}0` })).toEqual(['c']);
    expect(await ids({ kind: 'PULL_REQUEST', target: ISSUE })).toEqual([]);
    void a; void b; void c;
  });

  it('ANDs with the other filters and pages after filtering', async () => {
    await create({ title: 'red', tags: ['red'], references: [{ kind: 'ISSUE', target: ISSUE }] });
    await create({ title: 'blue', tags: ['blue'], references: [{ kind: 'ISSUE', target: ISSUE }] });
    await create({ title: 'red-none', tags: ['red'] });
    expect((await list({ reference: { target: ISSUE }, tag: 'red' })).map((r: any) => r.title)).toEqual(['red']);
    expect(await list({ reference: { target: ISSUE }, limit: 1 })).toHaveLength(1);
  });

  it('matches only tasks of the App read, never a same-reference task of another App', async () => {
    const mine = await create({ references: [{ kind: 'ISSUE', target: ISSUE }] });
    await db.appMember.create({ data: { appId: other.id, userId: owner.id, role: 'member' } });
    const theirs = await M.createAgentTask({}, { input: { appRef: other.id, title: 'other app', references: [{ kind: 'ISSUE', target: ISSUE }] } }, ctx(outsider.id));
    expect((await list({ reference: { target: ISSUE } })).map((r: any) => r.id)).toEqual([mine.id]);
    expect((await list({ reference: { target: ISSUE } }, outsider.id, other.id)).map((r: any) => r.id)).toEqual([theirs.id]);
  });

  it('a non-participant gets APP_NOT_FOUND for any reference filter, valid or not', async () => {
    await create({ references: [{ kind: 'ISSUE', target: ISSUE }] });
    for (const reference of [{ target: ISSUE }, { kind: 'ISSUE', target: ISSUE }, { target: 'x'.repeat(513) }, { target: '' }]) {
      await expect(list({ reference }, outsider.id)).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
    }
  });

  it('refuses an empty or over-512 filter target with BAD_USER_INPUT after the read gate, never echoing it', async () => {
    for (const target of ['', 'y'.repeat(513)]) {
      const err = await list({ reference: { target } }).catch((e: any) => e);
      expect(err?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(err.message).not.toContain('yyyy');
    }
  });

  it('through the SDL, with the enum kind', async () => {
    const t = await create({ references: [{ kind: 'PULL_REQUEST', target: PR }] });
    await create({ references: [{ kind: 'URL', target: PR }] });
    await api.start();
    try {
      const r = await gql('query($a:ID!,$r:AgentTaskReferenceFilter){agentTasks(appRef:$a,reference:$r){id}}', { a: app.id, r: { kind: 'PULL_REQUEST', target: PR } });
      expect(r.errors).toBeUndefined();
      expect(r.data.agentTasks.map((x: any) => x.id)).toEqual([t.id]);
    } finally { await api.stop(); }
  });
});

describe('a reference leaks nothing beyond its string (#2649)', () => {
  it('a reference to an existing unreadable node or task and to a missing one read identically: only the stored string', async () => {
    // A real task in an App the reader does not participate in, and a real node in a memory it cannot read.
    const hidden = await M.createAgentTask({}, { input: { appRef: other.id, title: 'SECRET-TITLE' } }, ctx(outsider.id));
    const hiddenTaskUrn = `hrn:agenttask:${other.urn}:${hidden.handle}`;
    const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'Hidden', urn: `${org.urn}:hidden` } });
    await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'secret', name: 'SECRET-NODE', content: 'SECRET-CONTENT' } });
    const hiddenNodeUrn = `hrn:node:${org.urn}:hidden:secret`;
    const refs = [
      { kind: 'TASK', target: hiddenTaskUrn }, { kind: 'TASK', target: `hrn:agenttask:${other.urn}:AT0.999999` },
      { kind: 'NODE', target: hiddenNodeUrn }, { kind: 'NODE', target: `hrn:node:${org.urn}:hidden:missing` },
    ];
    const t = await create({ references: refs });
    await api.start();
    try {
      const r = await gql('query($id:ID!){agentTask(id:$id){references{kind target label}}}', { id: t.id }, member.id);
      expect(r.errors).toBeUndefined();
      expect(r.data.agentTask.references).toEqual(refs.map(x => ({ ...x, label: null })));
      expect(JSON.stringify(r)).not.toMatch(/SECRET/);
      // The type carries the stored string and nothing that could resolve it.
      const type = await gql('{__type(name:"AgentTaskReference"){fields{name}}}', {});
      expect(type.data.__type.fields.map((f: any) => f.name).sort()).toEqual(['kind', 'label', 'target']);
    } finally { await api.stop(); }
  });
});
