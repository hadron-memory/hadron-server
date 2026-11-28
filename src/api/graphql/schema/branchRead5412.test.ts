/**
 * #5412 section 5 (gate rulings issuecomment-7238580841 and issuecomment-7238581276): a memory a pure App key reads ONLY through a
 * `memory.read` grant with a `branch`. GraphQL's node surfaces, point read (`node(ref)`) and listing and search (`findNodes`),
 * admit the nodes inside the branch; everything outside it answers exactly like a missing node, totals and pages are computed
 * over the branch alone, and a node admitted this way carries nothing from outside it.
 *
 * Grants are ACTIVE rows written around the ceremony (`insertGrantUnguarded`); the table is append-only, so each case that needs a
 * different grant set uses a memory of its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds, memoryAccessFilter, nodeBranchScopes } from './resolvers.helpers.js';
import { BRANCH_GUARDED_FIELDS, branchGuardedValue } from './branchNodeFields.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, raw, insertGrantUnguarded, type World } from '../../../lib/grants/grantFixtures3668.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const server = new ApolloServer<Context>({ typeDefs, resolvers });
let org: { id: string; urn: string };
let alice: string;
let app: { id: string; urn: string };
let keyId: string;

const keyAuth = (): AuthContext => ({ appId: app.id, appKeyId: keyId, roles: [], clientId: `app:${app.id}` } as AuthContext);
const keyCtx = (): Context => ({ db, ...keyAuth() } as unknown as Context);

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await server.executeOperation({ query, variables }, { contextValue: keyCtx() });
  if (res.body.kind !== 'single') throw new Error('incremental');
  return res.body.singleResult as { data?: Record<string, any> | null; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };
}

async function alicesMemory() {
  const own = await db.organization.create({ data: { id: generateId(), name: `alice-${generateId().slice(-8)}`, urn: `alice-${generateId().slice(-8)}` } });
  await db.orgMember.create({ data: { organizationId: own.id, userId: alice, role: 'OWNER' } });
  return db.memory.create({
    data: { id: generateId(), name: 'a', urn: `${own.urn}:kb`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: own.id } as never,
  });
}
async function activeGrant(values: Record<string, unknown>) {
  return insertGrantUnguarded({ appId: app.id, userId: alice } as World, {
    user_id: null, grantee_app_id: app.id, issuer_user_id: alice, action: 'memory.read', action_values: values,
    activated_at: raw(DB_NOW), verification_kind: 'PASSKEY', verified_by: alice,
  } as never);
}
const node = (memoryId: string, loc: string, content = 'zebrafish marker') =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content } as never });

/** A memory with nodes inside `docs` (the branch), beside it (`docsx`, the boundary), and elsewhere; an edge out of the branch. */
async function branchWorld() {
  const m = await alicesMemory();
  const inside = { docs: await node(m.id, 'docs'), api: await node(m.id, 'docs:api'), v1: await node(m.id, 'docs:api:v1') };
  const outside = { docsx: await node(m.id, 'docsx'), other: await node(m.id, 'other'), secret: await node(m.id, 'other:secret', 'zebrafish SECRET') };
  await db.edge.create({ data: { id: generateId(), memoryId: m.id, sourceId: inside.api.id, targetId: outside.secret.id, name: 'relates_to', loc: 'e1' } as never });
  await db.edge.create({ data: { id: generateId(), memoryId: m.id, sourceId: outside.other.id, targetId: inside.api.id, name: 'relates_to', loc: 'e2' } as never });
  await activeGrant({ memory: m.id, branch: 'docs' });
  return { m, inside, outside };
}

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  org = (await createDbOrgAndGraph(db, { orgName: 'br5412', graphName: 'base' })).org;
  alice = (await db.user.create({ data: { id: generateId(), handle: `alice-${generateId().slice(-6)}` } as never })).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } as never });
  keyId = (await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'k1' } })).id;
  await db.$executeRawUnsafe(`INSERT INTO app_key_scopes (id, app_key_id, scope, granted_by_user_id) VALUES ($1, $2, 'grant:read', $3)`, generateId(), keyId, alice);
});

const POINT = `query($ref: ID!, $mem: ID) { node(ref: $ref, memoryRef: $mem) { id loc } }`;

describe('condition 1: the per-memory reach sets never gain a branch-only memory', () => {
  it('getAccessibleMemoryIds (full and scoped) and memoryAccessFilter leave it out; the branch map carries it', async () => {
    const { m } = await branchWorld();
    expect(await getAccessibleMemoryIds(keyCtx())).not.toContain(m.id);
    expect(await getAccessibleMemoryIds(keyCtx(), m.id)).toEqual([]);
    expect(JSON.stringify(await memoryAccessFilter(keyCtx()))).not.toContain(m.id);
    expect((await nodeBranchScopes(keyCtx())).get(m.id)).toEqual(['docs']);
  });
});

describe('point read: node(ref)', () => {
  it('admits a node inside the branch by id, by loc with memoryRef, and by unscoped loc', async () => {
    const { m, inside } = await branchWorld();
    for (const n of [inside.docs, inside.api, inside.v1]) {
      expect((await gql(POINT, { ref: n.id })).data?.node).toEqual({ id: n.id, loc: n.loc });
      expect((await gql(POINT, { ref: n.loc, mem: m.id })).data?.node).toEqual({ id: n.id, loc: n.loc });
      expect((await gql(POINT, { ref: n.loc })).data?.node).toEqual({ id: n.id, loc: n.loc });
    }
  });

  it('outside the branch (and across the `:` boundary) answers byte-identically to a missing node, in every form', async () => {
    const { m, inside, outside } = await branchWorld();
    const urnOf = async (id: string) => (await gql(`query($ref: ID!) { node(ref: $ref) { urn } }`, { ref: id })).data?.node?.urn as string;
    const insideUrn = await urnOf(inside.api.id);
    expect(insideUrn).toMatch(/docs:api$/);
    const urnAt = (loc: string) => insideUrn.replace(/docs:api$/, loc);
    const missingId = generateId();
    const forms = (loc: string, id: string) => [
      { ref: id }, { ref: loc, mem: m.id }, { ref: loc }, { ref: urnAt(loc) },
    ];
    const answers = async (loc: string, id: string) => Promise.all(forms(loc, id).map((v) => gql(POINT, v)));
    const missing = await answers('docs:nope', missingId);
    for (const r of missing) expect(r).toEqual({ data: { node: null } });
    for (const n of [outside.docsx, outside.other, outside.secret]) {
      expect({ loc: n.loc, answers: await answers(n.loc, n.id) }).toEqual({ loc: n.loc, answers: missing });
    }
  });

  it('a node it admits carries nothing from outside the branch: no edges, no memory record, no comments, stored content', async () => {
    const { inside, outside } = await branchWorld();
    await db.node.update({ where: { id: inside.api.id }, data: { content: 'see {{include other:secret}}' } });
    const r = await gql(`query($ref: ID!) { node(ref: $ref) {
      id content memory { id } outgoingEdges { target { id loc } } incomingEdges { source { id loc } }
      commentSummary { comments openThreads } asComment { id } lintWarnings { items { text } } inheritedFrom { agentId }
      revisionBytes authorship { kind } createdByUser { handle } approvalStatus { state } mintStatus { minted } signingRequests { id }
    } }`, { ref: inside.api.id });
    expect(r.errors).toBeUndefined();
    const n = r.data!.node;
    expect(n.content).toBe('see {{include other:secret}}');
    expect(n.memory).toBeNull();
    expect(n.outgoingEdges).toEqual([]);
    expect(n.incomingEdges).toEqual([]);
    expect(n.commentSummary).toEqual({ comments: 0, openThreads: 0 });
    expect(n.asComment).toBeNull();
    expect(n.lintWarnings).toBeNull();
    expect(n.inheritedFrom).toBeNull();
    expect(n.revisionBytes).toBeNull();
    expect(n.authorship).toBeNull();
    expect(n.createdByUser).toBeNull();
    expect(n.approvalStatus).toEqual({ state: 'NOT_APPLICABLE' });
    expect(n.mintStatus).toEqual({ minted: false });
    expect(n.signingRequests).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(JSON.stringify(r)).not.toContain(outside.secret.id);
    expect(JSON.stringify(r)).not.toContain(outside.other.id);
  });
});

const FIND = `query($q: String, $mode: FindNodesMode, $mem: [ID!], $children: String, $limit: Int, $offset: Int) {
  findNodes(query: $q, mode: $mode, filter: { memoryRefs: $mem, childrenOf: $children }, limit: $limit, offset: $offset) {
    total hits { node { loc outgoingEdges { target { loc } } } }
  } }`;
const locs = (r: Awaited<ReturnType<typeof gql>>) => (r.data?.findNodes?.hits ?? []).map((h: any) => h.node.loc).sort();

describe('listing and search: findNodes', () => {
  it('browse (named memory and broad): only the branch, in the statement', async () => {
    const { m } = await branchWorld();
    expect(locs(await gql(FIND, { mem: [m.id] }))).toEqual(['docs', 'docs:api', 'docs:api:v1']);
    expect(locs(await gql(FIND, {}))).toEqual(['docs', 'docs:api', 'docs:api:v1']);
  });

  it('paging runs over the branch alone: the pages together are the branch, nothing more', async () => {
    const { m } = await branchWorld();
    const pages = [];
    for (let offset = 0; offset < 6; offset += 1) pages.push(...locs(await gql(FIND, { mem: [m.id], limit: 1, offset })));
    expect(pages.sort()).toEqual(['docs', 'docs:api', 'docs:api:v1']);
  });

  it('keyword search: only branch hits, and its total counts the branch alone', async () => {
    const { m } = await branchWorld();
    const r = await gql(FIND, { q: 'zebrafish', mode: 'keyword', mem: [m.id] });
    expect(r.errors).toBeUndefined();
    expect(locs(r)).toEqual(['docs', 'docs:api', 'docs:api:v1']);
    if (r.data!.findNodes.total !== null) expect(r.data!.findNodes.total).toBe(3);
    expect(locs(await gql(FIND, { q: 'SECRET', mode: 'keyword', mem: [m.id] }))).toEqual([]);
  });

  it('a hit carries no edge to a node outside the branch', async () => {
    const { m } = await branchWorld();
    const r = await gql(FIND, { mem: [m.id] });
    for (const h of r.data!.findNodes.hits) expect(h.node.outgoingEdges).toEqual([]);
  });

  it('childrenOf never reaches a branch-only memory (closed)', async () => {
    const { m } = await branchWorld();
    expect(locs(await gql(FIND, { mem: [m.id], children: 'docs' }))).toEqual([]);
    expect(locs(await gql(FIND, { mem: [m.id], children: '' }))).toEqual([]);
  });
});

describe('condition 2: a whole-memory route always wins', () => {
  it('a whole grant beside the branch reads every node; a second memory with the branch alone stays branch-limited', async () => {
    const a = await branchWorld();
    await activeGrant({ memory: a.m.id });
    const b = await branchWorld();
    expect(locs(await gql(FIND, { mem: [a.m.id] }))).toEqual(['docs', 'docs:api', 'docs:api:v1', 'docsx', 'other', 'other:secret']);
    expect((await gql(POINT, { ref: a.outside.secret.id })).data?.node?.id).toBe(a.outside.secret.id);
    expect(locs(await gql(FIND, { mem: [b.m.id] }))).toEqual(['docs', 'docs:api', 'docs:api:v1']);
    expect((await gql(POINT, { ref: b.outside.secret.id })).data?.node).toBeNull();
    expect((await nodeBranchScopes(keyCtx())).has(a.m.id)).toBe(false);
  });
});

describe('condition 6: a branch is a loc prefix on a `:` boundary, and `_` / `%` are literal', () => {
  it('a_b admits a_b and a_b:c, never axb or a_bc; a branch naming `%` is no loc, so its grant is inert and reaches nothing', async () => {
    const m = await alicesMemory();
    for (const loc of ['a_b', 'a_b:c', 'axb', 'a_bc', 'axb:c', 'a%b', 'a%b:c', 'aZZb', 'aZZb:c']) await node(m.id, loc);
    await activeGrant({ memory: m.id, branch: 'a_b' });
    const m2 = await alicesMemory();
    for (const loc of ['aZZb', 'aZZb:c', 'a_b']) await node(m2.id, loc);
    await activeGrant({ memory: m2.id, branch: 'a%b' });
    expect(locs(await gql(FIND, { mem: [m.id] }))).toEqual(['a_b', 'a_b:c']);
    expect(locs(await gql(FIND, { q: 'zebrafish', mode: 'keyword', mem: [m.id] }))).toEqual(['a_b', 'a_b:c']);
    expect(locs(await gql(FIND, { mem: [m2.id] }))).toEqual([]);
    expect((await nodeBranchScopes(keyCtx())).has(m2.id)).toBe(false);
  });
});

describe('condition 2 (issuecomment-7238581276): one pin per guarded Node field', () => {
  // Each guarded field, resolved through the SERVED Node resolver map with the branch-only caller's context, answers its empty value;
  // the same row read by a whole-memory grantee goes to the field's own resolver (a different answer for the fields the fixture fills).
  for (const field of BRANCH_GUARDED_FIELDS) {
    it(field, async () => {
      const { inside } = await branchWorld();
      const row = await db.node.findUniqueOrThrow({ where: { id: inside.api.id } });
      const N = (resolvers as unknown as { Node: Record<string, (p: unknown, a: unknown, c: unknown, i: unknown) => unknown> }).Node;
      const args = field === 'signingRequestsPage' ? {} : undefined;
      const got = await N[field]!(row, args, keyCtx(), { fieldName: field, path: { key: field } });
      expect(got).toEqual(branchGuardedValue(field, row, args));
    });
  }
});
