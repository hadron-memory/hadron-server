/** #3818 V24/V25: supersession evidence is explicit; successor disclosure uses the current read gate. */
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../../server.js';
import { randomBytes } from 'node:crypto';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { ApolloServer, HeaderMap } from '@apollo/server';
import { formatGraphQLError } from '../formatError.js';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { signJwt } from '../../../auth/jwt.js';
import { handleMcpRequest, createTestableMcpServer } from '../../../mcp/server.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import type { Request } from 'express';
import { resolveAuthContext, validateSessionBinding } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));
const M = resolvers.Mutation as any;
const server = new ApolloServer<Context>({ typeDefs, resolvers });
let owner: { id: string }, stranger: { id: string }, app: { id: string }, worker: { id: string };
const ctx = (userId = owner.id): Context => ({ db, userId, roles: ['READER'] });
async function bind(force = false) {
  return M.startSession({}, { input: { id: generateId(), workerRef: worker.id, tool: 'codex', force } }, ctx());
}
async function displaced() {
  const a = await bind();
  const old = new Date(Date.now() - 72 * 3600000);
  await db.session.update({ where: { id: a.id }, data: { startedAt: old, updatedAt: old, summary: 'driver summary' } });
  return { a, b: await bind() };
}
beforeEach(async () => {
  await cleanDb(db);
  owner = await db.user.create({ data: { handle: `owner3818-${generateId()}`, roles: ['READER'] } });
  stranger = await db.user.create({ data: { handle: `stranger3818-${generateId()}`, roles: ['READER'] } });
  app = await db.app.create({ data: { ownerUserId: owner.id, name: 'Supersede', urn: `hrn:app:test:supersede-${generateId()}` } });
  const agent = await db.agent.create({ data: { ownerUserId: owner.id, name: 'Role', urn: `hrn:agent:test:role-${generateId()}` } });
  await serveAgentBootPrompt(db, agent.id, 'Synthetic boot prompt.');
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Test', slug: 'test', heldByUserId: owner.id } });
});
it('records the immediate successor atomically, preserving summary and previous chain', async () => {
  const { a, b } = await displaced();
  expect(await db.session.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
    endReason: 'superseded', supersededBySessionId: b.id, summary: 'driver summary', autoExpiredAt: null,
  });
  expect(b.prevSessionId).toBe(a.id);
});
it('refuses a stale execution binding with current session id and start time for its reader', async () => {
  const { a, b } = await displaced();
  await expect(validateSessionBinding(db, ctx(), a.id)).rejects.toMatchObject({ extensions: {
    code: 'SESSION_SUPERSEDED', sessionId: b.id, startedAt: b.startedAt.toISOString(),
  } });
});
it('knowing the old id alone discloses neither successor id nor start time', async () => {
  const { a } = await displaced();
  await expect(validateSessionBinding(db, ctx(stranger.id), a.id)).rejects.toMatchObject({ extensions: { code: 'SESSION_SUPERSEDED' } });
  try { await validateSessionBinding(db, ctx(stranger.id), a.id); expect.fail('must refuse'); }
  catch (e) { expect((e as any).extensions).toEqual({ code: 'SESSION_SUPERSEDED' }); }
});
it('publishes the stored successor on an ended record only if the successor is readable now', async () => {
  const { a, b } = await displaced();
  const query = 'query($id:ID!){ session(id:$id){ id supersededBySessionId } }';
  const read = async () => {
    const r = await server.executeOperation({ query, variables: { id: a.id } }, { contextValue: ctx() });
    if (r.body.kind !== 'single') throw new Error('incremental response');
    expect(r.body.singleResult.errors).toBeUndefined();
    return r.body.singleResult.data;
  };
  expect(await read()).toEqual({ session: { id: a.id, supersededBySessionId: b.id } });
});
it.each(['ended', 'expired'] as const)('keeps ordinary %s binding answers unchanged', async endReason => {
  const a = await bind();
  await db.session.update({ where: { id: a.id }, data: { endedAt: new Date(), endReason } });
  expect(await validateSessionBinding(db, ctx(), a.id)).toBeNull();
});
it('still refuses a live takeover without force; explicit force supplies supersession evidence', async () => {
  const a = await bind();
  await expect(bind()).rejects.toMatchObject({ extensions: { code: 'WORKER_TAKEN' } });
  expect(await db.session.count({ where: { workerId: worker.id } })).toBe(1);
  const b = await bind(true);
  expect((await db.session.findUniqueOrThrow({ where: { id: a.id } })) as any).toMatchObject({ supersededBySessionId: b.id });
});

it('independently gates a stored successor behind strict personal-memory ownership', async () => {
  const memory = await db.memory.create({ data: { ownerUserId: stranger.id, userId: stranger.id, class: 'personal', name: 'Other personal', urn: `test:other3818-${generateId()}` } });
  const b = await db.session.create({ data: { id: generateId(), userId: owner.id, memoryId: memory.id } });
  const a = await db.session.create({ data: { id: generateId(), userId: owner.id, endedAt: new Date(), endReason: 'superseded', supersededBySessionId: b.id } as never });
  const r = await server.executeOperation({ query: 'query($id:ID!){ session(id:$id){ id supersededBySessionId } }', variables: { id: a.id } }, { contextValue: ctx() });
  if (r.body.kind !== 'single') throw new Error('incremental response');
  expect(r.body.singleResult.errors).toBeUndefined();
  expect(r.body.singleResult.data).toEqual({ session: { id: a.id, supersededBySessionId: null } });
});

it('keeps immediate successor evidence while refusing with the latest current open session', async () => {
  const { a, b } = await displaced();
  const c = await bind(true);
  // Other drivers' old open rows are not superseded by this person's bind (#1617 C).
  await db.session.create({ data: { id: generateId(), userId: stranger.id, appId: app.id, workerId: worker.id, startedAt: new Date(Date.now() - 86400000) } });
  expect((await db.session.findUniqueOrThrow({ where: { id: a.id } })) as any).toMatchObject({ supersededBySessionId: b.id });
  await expect(validateSessionBinding(db, ctx(), a.id)).rejects.toMatchObject({ extensions: { code: 'SESSION_SUPERSEDED', sessionId: c.id, startedAt: c.startedAt.toISOString() } });
});

it('refuses an acting chat sessionRef before appending any message', async () => {
  const { a, b } = await displaced();
  const memory = await db.memory.create({ data: { ownerUserId: owner.id, userId: owner.id, class: 'personal', urn: `test:chat3818-${generateId()}`, name: 'Chat' } });
  const { channel } = await ensureChannelWithRoot(db, { memoryId: memory.id, loc: 'chats:supersede', name: 'Chat', createdBy: owner.id });
  await expect(M.createChannelMessage({}, { channelRef: channel.id, body: 'must not land', sessionRef: a.id }, ctx())).rejects.toMatchObject({ extensions: { code: 'SESSION_SUPERSEDED', sessionId: b.id } });
  expect((await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).lastSeq).toBe(0);
});
it('refuses an acting mark-read sessionRef before any cursor write', async () => {
  const { a, b } = await displaced();
  await expect(M.markOwnTeamChatRead({}, { appRef: app.id, sessionRef: a.id, channelRef: generateId(), seq: 0 }, ctx())).rejects.toMatchObject({ extensions: { code: 'SESSION_SUPERSEDED', sessionId: b.id } });
  expect(await db.channelReadState.count()).toBe(0);
});
it('keeps explicit-target late provenance and end/outcome writes available without presenting the old binding', async () => {
  const { a, b } = await displaced();
  expect((await M.updateSession({}, { id: a.id, branch: 'late-merge' }, ctx())).branch).toBe('late-merge');
  await M.endSession({}, { id: a.id, summary: 'late attribution' }, ctx());
  await M.recordSessionOutcome({}, { sessionId: a.id, outcome: 1 }, ctx());
  expect(await db.session.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ endReason: 'superseded', supersededBySessionId: b.id, outcome: 1 });
});
it('refuses a superseded header at the real credential-context boundary', async () => {
  const { a, b } = await displaced();
  const token = await signJwt({ sub: owner.id, roles: ['READER'] });
  const req = { headers: { authorization: `Bearer ${token}`, 'x-hadron-session': a.id } } as unknown as Request;
  await expect(resolveAuthContext(req, db)).rejects.toMatchObject({ extensions: { code: 'SESSION_SUPERSEDED', sessionId: b.id } });
});

it.each(['ended', 'deleted'] as const)('names no current session once the successor is %s', async state => {
  const { a, b } = await displaced();
  if (state === 'ended') await M.endSession({}, { id: b.id }, ctx());
  else await db.session.update({ where: { id: b.id }, data: { deletedAt: new Date() } });
  try { await validateSessionBinding(db, ctx(), a.id); expect.fail('must refuse'); }
  catch (e) { expect((e as any).extensions).toEqual({ code: 'SESSION_SUPERSEDED' }); }
});
it.each([true, false])('keeps the typed refusal and gated details on the Apollo HTTP envelope (reader=%s)', async reader => {
  const { a, b } = await displaced();
  const token = await signJwt({ sub: reader ? owner.id : stranger.id, roles: ['READER'] });
  const req = { headers: { authorization: `Bearer ${token}`, 'x-hadron-session': a.id } } as unknown as Request;
  const wire = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
  await wire.start();
  try {
    const headers = new HeaderMap(); headers.set('content-type', 'application/json');
    const result = await wire.executeHTTPGraphQLRequest({
      httpGraphQLRequest: { method: 'POST', headers, search: '', body: { query: '{ __typename }' } },
      context: async () => ({ db, ...await resolveAuthContext(req, db) }),
    });
    if (result.body.kind !== 'complete') throw new Error('incremental response');
    const envelope = JSON.parse(result.body.string);
    expect(envelope.data).toBeUndefined();
    expect(envelope.errors[0].extensions).toEqual(reader
      ? { code: 'SESSION_SUPERSEDED', sessionId: b.id, startedAt: b.startedAt.toISOString() }
      : { code: 'SESSION_SUPERSEDED' });
    expect(envelope.errors[0].message).toContain('Session superseded.');
    if (!reader) expect(result.body.string).not.toContain(b.id);
  } finally { await wire.stop(); }
});

it('keeps MCP end id as an explicit historical target, without presenting it as an execution binding', async () => {
  const { a, b } = await displaced();
  const mcp = createTestableMcpServer({ userId: owner.id, roles: ['READER'] });
  const text = await mcp.callToolText('hadron_end_session', { id: a.id, summary: 'late MCP attribution' });
  expect(text).toContain('ALREADY ended');
  expect(await db.session.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ endReason: 'superseded', supersededBySessionId: b.id, summary: 'late MCP attribution' });
});

it('keeps SESSION_SUPERSEDED structured on an MCP core acting-session refusal', async () => {
  const { a, b } = await displaced();
  const mcp = createTestableMcpServer({ userId: owner.id, roles: ['READER'] });
  const result = await mcp.callTool('hadron_update_node_data', { node: generateId(), data: {}, session: a.id }) as any;
  expect(result.isError).toBe(true);
  expect(result.structuredContent.error).toMatchObject({ code: 'SESSION_SUPERSEDED', sessionId: b.id, startedAt: b.startedAt.toISOString() });
});
it.each([true, false])('returns a typed MCP header refusal before initializing a transport (reader=%s)', async reader => {
  const { a, b } = await displaced();
  const token = await signJwt({ sub: reader ? owner.id : stranger.id, roles: ['READER'] });
  const req = { headers: { authorization: `Bearer ${token}`, 'x-hadron-session': a.id }, method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic3818', version: '1' } } } } as unknown as Request;
  let status: number | undefined, body: any;
  const res = { headersSent: false, status(n: number) { status = n; return this; }, json(value: unknown) { body = value; return this; } };
  await handleMcpRequest(req, res as any);
  expect(status).toBe(409);
  expect(body.code).toBe('SESSION_SUPERSEDED');
  if (reader) expect(body).toMatchObject({ sessionId: b.id, startedAt: b.startedAt.toISOString() });
  else { expect(body.sessionId).toBeUndefined(); expect(body.startedAt).toBeUndefined(); expect(JSON.stringify(body)).not.toContain(b.id); }
});

let httpServer: Server, baseUrl: string;
beforeAll(async () => {
  httpServer = createHttpServer(await createServer());
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => httpServer.close(() => resolve())); });
async function wire(path: string, token: string, body?: unknown, headers = {}, method = 'POST') {
  return fetch(baseUrl + path, { method, headers: {
    accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`,
    ...(body ? { 'content-type': 'application/json' } : {}), ...headers,
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const init3818 = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: '3818-wire', version: '1' },
} };
it('checks MCP transport ownership before disclosing a presented stale-session refusal', async () => {
  const token = await signJwt({ sub: owner.id, roles: ['READER'] });
  const other = await signJwt({ sub: stranger.id, roles: ['READER'] });
  const { a } = await displaced();
  const opened = await wire('/mcp', token, init3818);
  expect(opened.status).toBe(200); await opened.text();
  const id = opened.headers.get('mcp-session-id')!;
  try {
    const headers = { 'mcp-session-id': id, 'x-hadron-session': a.id };
    const body = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    const foreign = await wire('/mcp', other, body, headers);
    expect(foreign.status).toBe(404); expect(await foreign.text()).not.toContain('SESSION_SUPERSEDED');
    const own = await wire('/mcp', token, body, headers);
    expect(own.status).toBe(409); expect(await own.json()).toMatchObject({ code: 'SESSION_SUPERSEDED' });
  } finally { expect((await wire('/mcp', token, undefined, { 'mcp-session-id': id }, 'DELETE')).status).toBe(200); }
});
it('keeps OAuth surface refusal ahead of stale header disclosure on GraphQL and MCP', async () => {
  const { a } = await displaced();
  for (const [scope, path, body] of [['mcp', '/graphql', { query: '{ __typename }' }], ['mcp', '/sessions/target/outcome', { outcome: 1 }], ['unsupported3818', '/mcp', init3818]] as const) {
    const raw = USER_API_KEY_PREFIX + randomBytes(32).toString('hex');
    await db.userApiKey.create({ data: { userId: owner.id, keyHash: hashUserApiKey(raw), keyPreview: raw.slice(-4), createdBy: owner.id, issuedVia: 'portal', oauthScopes: [scope] } });
    const reply = await wire(path, raw, body, { 'x-hadron-session': a.id });
    expect(reply.status).toBe(403); const text = await reply.text();
    expect(text).toContain('FORBIDDEN'); expect(text).not.toContain('SESSION_SUPERSEDED');
  }
});
it.each(['/reload', '/sessions/target/outcome'])('keeps superseded execution headers typed on REST %s', async path => {
  const { a } = await displaced();
  const token = await signJwt({ sub: owner.id, roles: ['READER'] });
  const reply = await wire(path, token, { outcome: 1 }, { 'x-hadron-session': a.id });
  expect(reply.status).toBe(409); expect(await reply.json()).toMatchObject({ code: 'SESSION_SUPERSEDED' });
});
it('refuses a superseded retained MCP execution binding without silently rebinding', async () => {
  const token = await signJwt({ sub: owner.id, roles: ['READER'] });
  const opened = await wire('/mcp', token, init3818);
  expect(opened.status).toBe(200); await opened.text();
  const id = opened.headers.get('mcp-session-id')!;
  try {
    const started = await wire('/mcp', token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hadron_start_session', arguments: { description: '3818 retained synthetic' } } }, { 'mcp-session-id': id });
    expect(started.status).toBe(200); await started.text();
    const a = await db.session.findFirstOrThrow({ where: { userId: owner.id } });
    const b = await bind();
    // MCP cannot bind workers. Seed the historical superseded state after the real tool retained its plain binding.
    await db.session.update({ where: { id: a.id }, data: { workerId: worker.id, endedAt: new Date(), endReason: 'superseded', supersededBySessionId: b.id } });
    const reply = await wire('/mcp', token, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { 'mcp-session-id': id });
    expect(reply.status).toBe(409);
    expect(await reply.json()).toMatchObject({ code: 'SESSION_SUPERSEDED', sessionId: b.id });
    expect(await db.session.count({ where: { workerId: worker.id } })).toBe(2);
  } finally { expect((await wire('/mcp', token, undefined, { 'mcp-session-id': id }, 'DELETE')).status).toBe(200); }
});
it('keeps the schema endpoint superseded refusal typed through Express error middleware', async () => {
  const { a } = await displaced();
  const token = await signJwt({ sub: owner.id, roles: ['READER'] });
  const reply = await wire('/graphql/schema', token, undefined, { 'x-hadron-session': a.id }, 'GET');
  expect(reply.status).toBe(409); expect(await reply.json()).toMatchObject({ code: 'SESSION_SUPERSEDED' });
});
