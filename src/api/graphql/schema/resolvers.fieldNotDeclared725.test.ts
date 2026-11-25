/**
 * #725 slice (hrn:node:hadronmemory.com:specs:cor:api:170:03): `findObjects` raises FIELD_NOT_DECLARED for a field the caller names that a
 * STRICT collection does not declare: a `match` key, a `where` leaf on `properties` and the `sort` key (first path segment). Only when the
 * memory has a schema, `type` is a declared collection and it has `strict: true`; `data` leaves and `exports` are never refused; malformed
 * input keeps BAD_USER_INPUT and wins first; both run before any row is read; a caller who cannot read the memory gets today's answer;
 * the message names only the caller's own field and the collection the caller named.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { nodeQueries } from './resolvers.query.node.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = (): any => resolvers.Mutation as any;
const Q = (): any => resolvers.Query as any;

let adminId: string;
let strangerId: string;
let orgId: string;
let memId: string;
const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const stranger = (): Context => ({ db, roles: ['READER'], userId: strangerId } as Context);
const find = (input: Record<string, unknown>, ctx: Context = admin()) =>
  Q().findObjects(null, { memoryRef: memId, ...input }, ctx);
const outcome = async (p: Promise<any>): Promise<{ ok?: any; error?: any }> => p.then((v) => ({ ok: v }), (e) => ({ error: e }));
const codeOf = (r: { error?: any }) => r.error?.extensions?.code;

const schema = {
  objectTypes: {
    rec: { strict: true, fields: { alpha_f: { type: 'text' }, beta_f: { type: 'number' } } },
    loose: { fields: { alpha_f: { type: 'text' }, beta_f: { type: 'number' } } },
  },
};

const mkNode = (type: string, loc: string, properties: Record<string, unknown>, data?: Record<string, unknown>) =>
  db.node.create({ data: { id: generateId(), memoryId: memId, loc: `${type}:${loc}`, name: loc, objectType: type, properties: properties as never, ...(data ? { data: data as never } : {}) } as never });

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'fnd-org', graphName: 'fnd/graph' });
  orgId = made.org.id;
  memId = made.graph.id;
  const a = await db.user.create({ data: { githubId: 7761, githubUsername: 'fnd-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  strangerId = (await db.user.create({ data: { githubId: 7762, githubUsername: 'fnd-stranger', roles: ['READER'] } })).id;
  await M().updateMemory(null, { ref: memId, schema }, admin());
  await mkNode('rec', 'one', { alpha_f: 'a1', beta_f: 1 });
  await mkNode('rec', 'two', { alpha_f: 'a2', beta_f: 2, nope: 'old-undeclared' }); // an older row that carries a now-undeclared field
  await mkNode('loose', 'one', { alpha_f: 'a1', beta_f: 1, free: 'x' });
});

describe('#725 a strict collection refuses an undeclared field', () => {
  it.each([
    ['a match key', { match: { nope: 'x' } }],
    ['a where leaf on properties', { where: { path: ['nope'], eq: 'x' } }],
    ['the sort key', { sort: { nope: 'asc' } }],
  ])('%s is FIELD_NOT_DECLARED, with the message and the field and collection as extensions', async (_n, args) => {
    const r = await outcome(find({ type: 'rec', ...args }));
    expect(codeOf(r)).toBe('FIELD_NOT_DECLARED');
    expect(r.error.message).toBe('Field "nope" is not declared in strict collection "rec".');
    expect(r.error.extensions).toMatchObject({ code: 'FIELD_NOT_DECLARED', field: 'nope', objectType: 'rec' });
  });

  it('still refuses when an older row carries the undeclared field (the check is on the query, not the rows)', async () => {
    expect(codeOf(await outcome(find({ type: 'rec', match: { nope: 'old-undeclared' } })))).toBe('FIELD_NOT_DECLARED');
  });

  it('checks the first segment of a dotted path', async () => {
    expect(codeOf(await outcome(find({ type: 'rec', where: { path: ['nope', 'deeper'], eq: 'x' } })))).toBe('FIELD_NOT_DECLARED');
    expect(codeOf(await outcome(find({ type: 'rec', where: { path: ['alpha_f', 'deeper'], eq: 'x' } })))).toBeUndefined();
  });

  it('names the first undeclared field: match keys, then where leaves depth-first, then sort', async () => {
    const both = await outcome(find({
      type: 'rec', match: { m1: 'x' }, where: { and: [{ path: ['w1'], eq: 'x' }] }, sort: { s1: 'asc' },
    }));
    expect(both.error.extensions.field).toBe('m1');
    const whereFirst = await outcome(find({
      type: 'rec',
      where: { and: [{ or: [{ path: ['alpha_f'], eq: 'a1' }, { path: ['w1'], eq: 'x' }] }, { path: ['w2'], eq: 'x' }] },
      sort: { s1: 'asc' },
    }));
    expect(whereFirst.error.extensions.field).toBe('w1');
    const sortOnly = await outcome(find({ type: 'rec', where: { path: ['alpha_f'], eq: 'a1' }, sort: { s1: 'asc' } }));
    expect(sortOnly.error.extensions.field).toBe('s1');
  });

  it('the message names only the caller\'s own field and the collection, never a declared field', async () => {
    const r = await outcome(find({ type: 'rec', match: { nope: 'x' } }));
    expect(r.error.message).not.toMatch(/alpha_f|beta_f/);
    expect(JSON.stringify(r.error.extensions)).not.toMatch(/alpha_f|beta_f/);
  });

  it('is refused before any row is read (findNodes is never reached)', async () => {
    const spy = vi.spyOn(nodeQueries, 'findNodes');
    await outcome(find({ type: 'rec', match: { nope: 'x' } }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reaches the wire as FIELD_NOT_DECLARED with its extensions (not an internal fault)', async () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
    const res = await server.executeOperation(
      { query: 'query($m: String!, $match: JSON) { findObjects(memoryRef: $m, type: "rec", match: $match) { total } }', variables: { m: memId, match: { nope: 'x' } } },
      { contextValue: admin() },
    );
    const err = res.body.kind === 'single' ? res.body.singleResult.errors?.[0] : null;
    expect(err?.extensions).toMatchObject({ code: 'FIELD_NOT_DECLARED', field: 'nope', objectType: 'rec' });
    expect(err?.message).toBe('Field "nope" is not declared in strict collection "rec".');
  });
});

describe('#725 what a strict collection still accepts', () => {
  it('a declared field in match, where and sort returns rows', async () => {
    const r = await find({ type: 'rec', match: { alpha_f: 'a1' }, where: { path: ['beta_f'], as: 'number', gte: 1 }, sort: { beta_f: 'desc' } });
    expect(r.objects.map((o: { name?: string; alpha_f?: string }) => o.alpha_f)).toEqual(['a1']);
    expect(r.total).toBe(1);
  });

  it('a where on data is not checked and a where on exports is not refused', async () => {
    await mkNode('rec', 'three', { alpha_f: 'a3' }, { anything: 'in-data' });
    const onData = await find({ type: 'rec', where: { field: 'data', path: ['anything'], eq: 'in-data' } });
    expect(onData.objects).toHaveLength(1);
    const onExports = await outcome(find({ type: 'rec', where: { path: ['exports', 'k'], eq: 'x' } }));
    expect(codeOf(onExports)).toBeUndefined();
  });
});

describe('#725 controls: everything else is unchanged', () => {
  it('a non-strict collection returns rows for any field, with inferred types', async () => {
    const r = await find({ type: 'loose', match: { free: 'x' } });
    expect(r.objects).toHaveLength(1);
    const s = await find({ type: 'loose', sort: { whatever: 'asc' }, where: { path: ['free'], eq: 'x' } });
    expect(s.objects).toHaveLength(1);
  });

  it('a memory with no schema returns rows for any field', async () => {
    await M().updateMemory(null, { ref: memId, schema: null }, admin());
    const r = await outcome(find({ type: 'rec', match: { nope: 'old-undeclared' } }));
    expect(codeOf(r)).toBeUndefined();
    expect(r.ok.objects).toHaveLength(1);
  });

  it('a type the schema does not declare is unchanged', async () => {
    const r = await outcome(find({ type: 'undeclared_type', match: { nope: 'x' } }));
    expect(codeOf(r)).toBeUndefined();
    expect(r.ok.objects).toEqual([]);
  });

  it('a caller who cannot read the strict memory gets the same answer as for a memory with no schema, never FIELD_NOT_DECLARED', async () => {
    const strictAnswer = await outcome(find({ type: 'rec', match: { nope: 'x' } }, stranger()));
    expect(codeOf(strictAnswer)).not.toBe('FIELD_NOT_DECLARED');
    await M().updateMemory(null, { ref: memId, schema: null }, admin());
    const noSchemaAnswer = await outcome(find({ type: 'rec', match: { nope: 'x' } }, stranger()));
    expect(JSON.stringify(strictAnswer, (k, v) => (k === 'stacktrace' ? undefined : v))).toBe(JSON.stringify(noSchemaAnswer, (k, v) => (k === 'stacktrace' ? undefined : v)));
  });
});

describe('#725 malformed input keeps BAD_USER_INPUT and wins first', () => {
  it('a malformed match, sort or where in a strict collection with an undeclared field is BAD_USER_INPUT', async () => {
    expect(codeOf(await outcome(find({ type: 'rec', match: 'not-an-object' as never })))).toBe('BAD_USER_INPUT');
    expect(codeOf(await outcome(find({ type: 'rec', match: { nope: 'x' }, sort: { a: 'asc', b: 'desc' } })))).toBe('BAD_USER_INPUT');
    expect(codeOf(await outcome(find({ type: 'rec', where: { and: [{ path: ['nope'], eq: 'x' }, { path: ['bad path!'], eq: 'y' }] } })))).toBe('BAD_USER_INPUT');
    expect(codeOf(await outcome(find({ type: 'rec', where: { path: ['nope'], eq: 'x', ne: 'y' } })))).toBe('BAD_USER_INPUT');
  });
});
