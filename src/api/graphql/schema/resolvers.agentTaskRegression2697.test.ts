/** #2697: delivered task-list behavior, not a new contract. Mutants prove these regression pins are sensitive. */
import { beforeEach, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { taskListDateTime } from '../../../lib/agentTasks/listDateTime.js';
import { createMcpServerInstance } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let userId: string, outsiderId: string, appId: string, otherAppId: string, keyId: string, otherKeyId: string;
const at = (day: number) => new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`);
const userContext = (): Context => ({ db, userId, roles: ['READER'] });
const keyAuth = (own = true): AuthContext => ({ appId: own ? appId : otherAppId, appKeyId: own ? keyId : otherKeyId,
  clientId: `app:${own ? appId : otherAppId}`, roles: [] });
const keyContext = (own = true): Context => ({ db, ...keyAuth(own) });
const list = (args: Record<string, unknown> = {}, c = userContext()) =>
  resolvers.Query.agentTasks({}, { appRef: appId, ...args }, c);
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);
const compound = { tagsAny: ['red'], tagsAll: ['blue'], source: '' };
const invalidCalendar = '2026-02-30T00:00:00Z';
const dateMessage = 'createdAfter must be an ISO date-time with a timezone offset.';
const text = (result: unknown) => {
  const content = (result as { content?: unknown }).content;
  expect(content).toBeInstanceOf(Array);
  return (content as Array<{ text?: string }>).map(item => item.text ?? '').join('\n');
};
const renderedIds = (value: string) => [...value.matchAll(/\(id: ([0-9a-z]+)\)/g)].map(match => match[1]);

async function task(title: string, extra: Record<string, unknown> = {}) {
  return db.agentTask.create({ data: { appId, ownerUserId: userId, title, createdAt: at(1), ...extra } as never });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Regression2697', urn: 'reg2697.example' } });
  userId = (await db.user.create({ data: { handle: 'reg2697-member' } })).id;
  outsiderId = (await db.user.create({ data: { handle: 'reg2697-outsider' } })).id;
  // No OrgMember/owner fallback: removing this AppMember really removes participation.
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Own', urn: 'reg2697.example:own' } })).id;
  otherAppId = (await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: 'reg2697.example:other' } })).id;
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  keyId = (await db.appKey.create({ data: { appId, keyHash: `h-${generateId()}`, keyPreview: 'own' } })).id;
  otherKeyId = (await db.appKey.create({ data: { appId: otherAppId, keyHash: `h-${generateId()}`, keyPreview: 'other' } })).id;
});

async function surfaces(_auth: AuthContext, run: (api: ApolloServer<Context>) => Promise<void>) {
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  await api.start();
  try { await run(api); } finally { await api.stop(); }
}

const query = `query($app:ID!,$source:String,$after:DateTime){
  agentTasks(appRef:$app,tagsAny:["red"],tagsAll:["blue"],source:$source,createdAfter:$after){id title}
}`;

it('distinguishes exact empty source from omitted/null/nonempty and filters before paging past page one', async () => {
  const absent = await task('null source', { tags: ['red', 'blue'] });
  const nonempty = await task('nonempty source', { tags: ['red', 'blue'], source: 'issue:exact' });
  await task('nonempty prefix collision', { tags: ['red', 'blue'], source: 'issue:exact-more' });
  const first = await task('empty older', { tags: ['red', 'blue'], source: '', createdAt: at(2) });
  const second = await task('empty newer', { tags: ['red', 'blue'], source: '', createdAt: at(3) });
  await task('empty but missing tagsAll', { tags: ['red'], source: '', createdAt: at(4) });
  await task('empty but missing tagsAny', { tags: ['blue'], source: '', createdAt: at(4) });
  await db.agentTask.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ appId, ownerUserId: userId,
    title: `newer distractor ${i}`, source: 'not empty', tags: ['red', 'blue'], createdAt: at(5) })) });
  const foreign = await task('foreign exact match', { appId: otherAppId, source: '', tags: ['red', 'blue'], createdAt: at(6) });
  expect(ids(await list(compound))).toEqual([second.id, first.id]);
  expect(ids(await list({ ...compound, limit: 1, offset: 1 }))).toEqual([first.id]);
  const omitted = await list({ tagsAll: ['red', 'blue'], limit: 200 });
  // Omission and null select the same set; createdAt ties do not promise stable order.
  expect(ids(omitted).sort()).toEqual(ids(await list({ tagsAll: ['red', 'blue'], source: null, limit: 200 })).sort());
  expect(ids(omitted)).toEqual(expect.arrayContaining([absent.id, nonempty.id, first.id, second.id]));
  expect(ids(omitted)).not.toContain(foreign.id);
  expect(ids(await list({ tagsAll: ['red', 'blue'], source: 'issue:exact' }))).toEqual([nonempty.id]);
});

it.each(['foreign key', 'revoked key', 'removed member'] as const)('%s conceals matching rows before resolver date validation', async mode => {
  const own = await task('own matching row', { source: '', tags: ['red', 'blue'] });
  const foreign = await task('foreign matching row', { appId: otherAppId, source: '', tags: ['red', 'blue'] });
  expect(ids(await list(compound, keyContext()))).toEqual([own.id]);
  expect(ids(await list({ ...compound, appRef: otherAppId }, keyContext(false)))).toEqual([foreign.id]);
  const auth: AuthContext = mode === 'removed member'
    ? { userId, clientId: `user:${userId}`, roles: ['READER'] } : keyAuth(mode !== 'foreign key');
  const admittedRef = mode === 'foreign key' ? otherAppId : appId;
  const admittedId = mode === 'foreign key' ? foreign.id : own.id;
  // The same authenticated GraphQL identity must first read its admitted App.
  await surfaces(auth, async api => {
    const admitted = await api.executeOperation({ query, variables: { app: admittedRef, source: '', after: at(1).toISOString() } }, { contextValue: { db, ...auth } as Context });
    expect(admitted.body.kind).toBe('single');
    if (admitted.body.kind === 'single') {
      expect(admitted.body.singleResult.errors).toBeUndefined();
      expect((admitted.body.singleResult.data as any).agentTasks.map((row: any) => row.id)).toEqual([admittedId]);
    }
  });
  let c: Context;
  if (mode === 'foreign key') c = keyContext(false);
  else if (mode === 'revoked key') {
    c = keyContext();
    await db.appKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  } else {
    c = userContext();
    await db.appMember.delete({ where: { appId_userId: { appId, userId } } });
  }
  for (const ref of [appId, generateId()]) {
    for (const bounds of [{}, { createdAfter: invalidCalendar }, { createdAfter: 'not-a-date' }]) {
      await expect(list({ ...compound, ...bounds, appRef: ref }, c)).rejects.toMatchObject({
        message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' },
      });
    }
  }
  await surfaces(auth, async (api) => {
    for (const ref of [appId, generateId()]) {
      // Calendar-invalid ISO is accepted by the global DateTime scalar, so this reaches the resolver gate.
      const gql = await api.executeOperation({ query, variables: { app: ref, source: '', after: invalidCalendar } }, { contextValue: c });
      expect(gql.body.kind).toBe('single');
      if (gql.body.kind !== 'single') throw new Error('expected single GraphQL response');
      expect(gql.body.singleResult.data).toBeNull();
      expect(gql.body.singleResult.errors).toMatchObject([{ message: 'App not found.', extensions: { code: 'APP_NOT_FOUND' } }]);

    }
  });
});

it.each(['created', 'started', 'finished'] as const)('pins each single inclusive %s bound and null exclusions', async field => {
  const rows = [];
  for (const d of [2, 3, 4]) rows.push(await task(`day ${d}`, { createdAt: at(d),
    ...(field === 'created' ? {} : { status: field === 'started' ? 'started' : 'finished', assigneeUserId: userId,
      assignedAt: at(d + 1), startedAt: at(d + 5), ...(field === 'finished' ? { finishedAt: at(d + 10), resultOutcome: 'succeeded' } : {}) }),
  }));
  if (field !== 'created') await task('null dated row', { createdAt: at(5) });
  const boundary = at(field === 'created' ? 3 : field === 'started' ? 8 : 13).toISOString();
  expect(ids(await list({ [`${field}After`]: boundary }))).toEqual([rows[2].id, rows[1].id]);
  expect(ids(await list({ [`${field}Before`]: boundary }))).toEqual([rows[1].id, rows[0].id]);
});

it('pins overdue against one PostgreSQL instant even when both JS Date clocks are false', async () => {
  await db.$transaction(async tx => {
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds', CURRENT_TIMESTAMP) AS now`;
    const rows = [];
    for (const [title, status, delta] of [['past', 'pending', -1000], ['equal', 'pending', 0], ['future', 'pending', 1000], ['backlog', 'backlog', -1000]] as const)
      rows.push(await tx.agentTask.create({ data: { appId, ownerUserId: userId, title, status, createdAt: at(1), startBy: new Date(now.getTime() + delta) } }));
    const started = await tx.agentTask.create({ data: { appId, ownerUserId: userId, title: 'started', status: 'started', assigneeUserId: userId,
      assignedAt: at(1), startedAt: at(2), startBy: at(1), createdAt: at(1) } });
    const ended = await tx.agentTask.create({ data: { appId, ownerUserId: userId, title: 'ended', status: 'cancelled', cancelledAt: at(2), startBy: at(1), createdAt: at(1) } });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
    try {
      expect(Date.now()).toBe(0); expect(new Date().getTime()).toBe(0);
      const c = { ...userContext(), db: tx } as unknown as Context;
      expect(ids(await list({ overdue: true }, c))).toEqual([rows[0].id]);
      const notLate = ids(await list({ overdue: false }, c));
      expect(notLate).toEqual(expect.arrayContaining([rows[1].id, rows[2].id, rows[3].id, started.id, ended.id]));
      expect(notLate).not.toContain(rows[0].id);
    } finally { vi.useRealTimers(); }
  });
});

it('uses identical positive filter arguments and identities on resolver and GraphQL', async () => {
  const wanted = await task('own empty source', { source: '', tags: ['red', 'blue'], createdAt: at(3) });
  await task('wrong source', { source: 'not-empty', tags: ['red', 'blue'], createdAt: at(3) });
  const foreign = await task('foreign exact match', { appId: otherAppId, source: '', tags: ['red', 'blue'], createdAt: at(3) });
  const args = { ...compound, createdAfter: at(3).toISOString() };
  expect(ids(await list(args))).toEqual([wanted.id]);
  await surfaces({ userId, roles: ['READER'], clientId: `user:${userId}` }, async (api) => {
    const gql = await api.executeOperation({ query, variables: { app: appId, source: args.source, after: args.createdAfter } }, { contextValue: userContext() });
    expect(gql.body.kind).toBe('single');
    if (gql.body.kind !== 'single') throw new Error('expected single GraphQL response');
    expect(gql.body.singleResult.errors).toBeUndefined();
    expect(gql.body.singleResult.data).toEqual({ agentTasks: [{ id: wanted.id, title: wanted.title }] });

  });
});

it('characterizes compact offsets and typed date refusals without changing the parser', async () => {
  const wanted = await task('instant', { createdAt: at(3) });
  const compact = '2026-01-03T02:00:00+0200';
  expect(taskListDateTime.safeParse(compact).success).toBe(false);
  expect(Number.isFinite(new Date(compact).getTime())).toBe(true); // Conversion alone is insufficient.
  for (const instant of ['2026-01-03T00:00:00Z', '2026-01-03T02:00:00+02:00'])
    expect(ids(await list({ createdAfter: instant, createdBefore: instant }))).toEqual([wanted.id]);
  await surfaces({ userId, roles: ['READER'], clientId: `user:${userId}` }, async (api) => {
    for (const value of [compact, invalidCalendar, '2026-01-03T00:00:00']) {
      await expect(list({ createdAfter: value })).rejects.toMatchObject({ message: dateMessage, extensions: { code: 'BAD_USER_INPUT' } });
      const gql = await api.executeOperation({ query, variables: { app: appId, after: value } }, { contextValue: userContext() });
      expect(gql.body.kind).toBe('single');
      if (gql.body.kind !== 'single') throw new Error('expected single GraphQL response');
      expect(gql.body.singleResult.errors).toMatchObject([{ message: dateMessage, extensions: { code: 'BAD_USER_INPUT' } }]);
    }
    // This one is rejected by scalar coercion before a resolver can conceal an App.
    const scalar = await api.executeOperation({ query, variables: { app: generateId(), after: 'not-a-date' } }, { contextValue: { db, userId: outsiderId, roles: [] } });
    expect(scalar.body.kind).toBe('single');
    if (scalar.body.kind !== 'single') throw new Error('expected single GraphQL response');
    expect(scalar.body.singleResult.errors).toMatchObject([{ extensions: { code: 'BAD_USER_INPUT' } }]);
    expect(scalar.body.singleResult.errors?.[0].message).toContain('DateTime is not a valid ISO 8601 string: not-a-date');
  });
});
