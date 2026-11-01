import { beforeEach, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { createMcpServerInstance } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

// #2664: `text` is a case-insensitive substring match over title and description, ANDed with every other filter.
let appId: string, userId: string, outsiderId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const outsider = (): Context => ({ db, userId: outsiderId, roles: ['READER'] });
const list = (args = {}, context = ctx()) => (resolvers.Query as any).agentTasks(null, { appRef: appId, ...args }, context);
const titles = (rows: any[]) => rows.map(row => row.title).sort();
async function task(title: string, extra: Record<string, unknown> = {}) {
  return db.agentTask.create({ data: { appId, ownerUserId: userId, title, ...extra } as any });
}
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Text', urn: 'text2664.example' } });
  userId = (await db.user.create({ data: { handle: 'text2664-member' } })).id;
  outsiderId = (await db.user.create({ data: { handle: 'text2664-outsider' } })).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Text', urn: 'text2664.example:app' } })).id;
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
});

it('matches a substring of the title or the description, ignoring case', async () => {
  await task('Fix the Login Page', { tags: ['ui'] });
  await task('Unrelated', { description: 'the LOGIN flow is slow' });
  await task('Nothing here');
  expect(titles(await list({ text: 'login' }))).toEqual(['Fix the Login Page', 'Unrelated']);
  expect(titles(await list({ text: 'LOGIN PAGE' }))).toEqual(['Fix the Login Page']);
  expect(titles(await list({ text: 'ogin pa' }))).toEqual(['Fix the Login Page']);
  expect(await list({ text: 'absent' })).toEqual([]);
});

it('trims the pattern before matching', async () => {
  await task('Fix the Login Page');
  expect(titles(await list({ text: '  login  ' }))).toEqual(['Fix the Login Page']);
});

it('matches % _ and \\ literally', async () => {
  await task('100% done');
  await task('a_b');
  await task('axb');
  await task('back\\slash');
  await task('backXslash');
  expect(titles(await list({ text: '%' }))).toEqual(['100% done']);
  expect(titles(await list({ text: '_' }))).toEqual(['a_b']);
  expect(titles(await list({ text: 'a_b' }))).toEqual(['a_b']);
  expect(titles(await list({ text: '\\' }))).toEqual(['back\\slash']);
});

it('refuses an empty, blank or 201-character pattern with BAD_USER_INPUT, never echoing it', async () => {
  await task('x');
  for (const text of ['', '   ', 'x'.repeat(201), ` ${'y'.repeat(201)} `]) {
    const err = await list({ text }).catch((e: any) => e);
    expect(err?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).not.toContain('yyyy');
    expect(err.message).not.toContain('xxxx');
  }
  expect(titles(await list({ text: 'x'.repeat(200) }))).toEqual([]);
  expect(titles(await list({ text: ` ${'x'.repeat(200)} ` }))).toEqual([]);
});

it('ANDs with status, tag and assignee', async () => {
  await task('login a', { tags: ['red'] });
  await task('login b', { tags: ['blue'] });
  await task('login c', { status: 'started', assigneeUserId: userId, assignedAt: new Date(), startedAt: new Date(), tags: ['red'] });
  await task('other', { tags: ['red'] });
  expect(titles(await list({ text: 'login', tag: 'red' }))).toEqual(['login a', 'login c']);
  expect(titles(await list({ text: 'login', status: ['STARTED'] }))).toEqual(['login c']);
  expect(titles(await list({ text: 'login', assignee: { user: userId } }))).toEqual(['login c']);
  expect(titles(await list({ text: 'login', tag: 'blue', status: ['STARTED'] }))).toEqual([]);
});

it('pages after filtering, newest first', async () => {
  for (let i = 0; i < 25; i++) await task(`needle ${i}`, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) });
  await task('hay');
  expect(await list({ text: 'needle' })).toHaveLength(20);
  expect((await list({ text: 'needle', limit: 2 })).map((r: any) => r.title)).toEqual(['needle 24', 'needle 23']);
  expect(await list({ text: 'needle', offset: 20, limit: 999 })).toHaveLength(5);
});

it('without text the list is today\'s result', async () => {
  await task('a'); await task('b');
  expect(titles(await list())).toEqual(['a', 'b']);
  expect(await list({ text: null })).toEqual(await list());
});

it('a non-participant gets APP_NOT_FOUND with text, valid or not', async () => {
  await task('login');
  for (const text of ['login', '', 'x'.repeat(201)])
    await expect(list({ text }, outsider())).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
});

it('GraphQL serves on the match and the refusal', async () => {
  await task('Fix the Login Page');
  await task('Other', { description: 'login again' });
  await task('Unrelated');
  const api = new ApolloServer<Context>({ typeDefs, resolvers });
  await api.start();
  const gql = async (text: string) => {
    const r = await api.executeOperation({ query: `query($app:ID!,$t:String){agentTasks(appRef:$app,text:$t){id title}}`, variables: { app: appId, t: text } }, { contextValue: ctx() });
    if (r.body.kind !== 'single') throw new Error('unexpected body');
    return r.body.singleResult;
  };
  try {
    const g = await gql('LOGIN');
    expect(g.errors).toBeUndefined();
    expect((g.data as any).agentTasks).toHaveLength(2);
    expect((await gql('')).errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  } finally { await api.stop(); }
});
