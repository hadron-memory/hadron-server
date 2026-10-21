/**
 * #2176 — the validated user reaches node writes over the REAL HTTP surfaces and lands where the
 * revision's editor lands. GraphQL and MCP (single calls and JSON-RPC batches, which the SDK runs
 * concurrently), the wire read by detail and by findNodes, and impersonation: refused before any
 * stamp on both surfaces, so no target is ever recorded as an editor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey } from '../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let server: Server;
let baseUrl: string;
let token: string;
let user: { id: string; handle: string };
let target: { id: string };
let org: { id: string };
let memory: { id: string; urn: string };
let worker: { id: string };
let agent: { id: string };
let sessionId: string;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Upd User', urn: 'updbyuser.example' } });
  user = await db.user.create({ data: { githubId: 217601, githubUsername: 'upd-user', handle: 'upd-user', roles: ['READER'] }, select: { id: true, handle: true } }) as never;
  target = await db.user.create({ data: { id: generateId(), handle: 'upd-target', name: 'target', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: target.id, role: 'CONTRIBUTOR' } });
  const ctx: Context = { db, userId: user.id, roles: [] };
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'upd-user' }, ctx);
  agent = await db.agent.create({ data: { id: generateId(), urn: 'updbyuser.example:eng', name: 'eng', organizationId: org.id } });
  const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'updbyuser.example:team', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  sessionId = generateId();
  await db.session.create({ data: { id: sessionId, appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() } });
  ({ rawKey: token } = await mintUserApiKey(db, { userId: user.id, label: null, createdBy: user.id, issuedVia: 'test' }));
});

const hdr = (auth = token, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...extra });
const gql = async (query: string, variables: Record<string, unknown>, auth = token, extra: Record<string, string> = {}) => {
  const res = await fetch(`${baseUrl}/graphql`, { method: 'POST', headers: hdr(auth, extra), body: JSON.stringify({ query, variables }) });
  return await res.json() as { data?: any; errors?: Array<{ message: string }> };
};
const seed = (loc: string) => db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: loc } });
const stamp = async (loc: string) => {
  const r = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc }, select: { id: true, updatedByUserId: true, updatedByWorkerId: true, updatedByAgentId: true } });
  return r;
};
const UPDATE = 'mutation($input: UpdateNodeInput!) { updateNode(input: $input) { id } }';

async function mcp() {
  const h = { ...hdr(token, { accept: 'application/json, text/event-stream' }) };
  const init = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '2176', version: '1' } } }) });
  expect(init.status).toBe(200);
  const sid = init.headers.get('mcp-session-id')!;
  let id = 10;
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { ...h, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await res.text();
    expect(text, text).not.toContain('"isError":true');
  };
  const batch = async (calls: Array<{ name: string; args: Record<string, unknown> }>) => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { ...h, 'mcp-session-id': sid }, body: JSON.stringify(calls.map((c) => ({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: c.name, arguments: c.args } }))) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text, text).not.toContain('"isError":true');
  };
  return { call, batch };
}
const nodeUrn = (loc: string) => `hrn:node:${memory.urn}:${loc}`;

describe('GraphQL: the stamp, the revision and the wire agree', () => {
  it('records the authenticated user, the same one the revision records, and a worker session adds the worker', async () => {
    await seed('g1');
    const r1 = await gql(UPDATE, { input: { memoryId: memory.id, loc: 'g1', name: 'one' } });
    expect(r1.errors).toBeUndefined();
    expect(await stamp('g1')).toMatchObject({ updatedByUserId: user.id, updatedByWorkerId: null });
    const r2 = await gql(UPDATE, { input: { memoryId: memory.id, loc: 'g1', name: 'two' } }, token, { 'x-hadron-session': sessionId });
    expect(r2.errors).toBeUndefined();
    expect(await stamp('g1')).toMatchObject({ updatedByUserId: user.id, updatedByWorkerId: worker.id, updatedByAgentId: agent.id });
    const node = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'g1' } });
    const latest = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: node.id }, orderBy: { revNo: 'desc' } });
    expect(latest.editedBy).toBe(node.updatedByUserId); // node and revision never name different users
  });

  it('detail and findNodes project the same updatedByUser (handle + urn), and null for an unedited node', async () => {
    await seed('g2'); await seed('g3');
    await gql(UPDATE, { input: { memoryId: memory.id, loc: 'g2', name: 'edited' } });
    const detail = await gql('query($m: ID!) { node(ref: "g2", memoryRef: $m) { updatedByUser { handle urn } } }', { m: memory.id });
    expect(detail.errors).toBeUndefined();
    expect(detail.data.node.updatedByUser).toEqual({ handle: user.handle, urn: expect.stringContaining(user.handle) });
    const found = await gql('query($m: ID!) { findNodes(filter: { memoryIds: [$m] }, limit: 20) { hits { node { loc updatedByUser { handle urn } } } } }', { m: memory.id });
    expect(found.errors).toBeUndefined();
    const byLoc = Object.fromEntries(found.data.findNodes.hits.map((h: any) => [h.node.loc, h.node.updatedByUser]));
    expect(byLoc.g2).toEqual(detail.data.node.updatedByUser);
    expect(byLoc.g3).toBeNull();
  });
});

describe('MCP: single calls and concurrent batches record the user', () => {
  it('hadron_update_node records the connection\'s user', async () => {
    await seed('m1');
    const { call } = await mcp();
    await call('hadron_update_node', { urn: nodeUrn('m1'), name: 'via mcp' });
    expect((await stamp('m1')).updatedByUserId).toBe(user.id);
  });

  it('every call of a JSON-RPC batch records the user, over several rounds', async () => {
    const { batch } = await mcp();
    for (let round = 0; round < 5; round++) {
      const locs = ['a', 'b', 'c'].map((s) => `batch-${round}-${s}`);
      for (const l of locs) await seed(l);
      await batch(locs.map((l) => ({ name: 'hadron_update_node', args: { urn: nodeUrn(l), name: `${l}!` } })));
      for (const l of locs) expect((await stamp(l)).updatedByUserId, l).toBe(user.id);
    }
  });
});

describe('impersonation is refused before any stamp, on both surfaces', () => {
  async function impersonationToken(): Promise<string> {
    const started = await (resolvers.Mutation.startImpersonation as any)({}, { orgRef: org.id, userRef: target.id, reason: '2176' }, { db, userId: user.id, roles: [] });
    return started.token as string;
  }

  it('GraphQL: updateNode / createNode / deleteNode under an impersonation token fail and leave the node untouched', async () => {
    await seed('imp');
    const imp = await impersonationToken();
    const before = await stamp('imp');
    for (const [q, v] of [
      [UPDATE, { input: { memoryId: memory.id, loc: 'imp', name: 'hijack' } }],
      ['mutation($input: CreateNodeInput!) { createNode(input: $input) { id } }', { input: { memoryId: memory.id, loc: 'imp2', name: 'x' } }],
      ['mutation($m: ID!) { deleteNode(memoryId: $m, loc: "imp") }', { m: memory.id }],
    ] as const) {
      const out = await gql(q, v as never, imp);
      expect(out.errors?.length, q).toBeGreaterThan(0);
    }
    expect(await stamp('imp')).toEqual(before);
    expect(await db.node.findFirst({ where: { memoryId: memory.id, loc: 'imp2' } })).toBeNull();
    expect((await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'imp' } })).name).toBe('imp');
    expect((await stamp('imp')).updatedByUserId).not.toBe(target.id);
  });

  it('MCP: an impersonation token cannot open a session at all', async () => {
    const imp = await impersonationToken();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: hdr(imp, { accept: 'application/json, text/event-stream' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'imp', version: '1' } } }),
    });
    expect(res.status).toBe(401);
  });
});
