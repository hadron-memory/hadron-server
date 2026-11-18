/**
 * #3427 — `appNodes` / `appNodesPage` accepted `NodeFilter.where` and silently ignored it (rows and `total`
 * unfiltered). The ruled fix is a refusal, shaped like the #2832 `childrenOf` refusal: `BAD_USER_INPUT` in
 * `appNodesRead` BEFORE the App lookup, on both list forms.
 *
 * Pins: (a) a no-match and a matching `where` are refused on both forms and list nothing; (b) an empty `where: {}`
 * is refused; (c) `locPrefix` still narrows and the where-less total is unchanged; (d) the refusal is the same
 * for an unknown App, a denied App and a member, and never echoes the predicate; (e) an explicit null is omitted.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { buildSchema, type GraphQLInputObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';

const Q = resolvers.Query as any;
const asUser = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const FIELDS = ['appNodes', 'appNodesPage'] as const;
const call = (field: (typeof FIELDS)[number], ctx: Context, appRef: string, filter: unknown) =>
  Q[field](null, { appRef, filter }, ctx);
const rowsOf = (r: any): { loc: string }[] => (Array.isArray(r) ? r : r.items);

let appId: string;
let member: string;
let outsider: string;

beforeEach(async () => {
  await cleanDb(db);
  const sfx = generateId().slice(-8);
  const org = await db.organization.create({ data: { name: 'w3427', urn: `w3427-${sfx}.example` }, select: { id: true, urn: true } });
  member = (await db.user.create({ data: { handle: `w3427m-${sfx}`, roles: ['READER'] } })).id;
  outsider = (await db.user.create({ data: { handle: `w3427o-${sfx}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: member, role: 'READER' } });
  const mem = await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'M', urn: `${org.urn}:m` } });
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  appId = app.id;
  const agent = await db.agent.create({ data: { name: 'Ag', urn: `${org.urn}:ag`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: mem.id, role: 'read-write' } });
  await db.appMember.create({ data: { appId, userId: member, role: 'member' } });
  for (const [loc, kind] of [['rec.a', 'alpha'], ['rec.b', 'beta']] as const) {
    await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc, name: loc, content: loc, properties: { kind } } });
  }
});

describe('#3427 App node lists refuse NodeFilter.where', () => {
  it.each(FIELDS)('%s: a no-match, a matching and an empty where are all refused', async (field) => {
    for (const where of [{ path: ['kind'], eq: 'does-not-exist' }, { path: ['kind'], eq: 'alpha' }, {}]) {
      await expect(call(field, asUser(member), appId, { where })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
  });

  it.each(FIELDS)('%s: the refusal names findNodes and does not echo the predicate', async (field) => {
    const err = await call(field, asUser(member), appId, { where: { path: ['secretpath'], eq: 'secretvalue' } }).catch((e: Error) => e);
    expect((err as Error).message).toContain('findNodes');
    expect((err as Error).message).not.toMatch(/secretpath|secretvalue/);
  });

  it.each(FIELDS)('%s: identical refusal for a member, an outsider, an unknown and a malformed App', async (field) => {
    const where = { path: ['kind'], eq: 'alpha' };
    const seen: string[] = [];
    for (const [ctx, ref] of [[asUser(member), appId], [asUser(outsider), appId], [asUser(member), generateId()], [asUser(member), 'not a ref']] as const) {
      const e: any = await call(field, ctx, ref, { where }).catch((x: unknown) => x);
      expect(e.extensions?.code).toBe('BAD_USER_INPUT');
      seen.push(e.message);
    }
    expect(new Set(seen).size).toBe(1);
  });

  it.each(FIELDS)('%s: controls — locPrefix still narrows, where-less and null-where are unchanged', async (field) => {
    expect(rowsOf(await call(field, asUser(member), appId, { locPrefix: 'rec.a' })).map((r) => r.loc)).toEqual(['rec.a']);
    const all = await call(field, asUser(member), appId, undefined);
    expect(rowsOf(all).map((r) => r.loc).sort()).toEqual(['rec.a', 'rec.b']);
    if (!Array.isArray(all)) expect(all.total).toBe(2);
    const nul = await call(field, asUser(member), appId, { where: null });
    expect(rowsOf(nul).length).toBe(2);
    if (!Array.isArray(nul)) expect(nul.total).toBe(2);
  });
});

describe('#3427 SDL text follows the refusal', () => {
  const schema = buildSchema(typeDefs as unknown as string);
  it('NodeFilter.where names the refusal', () => {
    const where = (schema.getType('NodeFilter') as GraphQLInputObjectType).getFields().where;
    expect(where.description).toContain('Not supported by appNodes (refused with BAD_USER_INPUT); use findNodes');
  });
  it.each(['appNodes', 'appNodesPage'])('%s lists where and childrenOf as refused filters', (field) => {
    const d = schema.getQueryType()!.getFields()[field].description ?? '';
    expect(d).toMatch(/where/);
    expect(d).toMatch(/childrenOf/);
    expect(d).toMatch(/memoryIds/);
  });
});
