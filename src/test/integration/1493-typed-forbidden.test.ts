/**
 * #1493 — the shared authorization gates deny with a TYPED code, on the wire.
 *
 * Before this fix, `requireRole`, `requireOrgRole`, `requireOwnerOrOrgRole`,
 * `requireOrgAction` and their siblings threw a plain `Error('Forbidden')`.
 * Apollo reports a plain Error as `extensions.code: "INTERNAL_SERVER_ERROR"`,
 * so a permission refusal looked like a server fault to every client, and to
 * alerting. #1313 fixed only the memory-write gate.
 *
 * The contract is what a client SEES, so this file drives real HTTP with a
 * real `UserApiKey`. A resolver-level test cannot see the wire code
 * (`findings:resolver-level-test-cannot-see-the-wire-code`). It pins three
 * things:
 * - each gate family's refusal is `{ code: 'FORBIDDEN' }` with its message
 *   unchanged;
 * - a surface that deliberately conceals existence keeps its own code;
 * - a genuine fault inside a gate is still `INTERNAL_SERVER_ERROR`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey } from '../../middleware/auth.js';

type GqlError = { message: string; extensions?: Record<string, unknown> };
type Gql = { status: number; data: Record<string, any> | null | undefined; errors: GqlError[] | undefined };

let server: Server;
let baseUrl: string;
let orgId: string;
let agentId: string;
let appId: string;
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

/** The whole refusal envelope, so a stray `reason` or a changed message fails too. */
function expectForbidden(r: Gql, message = 'Forbidden') {
  expect(r.status).toBe(200);
  expect(r.errors, JSON.stringify(r.errors)).toHaveLength(1);
  expect(r.errors![0]!.message).toBe(message);
  expect(r.errors![0]!.extensions).toEqual({ code: 'FORBIDDEN' });
}

const UPDATE_ORG = `mutation($id: ID!, $n: String) { updateOrganization(id: $id, name: $n) { id } }`;
const UPDATE_AGENT = `mutation($r: ID!, $d: String) { updateAgent(ref: $r, description: $d) { id } }`;
const CREATE_MEMORY = `mutation($o: ID, $n: String!) { createMemory(orgId: $o, name: $n) { id } }`;
const NODE_REVISIONS = `query($n: ID!) { nodeRevisions(nodeRef: $n) { id } }`;
const LATEST_APP_RUN = `query($a: String!) { latestAppRun(appRef: $a) { id } }`;

beforeAll(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'org', urn: `org-${t}` } });
  orgId = org.id;
  const owner = await db.user.create({ data: { id: generateId(), handle: `own-${t}`, githubUsername: `own-${t}` } });
  const reader = await db.user.create({ data: { id: generateId(), handle: `rd-${t}`, githubUsername: `rd-${t}` } });
  // CROSS-TENANT, not merely unaffiliated: the outsider OWNS another org, so a
  // gate that admitted "anyone with an org membership" would let them through.
  const outsider = await db.user.create({ data: { id: generateId(), handle: `out-${t}`, githubUsername: `out-${t}` } });
  // A principal with NO platform role: the one shape `requireRole('READER')` refuses.
  const roleless = await db.user.create({
    data: { id: generateId(), handle: `nr-${t}`, githubUsername: `nr-${t}`, roles: [] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'READER' } });
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: `other-${t}` } });
  await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: outsider.id, role: 'OWNER' } });

  const mint = async (userId: string, label: string) =>
    (await mintUserApiKey(db, { userId, label, createdBy: userId, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
  key.owner = await mint(owner.id, 'owner');
  key.reader = await mint(reader.id, 'reader');
  key.outsider = await mint(outsider.id, 'outsider');
  key.roleless = await mint(roleless.id, 'roleless');

  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const a = await gql(key.owner, `mutation($o: ID, $n: String!) { createAgent(orgId: $o, name: $n) { id } }`, { o: org.id, n: `agent-${t}` });
  expect(a.errors, JSON.stringify(a.errors)).toBeUndefined();
  agentId = a.data!.createAgent.id;

  appId = generateId();
  await db.app.create({ data: { id: appId, name: `app-${t}`, urn: `org-${t}:app-${t}`, organizationId: org.id } });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('#1493 — shared-gate denials are FORBIDDEN on the wire', () => {
  it('requireOrgRole: an org READER renaming the org', async () => {
    expectForbidden(await gql(key.reader, UPDATE_ORG, { id: orgId, n: 'renamed' }));
    expect((await db.organization.findUnique({ where: { id: orgId } }))!.name).toBe('org');
  });

  it('requireOwnerOrOrgRole: an org READER editing an org Agent (the portal#971 surface)', async () => {
    expectForbidden(await gql(key.reader, UPDATE_AGENT, { r: agentId, d: 'changed' }));
    expect((await db.agent.findUnique({ where: { id: agentId } }))!.description).not.toBe('changed');
  });

  it('requireOrgAction: an outsider creating a memory in an org they do not belong to', async () => {
    expectForbidden(await gql(key.outsider, CREATE_MEMORY, { o: orgId, n: 'intruder' }));
    expect(await db.memory.count({ where: { organizationId: orgId, name: 'intruder' } })).toBe(0);
  });

  it('requireRole: a principal with no platform role reading revisions', async () => {
    expectForbidden(await gql(key.roleless, NODE_REVISIONS, { n: generateId() }));
  });

  it('the positive control: the org OWNER passes the same gate', async () => {
    const r = await gql(key.owner, UPDATE_AGENT, { r: agentId, d: 'owner edit' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  });

  it('a concealing surface keeps its own code: a foreign App reads as NOT_FOUND, not FORBIDDEN', async () => {
    const r = await gql(key.outsider, LATEST_APP_RUN, { a: appId });
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(1);
    expect(r.errors![0]!.message).toBe('App not found.');
    expect(r.errors![0]!.extensions).toEqual({ code: 'NOT_FOUND' });
  });

  it('a genuine fault inside a gate stays INTERNAL_SERVER_ERROR and writes nothing', async () => {
    const fault = vi
      .spyOn(db.orgMember, 'findFirst')
      .mockRejectedValueOnce(new Error('synthetic database failure'));
    try {
      const r = await gql(key.reader, UPDATE_ORG, { id: orgId, n: 'fault' });
      expect(r.status).toBe(200);
      expect(r.errors).toHaveLength(1);
      expect(r.errors![0]!.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
      expect(fault).toHaveBeenCalled();
      expect((await db.organization.findUnique({ where: { id: orgId } }))!.name).toBe('org');
    } finally {
      fault.mockRestore();
    }
  });
});
