/**
 * Server-side acceptance for the customer fixes #1300/#1307 (edges),
 * #1303/#1306 (OAuth surface refusal) and #1301/#1305 (governed refusal) — ON
 * THE WIRE, with the credential the CLI actually sends.
 *
 * The per-issue suites (resolvers.specEdge1300, resolvers.governedRefusal1301,
 * 1303-oauth-surface-refusal) pin each fix at its own layer; the first two call
 * resolvers with a hand-built context. This file closes the gap between them:
 * real `createServer`, real HTTP, a real `UserApiKey`, so the caller's roles
 * come from the server's own context builder, not from the test. The envelopes
 * are asserted whole, so this file is also the wire fixture a client can build
 * against (hadron-cli: Jane's repair recipe, Jonas's `reason` handling).
 *
 * The customer shape is Duygu's: GLOBAL platform roles at the schema default
 * (`[READER]`), OWNER of her organisation, working in a memory of that org.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey, type OAuthScope } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

type GqlError = { message: string; extensions?: Record<string, unknown> };
type Gql = { status: number; data: Record<string, any> | null | undefined; errors: GqlError[] | undefined };

let server: Server;
let baseUrl: string;
let memoryId: string;
let memUrn: string;
/** Keys by caller. No key material is asserted or printed. */
const key: Record<string, string> = {};

async function gql(k: string, query: string, variables: Record<string, unknown> = {}): Promise<Gql> {
  const res = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: Record<string, any> | null; errors?: GqlError[] };
  return { status: res.status, data: body.data, errors: body.errors };
}

const CREATE_EDGE = `mutation($s: ID!, $t: ID!, $n: String) { createEdge(sourceRef: $s, targetRef: $t, name: $n) { id name source { id } target { id } } }`;
const UPDATE_EDGE = `mutation($e: ID!, $d: String) { updateEdge(edgeRef: $e, description: $d) { id description } }`;
const DELETE_EDGE = `mutation($e: ID!) { deleteEdge(edgeRef: $e) }`;
const CREATE_SPEC = `mutation($i: CreateNodeInput!) { createSpecNode(input: $i) { id loc } }`;
const UPDATE_SPEC = `mutation($i: UpdateNodeInput!) { updateSpecNode(input: $i) { id data } }`;
const CREATE_NODE = `mutation($i: CreateNodeInput!) { createNode(input: $i) { id } }`;
const MERGE_DATA = `mutation($n: ID!, $d: JSON!) { updateNodeData(nodeRef: $n, data: $d) { id } }`;

let seq = 0;
/** A fresh loc per call, so cases never collide in the shared memory. */
const loc = (prefix: string) => `${prefix}:${Date.now().toString(36)}${(seq++).toString(36)}`;

async function specNode(k: string, l: string, edges?: { targetId: string; name: string }[]) {
  const r = await gql(k, CREATE_SPEC, { i: { memoryId, loc: l, name: l, role: 'spec', data: { version: '0.0.1' }, ...(edges ? { edges } : {}) } });
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data!.createSpecNode.id as string;
}

async function plainNode(k: string, l: string) {
  const r = await gql(k, CREATE_NODE, { i: { memoryId, loc: l, name: l } });
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data!.createNode.id as string;
}

beforeAll(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'cust', urn: `cust-${t}` } });
  // No `roles` given: the schema default, as for every self-signed-up user.
  const owner = await db.user.create({ data: { id: generateId(), handle: `own-${t}`, githubUsername: `own-${t}` } });
  const reader = await db.user.create({ data: { id: generateId(), handle: `rd-${t}`, githubUsername: `rd-${t}` } });
  const outsider = await db.user.create({ data: { id: generateId(), handle: `out-${t}`, githubUsername: `out-${t}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
  // CROSS-TENANT, not merely unaffiliated (@codex, #1308): the outsider OWNS
  // another organisation, so a gate that admitted "anyone with an active org
  // membership" would let them through and the denial cases would catch it.
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: `other-${t}` } });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: outsider.id, role: 'OWNER' } });

  const mint = async (userId: string, label: string, oauthScopes: OAuthScope[]) =>
    (await mintUserApiKey(db, { userId, label, createdBy: userId, issuedVia: 'test', oauthScopes })).rawKey;
  // `account` is what `hadron auth login` mints since v0.15.0; unscoped is a
  // pre-OAuth `hdr_user_*` key. Both must behave identically here.
  key.ownerAccount = await mint(owner.id, 'owner-account', ['account']);
  key.ownerUnscoped = await mint(owner.id, 'owner-unscoped', []);
  key.ownerMcp = await mint(owner.id, 'owner-mcp', ['mcp']);
  key.reader = await mint(reader.id, 'reader', ['account']);
  key.outsider = await mint(outsider.id, 'outsider', ['account']);

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const m = await gql(key.ownerAccount, `mutation($o: ID, $n: String!) { createMemory(orgId: $o, name: $n) { id urn } }`, { o: org.id, n: `specs-${t}` });
  expect(m.errors, JSON.stringify(m.errors)).toBeUndefined();
  memoryId = m.data!.createMemory.id;
  memUrn = m.data!.createMemory.urn;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('#1300/#1307 — edges for a global-READER org OWNER, over HTTP', () => {
  it('the precondition: her platform roles are the schema default', async () => {
    const r = await gql(key.ownerAccount, '{ me { roles } }');
    expect(r.data?.me.roles).toEqual(['READER']);
  });

  for (const which of ['ownerAccount', 'ownerUnscoped'] as const) {
    it(`create → update → delete an edge between spec nodes succeeds (${which} key)`, async () => {
      const k = key[which]!;
      const parent = await specNode(k, loc('app:onb'));
      const child = await specNode(k, loc('app:onb'));

      const c = await gql(k, CREATE_EDGE, { s: child, t: parent, n: 'part-of' });
      expect(c.status).toBe(200);
      expect(c.errors).toBeUndefined();
      expect(c.data!.createEdge).toMatchObject({ name: 'part-of', source: { id: child }, target: { id: parent } });
      const edgeId = c.data!.createEdge.id;

      const u = await gql(k, UPDATE_EDGE, { e: edgeId, d: 'why' });
      expect(u.status).toBe(200);
      expect(u.errors).toBeUndefined();
      expect(u.data!.updateEdge).toEqual({ id: edgeId, description: 'why' });

      const d = await gql(k, DELETE_EDGE, { e: edgeId });
      expect(d.status).toBe(200);
      expect(d.errors).toBeUndefined();
      expect(d.data!.deleteEdge).toBe(true);
    });
  }

  it('the ADDITIVE repair of an existing orphan: one createEdge, and the edges already there survive', async () => {
    // The shape of Duygu's orphans: a rule with a sibling edge but no part-of.
    // `spec link` is a plain createEdge, so it must add, never replace.
    const k = key.ownerAccount!;
    const parent = await specNode(k, loc('app:onb'));
    const sibling = await specNode(k, loc('app:onb'));
    const orphan = await specNode(k, loc('app:onb'), [{ targetId: sibling, name: 'see-also' }]);

    const r = await gql(k, CREATE_EDGE, { s: orphan, t: parent, n: 'part-of' });
    expect(r.errors).toBeUndefined();

    const out = await db.edge.findMany({ where: { sourceId: orphan, deletedAt: null }, orderBy: { name: 'asc' } });
    expect(out.map((e) => [e.name, e.targetId])).toEqual([
      ['part-of', parent],
      ['see-also', sibling],
    ]);
  });

  it('createSpecNode with inline edges is ATOMIC: a bad target leaves no node behind', async () => {
    const l = loc('app:onb');
    const r = await gql(key.ownerAccount!, CREATE_SPEC, {
      i: { memoryId, loc: l, name: 'rule', role: 'spec', edges: [{ targetId: 'app:onb:does-not-exist', name: 'part-of' }] },
    });
    expect(r.errors?.[0]?.message).toMatch(/Edge target not found/);
    // No row at all, tombstones included: a create-then-soft-delete rollback
    // would leave one behind and still read as "no live node" (@copilot, #1308).
    expect(await db.node.findFirst({ where: { memoryId, loc: l } })).toBeNull();
  });

  describe('DENIAL CONTROLS, per mutation, and nothing changes', () => {
    let src: string;
    let tgt: string;
    let edgeId: string;
    beforeAll(async () => {
      src = await plainNode(key.ownerAccount!, loc('n'));
      tgt = await plainNode(key.ownerAccount!, loc('n'));
      edgeId = (await gql(key.ownerAccount!, CREATE_EDGE, { s: src, t: tgt, n: 'rel' })).data!.createEdge.id;
    });

    const tryAll = async (k: string) => ({
      create: await gql(k, CREATE_EDGE, { s: src, t: tgt, n: 'again' }),
      update: await gql(k, UPDATE_EDGE, { e: edgeId, d: 'x' }),
      del: await gql(k, DELETE_EDGE, { e: edgeId }),
    });
    const unchanged = async () => {
      const edges = await db.edge.findMany({ where: { sourceId: src, deletedAt: null } });
      expect(edges.map((e) => [e.id, e.description])).toEqual([[edgeId, null]]);
    };

    it('a READER member of her org: the ordinary denial — HTTP 200, "Forbidden" prose, NO OAuth reason', async () => {
      const r = await tryAll(key.reader!);
      for (const [op, res] of Object.entries(r)) {
        // A resolver denial is a partial GraphQL result: HTTP 200, data null.
        expect(res.status, op).toBe(200);
        expect(res.errors, op).toHaveLength(1);
        expect(res.errors![0]!.message, op).toBe('Forbidden: no write access to this memory');
        // The shared memory-write gate is a typed ordinary denial. It retains
        // GraphQL's partial-response transport and carries no OAuth reason, so
        // clients do not mistake it for either a server fault or re-auth advice.
        expect(res.errors![0]!.extensions, op).toEqual({ code: 'FORBIDDEN' });
      }
      await unchanged();
    });

    it('a user of another organisation: refused on all three as not-found, with no OAuth reason, and nothing changes', async () => {
      const r = await tryAll(key.outsider!);
      // The code is pinned, not just the absence of `reason`: a validation
      // failure would satisfy "one error, no reason" with the gate deleted.
      const expected = { create: 'NODE_NOT_FOUND', update: 'EDGE_NOT_FOUND', del: 'EDGE_NOT_FOUND' };
      for (const [op, res] of Object.entries(r)) {
        expect(res.status, op).toBe(200);
        expect(res.errors, op).toHaveLength(1);
        expect(res.errors![0]!.extensions?.code, op).toBe(expected[op as keyof typeof expected]);
        expect(res.errors![0]!.extensions, op).not.toHaveProperty('reason');
      }
      await unchanged();
    });

    it('an outsider learns nothing about existence: an existing ref answers exactly like a missing one', async () => {
      const missingNode = `hrn:node:${memUrn.replace(/^hrn:mem:/, '')}:n:nope`;
      const missingEdge = 'hrn:edge:nowhere.example:m:n:rel:n';
      const k = key.outsider!;
      // The message and `extensions.ref` echo the ref the caller SENT, so that part differs by
      // construction and discloses nothing; everything else — the HTTP status, `data`, and every
      // error — must be identical (@copilot, #1308: the status is part of the wire contract too).
      const strip = (r: Gql, sent: string) =>
        JSON.parse(JSON.stringify([r.status, r.data, r.errors?.map((e) => [e.message, e.extensions])]).replaceAll(JSON.stringify(sent).slice(1, -1), '<ref>'));
      expect(strip(await gql(k, CREATE_EDGE, { s: src, t: tgt, n: 'x' }), src))
        .toEqual(strip(await gql(k, CREATE_EDGE, { s: missingNode, t: tgt, n: 'x' }), missingNode));
      expect(strip(await gql(k, UPDATE_EDGE, { e: edgeId, d: 'x' }), edgeId))
        .toEqual(strip(await gql(k, UPDATE_EDGE, { e: missingEdge, d: 'x' }), missingEdge));
      expect(strip(await gql(k, DELETE_EDGE, { e: edgeId }), edgeId))
        .toEqual(strip(await gql(k, DELETE_EDGE, { e: missingEdge }), missingEdge));
    });

    it('a genuine internal failure stays INTERNAL_SERVER_ERROR and writes nothing', async () => {
      const fault = vi
        .spyOn(db.memory, 'findUniqueOrThrow')
        .mockRejectedValueOnce(new Error('synthetic database failure'));
      try {
        const r = await gql(key.reader!, CREATE_EDGE, { s: src, t: tgt, n: 'fault' });
        expect(r.status).toBe(200);
        expect(r.data).toBeNull();
        expect(r.errors).toHaveLength(1);
        expect(r.errors![0]!.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
        expect(r.errors![0]!.extensions).not.toHaveProperty('reason');
        expect(await db.edge.count({ where: { sourceId: src, name: 'fault' } })).toBe(0);
      } finally {
        fault.mockRestore();
      }
    });
  });
});

describe('#1303/#1306 — the OAuth refusal and a genuine denial are distinguishable on an edge mutation', () => {
  it('her mcp-only key is refused BEFORE the resolver: 403, FORBIDDEN + reason, and no edge is written', async () => {
    const s = await plainNode(key.ownerAccount!, loc('n'));
    const t = await plainNode(key.ownerAccount!, loc('n'));
    const r = await gql(key.ownerMcp!, CREATE_EDGE, { s, t, n: 'rel' });
    expect(r.status).toBe(403);
    expect(r.errors).toHaveLength(1);
    expect(r.errors![0]!.extensions).toEqual({
      code: 'FORBIDDEN',
      reason: 'OAUTH_SCOPE_INSUFFICIENT',
      requiredScope: 'account',
      grantedScopes: ['mcp'],
    });
    expect(await db.edge.count({ where: { sourceId: s } })).toBe(0);
  });

  it('the rule a client applies: `reason` is one of the OAUTH_SCOPE_* VALUES ⇒ the credential; anything else is not', async () => {
    // Keyed on the reason VALUE — not on `code`, so it survives #1220 retyping
    // the ordinary denial to FORBIDDEN; and not on the mere presence of
    // `reason`, which other errors also carry (@codex, #1308): an invalid edge
    // condition, a malformed URN (formatError's BAD_USER_INPUT).
    const OAUTH_REFUSALS = ['OAUTH_SCOPE_INSUFFICIENT', 'OAUTH_SCOPE_UNSUPPORTED'];
    const isCredentialRefusal = (r: Gql) => OAUTH_REFUSALS.includes(r.errors?.[0]?.extensions?.reason as string);

    const s = await plainNode(key.ownerAccount!, loc('n'));
    const t = await plainNode(key.ownerAccount!, loc('n'));
    const oauth = await gql(key.ownerMcp!, CREATE_EDGE, { s, t, n: 'rel' });
    const denial = await gql(key.reader!, CREATE_EDGE, { s, t, n: 'rel' });
    // COUNTEREXAMPLE: her own valid key, an input error that DOES carry a reason.
    const inputError = await gql(
      key.ownerAccount!,
      `mutation($s: ID!, $t: ID!, $c: JSON) { createEdge(sourceRef: $s, targetRef: $t, name: "c", condition: $c) { id } }`,
      { s, t, c: { op: 'no-such-operator' } },
    );

    expect([oauth.status, denial.status, inputError.status]).toEqual([403, 200, 200]);
    expect(inputError.errors![0]!.extensions).toMatchObject({ code: 'INVALID_EDGE_CONDITION' });
    expect(inputError.errors![0]!.extensions).toHaveProperty('reason');
    expect([isCredentialRefusal(oauth), isCredentialRefusal(denial), isCredentialRefusal(inputError)]).toEqual([true, false, false]);
  });
});

describe('#1301/#1305 — a governed refusal names a route, and that route works, over HTTP', () => {
  it('a data MERGE on her spec node: ROLE_GOVERNED naming the replace route', async () => {
    const n = await specNode(key.ownerAccount!, loc('app:onb'));
    const r = await gql(key.ownerAccount!, MERGE_DATA, { n, d: { provenance: 'x' } });
    expect(r.status).toBe(200);
    expect(r.errors).toHaveLength(1);
    const e = r.errors![0]!;
    expect(e.extensions).toMatchObject({ code: 'ROLE_GOVERNED', kind: 'spec', door: 'updateSpecNode', mcpDoor: null, merge: 'data' });
    expect(e.message).toContain('no door merges');
    expect(e.message).toContain('including the keys it already has');
    expect(e.message).toContain("`hadron node update <ref> --data '<object>'`");
    expect(e.message).not.toContain('MCP');
  });

  it('TRUTHFUL: on the SAME node, the refusal changes nothing and the named route then succeeds, keeping what was resent', async () => {
    // One resource end to end: the node that was refused is the node the
    // route is followed on (@copilot, #1308 round 2).
    const k = key.ownerAccount!;
    const n = await specNode(k, loc('app:onb'));

    const refused = await gql(k, MERGE_DATA, { n, d: { provenance: 'x' } });
    expect(refused.errors?.[0]?.extensions).toMatchObject({ code: 'ROLE_GOVERNED', door: 'updateSpecNode', merge: 'data' });
    expect((await db.node.findUniqueOrThrow({ where: { id: n } })).data).toEqual({ version: '0.0.1' });

    // What the refusal says to do: a REPLACE carrying the keys already there.
    const r = await gql(k, UPDATE_SPEC, { i: { id: n, data: { version: '0.0.1', provenance: 'x' } } });
    expect(r.errors).toBeUndefined();
    expect(r.data!.updateSpecNode).toEqual({ id: n, data: { version: '0.0.1', provenance: 'x' } });
  });
});
