/** #1597: no-App name discovery is bounded by existing bind authority, never a fallback for ID/URN. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { composeWorkerUrn } from '../lib/entityRef/workerRef.js';
import { createServer } from '../server.js';
import { signJwt } from '../auth/jwt.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation as any;
let server: Server;
let url: URL;
const clients: Client[] = [];
let user: { id: string; githubId: number; githubUsername: string };
let other: { id: string };
let appA: { id: string; urn: string; name: string };
let appB: typeof appA;
let hiddenApp: typeof appA;
let agentId: string;
const ctx = (appId?: string): Context => ({ db, userId: user.id, appId, roles: ['READER'] });
const start = (workerRef: string, c: Context = ctx(), extra = {}) =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', workerRef, ...extra } }, c);
async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError; }
  throw new Error('expected refusal');
}
async function worker(app: typeof appA, name = 'Iris', extra = {}) {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name,
    slug: `w-${generateId().slice(-8)}`, role: 'server-engineer', ...extra } });
  return { ...w, urn: composeWorkerUrn(app.urn, w.slug) };
}
beforeAll(async () => {
  server = httpServer(await createServer());
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>(r => server.close(() => r()));
});
afterEach(async () => { for (const c of clients.splice(0)) await c.close(); vi.restoreAllMocks(); });
beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  user = await db.user.create({ data: { githubId: 1597001, githubUsername: `driver-${suffix}`, roles: ['READER'] } });
  other = await db.user.create({ data: { githubId: 1597002, githubUsername: `holder-${suffix}`, handle: `holder-${suffix}`, roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Allowed', urn: `allowed-${suffix}.example` } });
  const foreign = await db.organization.create({ data: { name: 'Hidden', urn: `hidden-${suffix}.example` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' } });
  agentId = (await db.agent.create({ data: { organizationId: org.id, name: 'Builder', urn: `${org.urn}:builder`,
    systemPrompt: 'Work as {{name}}.', personaRole: 'server-engineer', visibility: 'ORGANIZATION' } })).id;
  appA = await db.app.create({ data: { organizationId: org.id, name: 'Alpha', urn: `${org.urn}:alpha` } });
  appB = await db.app.create({ data: { organizationId: org.id, name: 'Beta', urn: `${org.urn}:beta` } });
  hiddenApp = await db.app.create({ data: { organizationId: foreign.id, name: 'Hidden app', urn: `${foreign.urn}:hidden` } });
  await db.appAgent.createMany({ data: [appA, appB, hiddenApp].map(a => ({ appId: a.id, agentId })) });
});
async function mcp() {
  const token = await signJwt({ sub: user.id, githubId: user.githubId, githubUsername: user.githubUsername, roles: ['READER'] });
  const c = new Client({ name: 'cross-app1597', version: '1' }); clients.push(c);
  await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
function text(result: any): string { return result.content.filter((v: any) => v.type === 'text').map((v: any) => v.text).join('\n'); }

describe('cross-App bare-name bind (#1597)', () => {
  it('binds the unique authorized match using DB case comparison', async () => {
    const w = await worker(appA, 'Iris_%');
    await worker(appB, 'IrisXY');
    const session = await start('  iRiS_%  ');
    expect(session).toMatchObject({ workerId: w.id, appId: appA.id, agentId, userId: user.id });
    expect((await db.worker.findUniqueOrThrow({ where: { id: w.id } })).heldByUserId).toBe(user.id);
  });
  it('refuses ambiguity with both authorized identities and no session or hold writes', async () => {
    const a = await worker(appA, 'Iris'); const b = await worker(appB, 'IRIS', { heldByUserId: other.id, heldAt: new Date() });
    const before = await db.session.count();
    const e = await refusal(start('iris'));
    expect(e.extensions.code).toBe('SESSION_WORKER_NAME_AMBIGUOUS');
    expect(e.extensions.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: a.id, name: a.name, urn: a.urn, role: 'server-engineer', app: expect.objectContaining({ id: appA.id, urn: appA.urn }), holder: null }),
      expect.objectContaining({ id: b.id, name: b.name, app: expect.objectContaining({ id: appB.id }), holder: expect.objectContaining({ id: other.id }) }),
    ]));
    expect(e.extensions.candidates).toHaveLength(2);
    expect(await db.session.count()).toBe(before);
    expect((await db.worker.findUniqueOrThrow({ where: { id: a.id } })).heldByUserId).toBeNull();
  });
  it('hidden same-name workers neither create ambiguity nor appear in refusal', async () => {
    const hidden = await worker(hiddenApp); const a = await worker(appA);
    expect((await start('Iris')).workerId).toBe(a.id);
    await worker(appB);
    const e = await refusal(start('Iris'));
    expect(e.extensions.candidates).toHaveLength(2);
    expect(JSON.stringify(e.extensions)).not.toContain(hidden.id);
    expect(e.message).not.toContain(hiddenApp.urn);
  });
  it('hidden-only and absent names have identical refusal envelopes', async () => {
    const w = await worker(hiddenApp);
    const first = await refusal(start('Iris'));
    await db.worker.delete({ where: { id: w.id } });
    const second = await refusal(start('Iris'));
    expect({ message: first.message, extensions: first.extensions }).toEqual({ message: second.message, extensions: second.extensions });
    expect(first.extensions.code).toBe('WORKER_NOT_FOUND');
  });
  it('excludes retired workers and dead Apps before choosing the match', async () => {
    await worker(appB, 'Iris', { retiredAt: new Date() }); const a = await worker(appA);
    expect((await start('Iris')).workerId).toBe(a.id);
    await db.worker.updateMany({ where: { appId: appB.id }, data: { retiredAt: null } });
    await db.app.update({ where: { id: appB.id }, data: { uninstalledAt: new Date() } });
    expect((await start('Iris', ctx(), { force: true })).workerId).toBe(a.id);
    await db.app.update({ where: { id: appB.id }, data: { uninstalledAt: null, deletedAt: new Date() } });
    expect((await start('Iris', ctx(), { force: true })).workerId).toBe(a.id);
  });
  it('keeps selected-App name lookup authoritative without cross-App fallback', async () => {
    const b = await worker(appB);
    expect((await refusal(start('Iris', ctx(appA.id)))).extensions.code).toBe('WORKER_NOT_FOUND');
    expect((await start('Iris', ctx(appB.id))).workerId).toBe(b.id);
  });
  it('preserves shape dispatch and the unique-match hold refusal', async () => {
    await worker(appA, 'hrn:worker:malformed');
    expect((await refusal(start('hrn:worker:malformed'))).extensions.code).toBe('WORKER_NOT_FOUND');
    await worker(appA, 'Iris', { heldByUserId: other.id, heldAt: new Date() });
    expect((await refusal(start('Iris'))).extensions.code).toBe('WORKER_HELD');
  });
  it('does not discover workers for a caller without a user or App credential', async () => {
    await worker(appA);
    expect((await refusal(start('Iris', { db, roles: ['READER'] } as Context))).extensions.code).toBe('WORKER_NOT_FOUND');
  });
  it('does not choose an unheld user-owned worker for an ordinary App member', async () => {
    const own = await db.app.create({ data: { ownerUserId: other.id, name: 'Solo', urn: `solo-${generateId()}:team` } });
    await db.appMember.create({ data: { appId: own.id, userId: user.id, role: 'member' } });
    await worker(own); const a = await worker(appA);
    expect((await start('Iris')).workerId).toBe(a.id);
  });
  it('actual MCP transport binds a unique name without selected App and returns briefing', async () => {
    const w = await worker(appA); await worker(hiddenApp);
    const c = await mcp();
    const out = text(await c.callTool({ name: 'hadron_start_session', arguments: { description: 'build safely', workerRef: 'Iris', llmModel: 'test' } }));
    expect(out).toContain('Session started:'); expect(out).toContain(w.urn); expect(out).toContain('Boot briefing');
    expect(await db.session.count({ where: { workerId: w.id } })).toBe(1);
    const workerRead = text(await c.callTool({ name: 'hadron_get_worker', arguments: { workerRef: 'Iris' } }));
    expect(workerRead).toContain(w.id); // successful bind pins its App on this connection
  });
  it('actual MCP ambiguity lists both candidates and binds nothing', async () => {
    const a = await worker(appA); const b = await worker(appB); const hidden = await worker(hiddenApp);
    const c = await mcp();
    const out = text(await c.callTool({ name: 'hadron_start_session', arguments: { description: 'no guess', workerRef: 'Iris' } }));
    expect(out).toContain('ambiguous'); expect(out).toContain(a.urn); expect(out).toContain(b.urn);
    expect(out).not.toContain(hidden.urn); expect(await db.session.count()).toBe(0);
  });
});
