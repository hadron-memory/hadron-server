import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1012 — the `X-Hadron-Client-Id` header, over the REAL HTTP boundary.
 *
 * Deliberately separate from `server.sessionStatePersistence.test.ts`, which
 * passes `clientKey` straight into the testable server. Those tests prove the
 * store and its re-authorization behave; they say nothing about whether the
 * header is ever READ, or whether a restored selection actually reaches
 * `auth.appId` before the first tool call.
 *
 * That distinction is not hypothetical: PR #1011's reconnect detection shipped
 * inert for exactly this reason — its unit tests injected the flag instead of
 * going through the boundary, so they proved the message rendered and never
 * that the detection fired. This suite exists so #1012 cannot repeat it.
 *
 * Runs against the real Express app and SDK transport, like the revival suite.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey } from '../middleware/auth.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

let org: { id: string; urn: string };
let user: { id: string };
let appA: { id: string; urn: string };
let rawKey: string;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().slice(-8);
  org = await db.organization.create({
    data: { id: generateId(), name: 'ck-org', urn: `ck-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 97910, githubUsername: `ck-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
  });
  appA = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'App A', urn: `${org.urn}:app-a` },
  });
  // A second App the user is ALSO a member of. Membership is what makes them
  // multi-App (`resolveUserApps` counts AppMember rows, not Apps), and only
  // then is App scope genuinely ambiguous without a selection — which is what
  // makes a restore observable at all.
  const appB = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'App B', urn: `${org.urn}:app-b` },
  });
  await db.appMember.create({ data: { appId: appA.id, userId: user.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: appB.id, userId: user.id, role: 'owner' } });

  // One distinctly-named worker per App, so a roster read names which App
  // actually resolved rather than leaving it to be inferred.
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:backend`,
      name: 'Backend',
      visibility: 'ORGANIZATION',
    },
  });
  await db.appAgent.create({ data: { appId: appA.id, agentId: agent.id } });
  await db.appAgent.create({ data: { appId: appB.id, agentId: agent.id } });
  await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: appA.id, agentId: agent.id, name: 'WorkerInAppA', slug: 'worker-in-app-a' },
  });
  await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: appB.id, agentId: agent.id, name: 'WorkerInAppB', slug: 'worker-in-app-b' },
  });
  ({ rawKey } = await mintUserApiKey(db, {
    userId: user.id,
    label: 'test',
    createdBy: user.id,
    issuedVia: 'test',
  }));
});

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

const callBody = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: args },
});

function mcpFetch(opts: {
  body: unknown;
  sessionId?: string;
  clientId?: string;
}): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    authorization: `Bearer ${rawKey}`,
  };
  if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId;
  if (opts.clientId) headers['x-hadron-client-id'] = opts.clientId;
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
}

/**
 * Issue a tool call and CONSUME the response body.
 *
 * Consuming is load-bearing, not tidiness: the transport streams its reply, so
 * an un-read body means the handler may not have finished when the next
 * statement runs — and these tests assert on writes the handler performs. A
 * dropped body made the precedence test below flake as a phantom product bug.
 */
async function callAndRead(opts: {
  sessionId: string;
  clientId?: string;
  body: unknown;
}): Promise<string> {
  const res = await mcpFetch(opts);
  return res.text();
}

/** Open a session as this client instance, returning its MCP session id. */
async function connect(clientId?: string): Promise<string> {
  const res = await mcpFetch({ body: initializeBody, clientId });
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  return sid!;
}

describe('#1012 — X-Hadron-Client-Id over the real boundary', () => {
  it('a selection made on one connection is live on the NEXT one', async () => {
    const clientId = 'desktop-instance-1';

    // Connection 1: select an App. Multi-App, so nothing was scoped before.
    const first = await connect(clientId);
    const set = await mcpFetch({
      sessionId: first,
      clientId,
      body: callBody('hadron_set_active_app', { app: appA.urn }),
    });
    expect(await set.text()).toContain('Active App set to');

    // Connection 2 — a brand-new MCP session, as a reconnect produces. The
    // header is the ONLY thing carrying identity across it.
    const second = await connect(clientId);
    const read = await mcpFetch({
      sessionId: second,
      clientId,
      body: callBody('hadron_team_chat_read', { sinceSeq: 0 }),
    });
    const text = await read.text();
    expect(text).not.toContain('multiple_apps_resolved');
    expect(text).not.toContain('No App context');
  });

  it('a connection sending NO header gets none of it back', async () => {
    const clientId = 'desktop-instance-1';
    const first = await connect(clientId);
    await callAndRead({
      sessionId: first,
      clientId,
      body: callBody('hadron_set_active_app', { app: appA.urn }),
    });

    // Same user, no client id — the pre-#1012 behaviour, unchanged.
    const anon = await connect();
    const read = await mcpFetch({
      sessionId: anon,
      body: callBody('hadron_team_chat_read', { sinceSeq: 0 }),
    });
    expect(await read.text()).toContain('multiple_apps_resolved');
  });

  it("a DIFFERENT client instance does not inherit the selection", async () => {
    // The multi-client guarantee, end to end: switching App in one client must
    // not reach into another. A per-user key would fail this.
    const first = await connect('desktop-instance-1');
    await callAndRead({
      sessionId: first,
      clientId: 'desktop-instance-1',
      body: callBody('hadron_set_active_app', { app: appA.urn }),
    });

    const other = await connect('cursor-instance-1');
    const read = await mcpFetch({
      sessionId: other,
      clientId: 'cursor-instance-1',
      body: callBody('hadron_team_chat_read', { sinceSeq: 0 }),
    });
    expect(await read.text()).toContain('multiple_apps_resolved');
  });

  it('an explicit selection OUTRANKS the single-App default (Codex P1 on PR #1013)', async () => {
    // A user picks App A while a member of both. Membership in A is later
    // dropped, but they remain a valid participant through org CONTRIBUTOR —
    // so `resolveAppForRequest` now sees exactly one AppMember row (App B) and
    // resolves B as "their only App". Taking that over the choice they actually
    // made would silently retarget the next App-scoped write.
    const clientId = 'desktop-instance-1';
    const first = await connect(clientId);
    await callAndRead({
      sessionId: first,
      clientId,
      body: callBody('hadron_set_active_app', { app: appA.urn }),
    });

    await db.appMember.delete({ where: { appId_userId: { appId: appA.id, userId: user.id } } });
    // Sanity: they are now single-App by membership, and it is NOT App A.
    const remaining = await db.appMember.findMany({ where: { userId: user.id } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].appId).not.toBe(appA.id);

    // The reconnect resolves B by default, but A is still authorized via the
    // org branch of isAppParticipant, so the stored choice must win.
    const second = await connect(clientId);
    const info = await mcpFetch({
      sessionId: second,
      clientId,
      body: callBody('hadron_list_workers', {}),
    });
    const text = await info.text();
    // Each App has one distinctly-named worker, so the roster names which App
    // actually resolved — no inference required.
    expect(text).toContain('WorkerInAppA');
    expect(text).not.toContain('WorkerInAppB');
  });

  it('advertises the capability so a client can tell whether to send the header', async () => {
    const sid = await connect('desktop-instance-1');
    const info = await mcpFetch({
      sessionId: sid,
      clientId: 'desktop-instance-1',
      body: callBody('hadron_server_info'),
    });
    expect(await info.text()).toContain('client-session-state');
  });
});
