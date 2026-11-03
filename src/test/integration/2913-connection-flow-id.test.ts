/**
 * #2913 — `startConnection` returns a flow id, and `connectionFlow(flowId)` says where that flow is: PENDING, the
 * connection id it made (the existing row on a reconnect), or the failure code it ended with. Readable only by the
 * user who started the flow, for 1 hour from the start; an unknown, expired or another user's id gets ONE refusal.
 * Reading writes nothing. Spec: cor:dmo:080:04 "Finding the connection a flow made" (ruling 0008 A, V12).
 *
 * Real Express app over HTTP, real database; the provider tool (emailClient) is mocked and the callback is driven
 * with a fabricated `code`, as in the #2897 suite.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';

vi.mock('../../lib/emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/emailClient.js')>()),
  createToolConnection: vi.fn(),
  deleteToolConnection: vi.fn(async () => {}),
  subscribeToolFolder: vi.fn(async () => ({})),
}));

import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { confirmConnect } from '../connectInterstitial.js';
import { signJwt } from '../../auth/index.js';
import { createToolConnection } from '../../lib/emailClient.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { runAsActor } from '../../lib/requestActor.js';
import { generateId } from '../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';

let server: Server | undefined;
let baseUrl: string;
let adminId: string;
let otherAdminId: string;
let orgId: string;
let savedBase: string | undefined;
let savedGmail: string | undefined;

beforeAll(async () => {
  savedBase = process.env.BASE_URL;
  savedGmail = process.env.GMAIL_CLIENT_ID;
  await cleanDb(db);
  const app = await createServer();
  const listening = createHttpServer(app);
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
  process.env.BASE_URL = baseUrl;
});

afterAll(async () => {
  try {
    const listening = server;
    if (listening) await new Promise<void>((resolve, reject) => listening.close((err) => (err ? reject(err) : resolve())));
  } finally {
    if (savedBase === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = savedBase;
    if (savedGmail === undefined) delete process.env.GMAIL_CLIENT_ID;
    else process.env.GMAIL_CLIENT_ID = savedGmail;
    await cleanDb(db);
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  process.env.GMAIL_CLIENT_ID = 'gmail-client-id.apps.googleusercontent.example';
  const admin = await db.user.create({ data: { githubId: 291301, githubUsername: 'flow-admin', roles: ['READER'] } });
  const other = await db.user.create({ data: { githubId: 291302, githubUsername: 'flow-other-admin', roles: ['READER'] } });
  adminId = admin.id;
  otherAdminId = other.id;
  const org = await db.organization.create({ data: { name: 'Flow Org', urn: 'flow-org' } });
  orgId = org.id;
  await db.orgMember.createMany({
    data: [
      { organizationId: orgId, userId: adminId, role: 'ADMIN' },
      { organizationId: orgId, userId: otherAdminId, role: 'ADMIN' },
    ],
  });
});

type GqlResult = {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

async function gql(query: string, userId: string | null): Promise<GqlResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (userId) headers.authorization = `Bearer ${await signJwt({ sub: userId, roles: ['READER'] })}`;
  const res = await fetch(`${baseUrl}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query }) });
  return (await res.json()) as GqlResult;
}

const START = `mutation { startConnection(provider: GMAIL, orgRef: "flow-org") { flowId authorizeUrl expiresAt } }`;
const FLOW = (id: string) =>
  `query { connectionFlow(flowId: "${id}") { status connectionId failureCode } }`;

async function start(userId = adminId) {
  const r = await gql(START, userId);
  expect(r.errors).toBeUndefined();
  return r.data!.startConnection as { flowId: string; authorizeUrl: string };
}

function mockTool(mailboxEmail: string, id: string) {
  vi.mocked(createToolConnection).mockResolvedValueOnce({
    id,
    provider: 'gmail',
    mailboxEmail,
    displayName: mailboxEmail,
  } as Awaited<ReturnType<typeof createToolConnection>>);
}

async function consentAndCallback(authorizeUrl: string, query = 'code=c1') {
  const res = await confirmConnect(authorizeUrl);
  expect(res.status).toBe(302);
  const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
  return fetch(`${baseUrl}/auth/gmail/callback?${query}&state=${state}`, { redirect: 'manual' });
}

describe('#2913 connectionFlow', () => {
  it('startConnection returns a flow id', async () => {
    const s = await start();
    expect(s.flowId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('A4: a flow that has not completed reports PENDING, not an error', async () => {
    const s = await start();
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.errors).toBeUndefined();
    expect(r.data!.connectionFlow).toEqual({ status: 'PENDING', connectionId: null, failureCode: null });
  });

  it('a flow whose browser step was opened but not finished is still PENDING', async () => {
    const s = await start();
    expect((await confirmConnect(s.authorizeUrl)).status).toBe(302);
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.data!.connectionFlow.status).toBe('PENDING');
  });

  it('a completed flow resolves to the connection it created', async () => {
    const s = await start();
    mockTool('a@flow.example', 'tool-a');
    expect((await consentAndCallback(s.authorizeUrl)).status).toBe(200);
    const row = await db.exchangeConnection.findFirstOrThrow({ where: { mailboxEmail: 'a@flow.example' } });
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.data!.connectionFlow).toEqual({ status: 'CONNECTED', connectionId: row.id, failureCode: null });
  });

  it('A1: two flows by one caller for one provider each resolve to their own connection', async () => {
    const f1 = await start();
    const f2 = await start();
    expect(f1.flowId).not.toBe(f2.flowId);
    // Complete the SECOND flow first, with the other mailbox, so an order-based or latest-row lookup fails.
    mockTool('second@flow.example', 'tool-2');
    await consentAndCallback(f2.authorizeUrl);
    mockTool('first@flow.example', 'tool-1');
    await consentAndCallback(f1.authorizeUrl);
    const first = await db.exchangeConnection.findFirstOrThrow({ where: { mailboxEmail: 'first@flow.example' } });
    const second = await db.exchangeConnection.findFirstOrThrow({ where: { mailboxEmail: 'second@flow.example' } });
    const r1 = await gql(FLOW(f1.flowId), adminId);
    const r2 = await gql(FLOW(f2.flowId), adminId);
    expect(r1.data!.connectionFlow.connectionId).toBe(first.id);
    expect(r2.data!.connectionFlow.connectionId).toBe(second.id);
  });

  it('A2: a reconnect resolves to the EXISTING connection id, never a new one', async () => {
    const existing = await db.exchangeConnection.create({
      data: {
        organizationId: orgId, userId: adminId, mailboxEmail: 'again@flow.example', provider: 'gmail',
        toolConnectionId: 'tool-old', syncStatus: 'OK',
      },
    });
    const s = await start(otherAdminId);
    mockTool('again@flow.example', 'tool-new');
    await consentAndCallback(s.authorizeUrl);
    expect(await db.exchangeConnection.count({ where: { mailboxEmail: 'again@flow.example' } })).toBe(1);
    const r = await gql(FLOW(s.flowId), otherAdminId);
    expect(r.data!.connectionFlow).toEqual({ status: 'CONNECTED', connectionId: existing.id, failureCode: null });
  });

  it('a flow that ended without a connection reports FAILED with the stable code the done page shows', async () => {
    const s = await start();
    const res = await consentAndCallback(s.authorizeUrl, 'error=access_denied');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('access_denied');
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.data!.connectionFlow).toEqual({ status: 'FAILED', connectionId: null, failureCode: 'access_denied' });
  });

  it('a flow whose tool call failed reports FAILED connection_failed', async () => {
    const s = await start();
    vi.mocked(createToolConnection).mockRejectedValueOnce(new Error('tool down'));
    await consentAndCallback(s.authorizeUrl);
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.data!.connectionFlow).toEqual({ status: 'FAILED', connectionId: null, failureCode: 'connection_failed' });
  });

  it('a callback that arrives after its state expired settles the flow FAILED state_expired (not left PENDING)', async () => {
    const s = await start();
    const res = await confirmConnect(s.authorizeUrl);
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 11 * 60 * 1000);
    try {
      const cb = await fetch(`${baseUrl}/auth/gmail/callback?code=c1&state=${state}`, { redirect: 'manual' });
      expect(cb.status).toBe(400);
    } finally {
      spy.mockRestore();
    }
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.data!.connectionFlow).toEqual({ status: 'FAILED', connectionId: null, failureCode: 'state_expired' });
  });

  it('a callback for an unknown state still answers 400 and settles nothing', async () => {
    const s = await start();
    const cb = await fetch(`${baseUrl}/auth/gmail/callback?code=c1&state=nope`, { redirect: 'manual' });
    expect(cb.status).toBe(400);
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.data!.connectionFlow.status).toBe('PENDING');
  });

  it('a settle that cannot be written never leaves a recorded connection behind a PENDING flow', async () => {
    const s = await start();
    mockTool('settle-fail@example.com', 'tool-settle-fail');
    // Only a CONNECTED settle violates this, so the failure settle that follows can still be written.
    await db.$executeRawUnsafe('ALTER TABLE connection_flows ADD CONSTRAINT t_no_connected CHECK (connection_id IS NULL)');
    try {
      await consentAndCallback(s.authorizeUrl);
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE connection_flows DROP CONSTRAINT t_no_connected');
    }
    expect(await db.exchangeConnection.count({ where: { mailboxEmail: 'settle-fail@example.com' } })).toBe(0);
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.data!.connectionFlow).toEqual({ status: 'FAILED', connectionId: null, failureCode: 'connection_failed' });
  });

  it('a failure settle that fails once is retried, so the flow does not stay PENDING', async () => {
    const s = await start();
    const spy = vi.spyOn(db.connectionFlow, 'updateMany').mockRejectedValueOnce(new Error('blip'));
    try {
      await consentAndCallback(s.authorizeUrl, 'error=access_denied');
    } finally {
      spy.mockRestore();
    }
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.data!.connectionFlow).toEqual({ status: 'FAILED', connectionId: null, failureCode: 'access_denied' });
  });

  it('a settled flow never changes again (a replayed callback cannot rewrite it)', async () => {
    const s = await start();
    mockTool('once@flow.example', 'tool-once');
    const res = await confirmConnect(s.authorizeUrl);
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    await fetch(`${baseUrl}/auth/gmail/callback?code=c&state=${state}`, { redirect: 'manual' });
    await fetch(`${baseUrl}/auth/gmail/callback?error=access_denied&state=${state}`, { redirect: 'manual' });
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.data!.connectionFlow.status).toBe('CONNECTED');
  });

  it('A3: an unknown id, an expired flow and another user\'s flow (even another ADMIN of the org) get one identical refusal', async () => {
    const s = await start();
    const old = await start();
    await db.$executeRaw`UPDATE connection_flows SET started_at = started_at - interval '61 minutes' WHERE id = ${old.flowId}`;
    const unknown = await gql(FLOW('f'.repeat(32)), adminId);
    const foreign = await gql(FLOW(s.flowId), otherAdminId);
    const expired = await gql(FLOW(old.flowId), adminId);
    for (const r of [unknown, foreign, expired]) {
      expect(r.data).toBeNull();
      expect(r.errors).toHaveLength(1);
    }
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown));
    expect(JSON.stringify(expired)).toBe(JSON.stringify(unknown));
    // The refusal is the platform's one authorization denial, not a distinct "flow" code.
    expect(unknown.errors![0].extensions?.code).toBe('FORBIDDEN');
  });

  it('a flow inside its hour still resolves; the hour, not the 2-minute link, bounds it', async () => {
    const s = await start();
    await db.$executeRaw`UPDATE connection_flows SET started_at = started_at - interval '59 minutes' WHERE id = ${s.flowId}`;
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.errors).toBeUndefined();
    expect(r.data!.connectionFlow.status).toBe('PENDING');
  });

  it('a settled flow past its hour is refused like an unknown id', async () => {
    const s = await start();
    mockTool('late@flow.example', 'tool-late');
    await consentAndCallback(s.authorizeUrl);
    await db.$executeRaw`UPDATE connection_flows SET started_at = started_at - interval '61 minutes' WHERE id = ${s.flowId}`;
    const late = await gql(FLOW(s.flowId), adminId);
    const unknown = await gql(FLOW('e'.repeat(32)), adminId);
    expect(JSON.stringify(late)).toBe(JSON.stringify(unknown));
  });

  it('reading a flow writes nothing', async () => {
    const s = await start();
    const before = await db.$queryRaw`SELECT * FROM connection_flows ORDER BY id`;
    const handoff = await db.authHandoffCode.count();
    await gql(FLOW(s.flowId), adminId);
    await gql(FLOW(s.flowId), otherAdminId);
    await gql(FLOW('0'.repeat(32)), adminId);
    expect(await db.$queryRaw`SELECT * FROM connection_flows ORDER BY id`).toEqual(before);
    expect(await db.authHandoffCode.count()).toBe(handoff);
  });

  it('an unauthenticated caller is refused UNAUTHENTICATED (no flow lookup)', async () => {
    const s = await start();
    const r = await gql(FLOW(s.flowId), null);
    expect(r.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('a user who lost org ADMIN after starting still reads their own flow (the flow is theirs, not the org\'s)', async () => {
    const s = await start();
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: adminId }, data: { role: 'CONTRIBUTOR' } });
    const r = await gql(FLOW(s.flowId), adminId);
    expect(r.errors).toBeUndefined();
  });

  it('a REST/portal-started flow has no flow id and no flow row', async () => {
    const { issueConnectStart, getConnectProvider } = await import('../../integrations/mailboxConnect.js');
    const cfg = getConnectProvider('gmail')!;
    await issueConnectStart(cfg, { userId: adminId, roles: ['READER'], orgId, redirect: '/', origin: 'portal' });
    expect(await db.$queryRaw`SELECT id FROM connection_flows`).toEqual([]);
  });
});

describe('#2913 connectionFlow: credentials that may never read a flow (resolver level)', () => {
  const apollo = new ApolloServer<Context>({ typeDefs, resolvers });
  async function run(ctx: Partial<Context>, flowId: string, fn?: <T>(f: () => Promise<T>) => Promise<T>) {
    const exec = () => apollo.executeOperation({ query: FLOW(flowId) }, { contextValue: { db, ...ctx } as Context });
    const res = await (fn ? fn(exec) : exec());
    if (res.body.kind !== 'single') throw new Error('unexpected');
    return res.body.singleResult;
  }
  const codes = (r: Awaited<ReturnType<typeof run>>) => r.errors?.map((e) => e.extensions?.code);

  it('every one of these is refused although the flow is the admin\'s own and live', async () => {
    const { flowId } = await start();
    expect(codes(await run({ userId: adminId, roles: ['READER'] }, flowId))).toBeUndefined();
    // An impersonated request carrying the starter's userId.
    expect(
      codes(
        await run(
          { userId: adminId, roles: [], impersonation: { sessionId: 's', actorUserId: otherAdminId, orgId, expiresAt: new Date(Date.now() + 60_000) } },
          flowId,
        ),
      ),
    ).toEqual(['FORBIDDEN']);
    // An App run on behalf of the starter.
    expect(codes(await run({ appId: 'app-1', userId: adminId, roles: ['READER'] }, flowId))).toEqual(['FORBIDDEN']);
    // A bound worker session for the starter.
    expect(
      codes(
        await run({ userId: adminId, roles: ['READER'] }, flowId, (f) =>
          runAsActor({ workerId: 'worker-1', agentId: null, userId: adminId }, f),
        ),
      ),
    ).toEqual(['FORBIDDEN']);
    // An OAuth credential limited to the MCP surface.
    expect(codes(await run({ userId: adminId, roles: ['READER'], oauthScopes: ['mcp'] }, flowId))).toEqual(['FORBIDDEN']);
    // An App key with no user.
    expect(codes(await run({ appId: 'app-1', roles: [] }, flowId))).toEqual(['UNAUTHENTICATED']);
  });

  it('a worker-bound session found only on the session row is refused the read and the start', async () => {
    const { flowId } = await start();
    const app = await db.app.create({ data: { organizationId: orgId, name: 'Flow App', urn: 'flow-org:app' } });
    const agent = await db.agent.create({ data: { organizationId: orgId, name: 'Flow Agent', urn: 'flow-org:agent' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Flow Worker', slug: 'flow-worker', heldByUserId: adminId } });
    const workerSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, workerId: worker.id, userId: adminId, tool: 'vitest' } });
    const personSession = await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, userId: adminId, tool: 'vitest' } });
    expect(codes(await run({ userId: adminId, roles: ['READER'], sessionId: workerSession.id }, flowId))).toEqual(['FORBIDDEN']);
    // A session with no worker is still a person.
    expect(codes(await run({ userId: adminId, roles: ['READER'], sessionId: personSession.id }, flowId))).toBeUndefined();
    const startRes = await apollo.executeOperation({ query: START }, { contextValue: { db, userId: adminId, roles: ['READER'], sessionId: workerSession.id } as Context });
    if (startRes.body.kind !== 'single') throw new Error('unexpected');
    expect(startRes.body.singleResult.errors?.map((e) => e.extensions?.code)).toEqual(['FORBIDDEN']);
  });
});
