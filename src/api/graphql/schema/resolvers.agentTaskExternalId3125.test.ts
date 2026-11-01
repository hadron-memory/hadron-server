/**
 * #3125 S2 (V29, V45, V46; hrn:node:hadronmemory.com:specs:cor:agt:120:02, Proposed): `AgentTask.externalId`, the
 * claim on an outside item. Optional, set once at create, unique within an App whatever the first task's state,
 * compared exactly as written. The duplicate refusal names no task and can only ever concern the caller's own App.
 * Filterable in `agentTasks(externalId:)` inside the App read gate. GraphQL only (#2937).
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
let org: any, app: any, other: any, owner: any, member: any, outsider: any;
const ctx = (userId: string = owner.id): Context => ({ db, userId, roles: ['READER'] });

const X = 'https://github.com/hadron-memory/hadron-server/issues/1999';

const create = (input: Record<string, unknown>, userId: string = owner.id, appRef: string = app.id) =>
  M.createAgentTask({}, { input: { appRef, title: 'T', ...input } }, ctx(userId));
const list = (args: Record<string, unknown>, userId: string = owner.id, appRef: string = app.id) =>
  Q.agentTasks(null, { appRef, ...args }, ctx(userId));
const externalIdOf = async (taskId: string) => (await db.agentTask.findUniqueOrThrow({ where: { id: taskId } }) as any).externalId;
const refusal = (e: any) => ({ message: e?.message, extensions: e?.extensions });

let api: ApolloServer<Context>;
async function gql(query: string, variables: Record<string, unknown>, userId: string = owner.id) {
  const r = await api.executeOperation({ query, variables }, { contextValue: ctx(userId) });
  if (r.body.kind !== 'single') throw new Error('unexpected body');
  return r.body.singleResult as { data?: any; errors?: any[] };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'ExtId', urn: `extid-${generateId()}.test` } });
  [owner, member, outsider] = await Promise.all(
    ['owner', 'member', 'outsider'].map(h => db.user.create({ data: { handle: `extid3125-${h}` } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'ExtId', urn: `${org.urn}:extid` } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  for (const u of [owner, member]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  await db.appMember.create({ data: { appId: other.id, userId: outsider.id, role: 'member' } });
  api = new ApolloServer<Context>({ typeDefs, resolvers });
});

describe('externalId round-trip (#3125 S2)', () => {
  it('create stores the value exactly as given and GraphQL reads it back; a task without one reads null', async () => {
    const t = await create({ externalId: X });
    expect(await externalIdOf(t.id)).toBe(X);
    await api.start();
    try {
      const r = await gql('query($id:ID!){agentTask(id:$id){externalId}}', { id: t.id });
      expect(r.errors).toBeUndefined();
      expect(r.data.agentTask.externalId).toBe(X);
      const bare = await create({});
      const b = await gql('query($id:ID!){agentTask(id:$id){externalId}}', { id: bare.id });
      expect(b.data.agentTask.externalId).toBeNull();
    } finally { await api.stop(); }
  });

  it('through the SDL: CreateAgentTaskInput takes externalId; UpdateAgentTaskInput does not (V29)', async () => {
    await api.start();
    try {
      const c = await gql('mutation($i:CreateAgentTaskInput!){createAgentTask(input:$i){id externalId}}',
        { i: { appRef: app.id, title: 'SDL', externalId: X } });
      expect(c.errors).toBeUndefined();
      expect(c.data.createAgentTask.externalId).toBe(X);
      const u = await gql('mutation($id:ID!,$i:UpdateAgentTaskInput!){updateAgentTask(taskId:$id,input:$i){id}}',
        { id: c.data.createAgentTask.id, i: { externalId: 'https://example.com/other' } });
      expect(u.errors?.[0]?.message).toMatch(/externalId/);
      expect(await externalIdOf(c.data.createAgentTask.id)).toBe(X);
    } finally { await api.stop(); }
  });

  it('an edit naming externalId past the SDL is refused and changes nothing (set once, never edited)', async () => {
    const t = await create({ externalId: X });
    await expect(M.updateAgentTask({}, { taskId: t.id, input: { title: 'renamed', externalId: 'https://example.com/other' } }, ctx()))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await externalIdOf(t.id)).toBe(X);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).title).toBe('T');
  });

  it('many tasks without an externalId never conflict', async () => {
    for (let i = 0; i < 3; i++) await create({});
    await create({ externalId: null });
    expect(await db.agentTask.count({ where: { appId: app.id, externalId: null, handle: { not: 'AT0' } } as any })).toBe(4);
  });

  it('task.created carries no externalId (the payload is unchanged)', async () => {
    const t = await create({ externalId: X });
    const ev = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'task.created' } });
    expect(JSON.stringify(ev.payload)).not.toContain('github.com');
  });

  it('a child task may carry an externalId, under the same per-App rule', async () => {
    const parent = await create({ assignee: { user: owner.id } });
    const child = await M.createAgentTask({}, { input: { parentTaskId: parent.id, title: 'child', externalId: X } }, ctx());
    expect(await externalIdOf(child.id)).toBe(X);
    await expect(create({ externalId: X })).rejects.toMatchObject({ extensions: { code: 'TASK_EXTERNAL_ID_TAKEN' } });
  });
});

describe('externalId is unique per App, whatever the first task state (#3125 S2)', () => {
  const states: Array<[string, Record<string, unknown>]> = [
    ['pending', {}],
    ['started', { status: 'started', startedAt: new Date(), assigneeUserId: 'OWNER', assignedAt: new Date() }],
    ['finished', { status: 'finished', startedAt: new Date(), finishedAt: new Date(), resultOutcome: 'done', assigneeUserId: 'OWNER', assignedAt: new Date() }],
    ['cancelled', { status: 'cancelled', cancelledAt: new Date() }],
    ['backlog', { status: 'backlog' }],
  ];
  for (const [state, data] of states) {
    it(`a second create with the same externalId is refused TASK_EXTERNAL_ID_TAKEN when the first is ${state}`, async () => {
      const first = await create({ externalId: X });
      if (Object.keys(data).length) {
        const set = { ...data, ...(data.assigneeUserId ? { assigneeUserId: owner.id } : {}) };
        await db.agentTask.update({ where: { id: first.id }, data: set as any });
      }
      const before = await db.agentTask.count({ where: { appId: app.id } });
      const err = await create({ title: 'second', externalId: X }, member.id).catch((e: any) => e);
      expect(err?.extensions?.code).toBe('TASK_EXTERNAL_ID_TAKEN');
      // The refusal names no task: no id, no handle, no title, and not the value either.
      const text = JSON.stringify(refusal(err));
      for (const secret of [first.id, first.handle, X]) expect(text).not.toContain(secret);
      expect(await db.agentTask.count({ where: { appId: app.id } })).toBe(before);
    });
  }

  it('the refused create consumes no handle number', async () => {
    const a = await create({ externalId: X });
    await expect(create({ externalId: X })).rejects.toMatchObject({ extensions: { code: 'TASK_EXTERNAL_ID_TAKEN' } });
    const b = await create({});
    const n = (h: string) => Number(h.split('.').pop());
    expect(n(b.handle)).toBe(n(a.handle) + 1);
  });

  it('the same externalId in another App is accepted, and the refusal in this App is byte-identical either way', async () => {
    await create({ externalId: X });
    const without = refusal(await create({ externalId: X }).catch((e: any) => e));
    const theirs = await create({ externalId: X }, outsider.id, other.id);
    expect(await externalIdOf(theirs.id)).toBe(X);
    const withOther = refusal(await create({ externalId: X }).catch((e: any) => e));
    expect(withOther).toEqual(without);
    expect(without.extensions?.code).toBe('TASK_EXTERNAL_ID_TAKEN');
  });

  it('a non-participant gets the same refusal with or without an externalId, never TASK_EXTERNAL_ID_TAKEN', async () => {
    await create({ externalId: X });
    const plain = refusal(await create({}, outsider.id).catch((e: any) => e));
    const taken = refusal(await create({ externalId: X }, outsider.id).catch((e: any) => e));
    expect(plain.extensions?.code).toBe('APP_NOT_FOUND');
    expect(taken).toEqual(plain);
  });

  it('compared exactly as written: a case variant or a trailing slash is a different id', async () => {
    await create({ externalId: X });
    const upper = await create({ externalId: X.toUpperCase() });
    const slash = await create({ externalId: `${X}/` });
    expect(await externalIdOf(upper.id)).toBe(X.toUpperCase());
    expect(await externalIdOf(slash.id)).toBe(`${X}/`);
  });

  it('two concurrent creates with one externalId: exactly one succeeds, the other is TASK_EXTERNAL_ID_TAKEN', async () => {
    const results = await Promise.allSettled([
      create({ title: 'a', externalId: X }), create({ title: 'b', externalId: X }, member.id),
      create({ title: 'c', externalId: X }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed.map(r => r.reason?.extensions?.code)).toEqual(['TASK_EXTERNAL_ID_TAKEN', 'TASK_EXTERNAL_ID_TAKEN']);
    expect(await db.agentTask.count({ where: { appId: app.id, externalId: X } as any })).toBe(1);
  });

  it('the database itself holds the rule: a raw duplicate in one App fails on the partial unique index', async () => {
    await create({ externalId: X });
    const u = await create({});
    await expect(db.$executeRawUnsafe('UPDATE agent_tasks SET external_id = $1 WHERE id = $2', X, u.id))
      .rejects.toThrow(/23505[\s\S]*\(app_id, external_id\)/);
  });
});

describe('externalId validation (V46)', () => {
  const refused: Array<[string, string]> = [
    ['empty', ''],
    ['over 512 characters', `https://example.com/${'a'.repeat(493)}`],
    ['a space', 'https://example.com/a b'],
    ['a tab', 'https://example.com/a\tb'],
    ['a newline', 'https://example.com/a\n'],
    ['a leading space', ' https://example.com/a'],
    ['a no-break space', 'https://example.com/a\u00a0b'],
    ['a C0 control', 'https://example.com/a\u0001b'],
    ['DEL', 'https://example.com/a\u007fb'],
    ['a C1 control', 'https://example.com/a\u0085b'],
    ['a zero-width space (Cf)', 'https://example.com/a\u200bb'],
    ['a right-to-left override (Cf)', 'https://example.com/\u202eab'],
    ['a user name', 'https://someone@github.com/o/r/issues/1'],
    ['a user name and password', 'https://u:p@github.com/o/r/issues/1'],
    ['an empty userinfo', 'https://@github.com/o/r/issues/1'],
  ];
  for (const [what, value] of refused) {
    it(`refuses ${what} with BAD_USER_INPUT, writing nothing and never echoing the value`, async () => {
      const before = await db.agentTask.count({ where: { appId: app.id } });
      const err = await create({ externalId: value }).catch((e: any) => e);
      expect(err?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(err.message).toMatch(/externalId/);
      if (value.length > 3) expect(err.message).not.toContain(value);
      expect(await db.agentTask.count({ where: { appId: app.id } })).toBe(before);
    });
  }

  it('accepts 512 characters, an opaque non-URL id, and @ outside the authority', async () => {
    const max = `https://example.com/${'a'.repeat(492)}`;
    expect(max).toHaveLength(512);
    for (const value of [max, 'jira:PROJ-123', 'https://example.com/users/@me/x?by=a@b#c@d']) {
      const t = await create({ externalId: value });
      expect(await externalIdOf(t.id)).toBe(value);
    }
  });

  it('a non-participant gets APP_NOT_FOUND for a malformed externalId, never BAD_USER_INPUT (no oracle)', async () => {
    const err = await create({ externalId: 'a b' }, outsider.id).catch((e: any) => e);
    expect(err?.extensions?.code).toBe('APP_NOT_FOUND');
  });

  it('the database refuses an empty or over-512 value written past the server', async () => {
    const t = await create({});
    await expect(db.$executeRawUnsafe('UPDATE agent_tasks SET external_id = $1 WHERE id = $2', '', t.id)).rejects.toThrow(/chk_agent_tasks_external_id/);
    await expect(db.$executeRawUnsafe('UPDATE agent_tasks SET external_id = $1 WHERE id = $2', 'x'.repeat(513), t.id)).rejects.toThrow(/chk_agent_tasks_external_id/);
  });
});

describe('agentTasks(externalId:) filter (#3125 S2)', () => {
  it('returns only the task with exactly this externalId; no prefix, substring or case match', async () => {
    const mine = await create({ externalId: X });
    await create({ externalId: `${X}0` });
    await create({});
    expect((await list({ externalId: X })).map((r: any) => r.id)).toEqual([mine.id]);
    expect(await list({ externalId: X.slice(0, -1) })).toEqual([]);
    expect(await list({ externalId: X.toUpperCase() })).toEqual([]);
  });

  it('matches only tasks of the App read, never the same externalId in another App', async () => {
    const mine = await create({ externalId: X });
    await create({});
    const theirs = await create({ externalId: X }, outsider.id, other.id);
    await create({}, outsider.id, other.id);
    expect((await list({ externalId: X })).map((r: any) => r.id)).toEqual([mine.id]);
    expect((await list({ externalId: X }, outsider.id, other.id)).map((r: any) => r.id)).toEqual([theirs.id]);
  });

  it('a non-participant gets APP_NOT_FOUND for any externalId filter, valid or not', async () => {
    await create({ externalId: X });
    for (const externalId of [X, '', 'x'.repeat(513)]) {
      await expect(list({ externalId }, outsider.id)).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
    }
  });

  it('refuses an empty or over-512 filter value with BAD_USER_INPUT after the read gate, never echoing it', async () => {
    for (const externalId of ['', 'y'.repeat(513)]) {
      const err = await list({ externalId }).catch((e: any) => e);
      expect(err?.extensions?.code).toBe('BAD_USER_INPUT');
      expect(err.message).not.toContain('yyyy');
    }
  });

  it('through the SDL', async () => {
    const mine = await create({ externalId: X });
    await api.start();
    try {
      const r = await gql('query($a:ID!,$x:String){agentTasks(appRef:$a,externalId:$x){id externalId}}', { a: app.id, x: X });
      expect(r.errors).toBeUndefined();
      expect(r.data.agentTasks).toEqual([{ id: mine.id, externalId: X }]);
    } finally { await api.stop(); }
  });
});
