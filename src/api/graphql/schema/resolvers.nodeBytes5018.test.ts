/**
 * #5018 (Billing A14, hrn:node:hadronmemory.com:specs:cor:dmo:060:18): the `nodeBytes` owner-limit row (report-only) and the two Node
 * fields, `storedBytes` (any reader of the node) and `revisionBytes` (only a reader who may see every memory a counted revision was
 * taken in). The columns are written with raw SQL where a fixture needs a figure the triggers would otherwise decide.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createNodeRevision } from '../../../lib/nodeRevisionSnapshot.js';
import { reloadOwnerDefaultLimitsForTests } from '../../../lib/ownerLimits/defaults.js';
import { parseOwnerDefaultLimits, OWNER_DEFAULT_LIMITS_ERROR } from '../../../lib/ownerLimits/defaults.js';
import { OWNER_LIMIT_KEYS } from '../../../lib/ownerLimits/keys.js';
import { formatGraphQLError } from '../formatError.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
interface Result { data?: Record<string, any> | null; errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }> }
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>): Promise<Result> {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult as Result;
}
const codeOf = (r: Result) => r.errors?.[0]?.extensions?.code ?? null;
const ctxOf = (userId: string, roles: string[] = ['READER']): Partial<Context> => ({ userId, roles: roles as never });

let seq = 0;
let admin: string, orgAdmin: string, reader: string, ownerU: string, strangerU: string;
let orgId: string;
const mkUser = async (name: string, roles: string[] = ['READER']) =>
  (await db.user.create({ data: { id: generateId(), handle: name, email: `${name}@example.test`, roles: roles as never } })).id;
const orgMemory = (data: Record<string, unknown> = {}) =>
  db.memory.create({ data: { id: generateId(), name: 'm', urn: `nb18-org:m-${++seq}`, class: 'knowledge', organizationId: orgId, ...data } as never });
const mkNode = (memoryId: string, data: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc: `n-${++seq}`, name: 'n', ...data } as never });
const snapshot = async (nodeId: string) => {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await createNodeRevision(db, { nodeId, memoryId: n.memoryId, loc: n.loc, name: n.name, content: n.content, nodeType: n.nodeType, tags: [] } as never);
};

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  admin = await mkUser('nb18-admin', ['ADMIN']);
  [orgAdmin, reader, ownerU, strangerU] = await Promise.all(['nb18-orgadmin', 'nb18-reader', 'nb18-owner', 'nb18-stranger'].map((n) => mkUser(n)));
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'nb18', urn: 'nb18-org' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: orgAdmin, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: reader, role: 'READER' } });
});
afterEach(() => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }));

describe('#5018 the nodeBytes owner-limit row', () => {
  const READ = `query($orgRef: String) { ownerLimits(orgRef: $orgRef) { key limit used } }`;
  const row = (r: Result) => r.data?.ownerLimits.find((x: { key: string }) => x.key === 'nodeBytes');

  it('is reported with no limit and a total over live nodes in live memories, unmeasured rows counting zero', async () => {
    const live = await orgMemory();
    const dead = await orgMemory({ deletedAt: new Date() });
    const a = await mkNode(live.id, { content: 'abc' });
    await snapshot(a.id);
    const b = await mkNode(live.id, { content: 'defgh' });
    await mkNode(live.id, { content: 'soft', deletedAt: new Date() });
    await mkNode(dead.id, { content: 'in a deleted memory' });
    const unmeasured = await mkNode(live.id, { content: 'not measured yet' });
    await db.$executeRaw`UPDATE nodes SET stored_bytes = NULL, revision_bytes = NULL WHERE id = ${unmeasured.id}`;
    const result = await gql(READ, ctxOf(orgAdmin), { orgRef: orgId });
    expect(result.errors).toBeUndefined();
    expect(row(result)).toEqual({ key: 'nodeBytes', limit: null, used: String(3 + 3 + 5) });
    expect(b.id).toBeTruthy();
  });

  it('a moved node counts at its new owner, with its revisions', async () => {
    const mine = await orgMemory();
    const other = await db.organization.create({ data: { id: generateId(), name: 'nb18b', urn: 'nb18b-org' } });
    const theirs = await db.memory.create({ data: { id: generateId(), name: 't', urn: 'nb18b-org:t', class: 'knowledge', organizationId: other.id } as never });
    const n = await mkNode(mine.id, { content: 'abc' });
    await snapshot(n.id);
    await db.node.update({ where: { id: n.id }, data: { memoryId: theirs.id, loc: `moved-${++seq}` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: orgAdmin, role: 'ADMIN' } });
    expect(row(await gql(READ, ctxOf(orgAdmin), { orgRef: orgId }))?.used).toBe('0');
    expect(row(await gql(READ, ctxOf(orgAdmin), { orgRef: other.id }))?.used).toBe(String(3 + 3));
  });

  it('keeps ownerLimits\' gate: an organization member who is not an ADMIN is FORBIDDEN', async () => {
    expect(codeOf(await gql(READ, ctxOf(reader), { orgRef: orgId }))).toBe('FORBIDDEN');
  });

  it('is not settable: setOwnerLimits naming it is BAD_USER_INPUT and a default naming it is refused', async () => {
    const SET = `mutation($input: SetOwnerLimitsInput!) { setOwnerLimits(input: $input) { key } }`;
    const result = await gql(SET, ctxOf(admin, ['ADMIN']), { input: {
      orgRef: orgId, sourceType: 'manual', sourceId: 't', note: 'n', limits: [{ key: 'nodeBytes', limit: '1' }] } });
    expect(codeOf(result)).toBe('BAD_USER_INPUT');
    expect(await db.ownerLimit.count()).toBe(0);
    expect(OWNER_LIMIT_KEYS.nodeBytes.settable).toBe(false);
    expect(() => parseOwnerDefaultLimits('{"user":{"nodeBytes":1}}')).toThrow(OWNER_DEFAULT_LIMITS_ERROR);
  });
});

describe('#5018 Node.storedBytes and Node.revisionBytes', () => {
  const ONE = `query($ref: ID!) { node(ref: $ref) { id storedBytes revisionBytes } }`;

  it('are on the Node type as Int and String', () => {
    const node = buildSchema(typeDefs).getType('Node') as GraphQLObjectType;
    expect(String(node.getFields().storedBytes?.type)).toBe('Int');
    expect(String(node.getFields().revisionBytes?.type)).toBe('String');
  });

  it('storedBytes is returned to any reader of the node, through node(ref:) and through a slim list path', async () => {
    const m = await orgMemory({ visibility: 'ORGANIZATION' });
    const n = await mkNode(m.id, { content: 'abc' });
    const one = await gql(ONE, ctxOf(reader), { ref: n.id });
    expect(one.errors).toBeUndefined();
    expect(one.data!.node.storedBytes).toBe(3);
    const list = await gql(`query($m: ID!) { findNodes(query: "*", memoryRef: $m) { id storedBytes } }`, ctxOf(reader), { m: m.id });
    expect(list.errors).toBeUndefined();
    expect(list.data!.findNodes.find((x: { id: string }) => x.id === n.id).storedBytes).toBe(3);
  });

  it('revisionBytes is a string of the sum for a reader of every memory a counted revision was taken in', async () => {
    const m = await orgMemory({ visibility: 'ORGANIZATION' });
    const n = await mkNode(m.id, { content: 'abc' });
    await snapshot(n.id);
    const result = await gql(ONE, ctxOf(reader), { ref: n.id });
    expect(result.data!.node.revisionBytes).toBe('3');
  });

  it('revisionBytes is null for a reader who cannot read a memory a revision was taken in (a node moved from a private memory into a shared one)', async () => {
    const priv = await db.memory.create({ data: { id: generateId(), name: 'p', urn: 'nb18-org:p', class: 'private', organizationId: orgId, userId: ownerU } as never });
    const shared = await orgMemory({ visibility: 'ORGANIZATION' });
    const n = await mkNode(priv.id, { content: 'abc' });
    await snapshot(n.id);
    await db.node.update({ where: { id: n.id }, data: { memoryId: shared.id, loc: `moved-${++seq}` } });
    const asReader = await gql(ONE, ctxOf(reader), { ref: n.id });
    expect(asReader.errors).toBeUndefined();
    expect(asReader.data!.node.storedBytes).toBe(3);
    expect(asReader.data!.node.revisionBytes).toBeNull();
    const asOwner = await gql(ONE, ctxOf(ownerU), { ref: n.id });
    expect(asOwner.data!.node.revisionBytes).toBe('3');
    expect(strangerU).toBeTruthy();
  });

  it('a full-row node read followed by JSON.stringify does not throw (the BigInt is left out of the default select)', async () => {
    const n = await mkNode((await orgMemory()).id, { content: 'abc' });
    const full = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect(() => JSON.stringify(full)).not.toThrow();
    expect('revisionBytes' in full).toBe(false);
  });
});
