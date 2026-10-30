/**
 * #2897 — start an org connection's OAuth flow through GraphQL (`startConnection`), so the CLI can connect a
 * mailbox, calendar or Drive without the portal (cor:api:240:02).
 *
 * The mutation and `POST /auth/{provider}/start` share ONE start (`issueConnectStart`): the same configured check,
 * the same org-ADMIN gate (#506) and the same single-use, provider-bound nonce. A flow started from GraphQL ends on
 * a server-hosted done page instead of the portal; a flow started from REST still redirects to the portal.
 *
 * Real Express app over HTTP, real database. The provider tool (emailClient) is mocked: the consent step at the
 * provider is not exercisable here, so the callback is driven with a fabricated `code`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { ApolloServer } from '@apollo/server';

vi.mock('../../lib/emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/emailClient.js')>()),
  createToolConnection: vi.fn(async () => ({
    id: 'tool-conn-2897',
    provider: 'gmail',
    mailboxEmail: 'owner@connect.example',
    displayName: 'Owner',
  })),
  deleteToolConnection: vi.fn(async () => {}),
  subscribeToolFolder: vi.fn(async () => ({})),
}));

import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { confirmConnect } from '../connectInterstitial.js';
import { generateId } from '../../lib/id.js';
import { signJwt } from '../../auth/index.js';
import { createToolConnection } from '../../lib/emailClient.js';
import { runAsActor } from '../../lib/requestActor.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

/** Env vars this suite sets; each is put back to what it was, not deleted. */
const ENV_KEYS = ['BASE_URL', 'GMAIL_CLIENT_ID', 'MICROSOFT_CLIENT_ID', 'GOOGLE_CAL_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

let server: Server;
let baseUrl: string;
let adminId: string;
let memberId: string;
let orgId: string;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The authorize URL is built from BASE_URL; point it at this server so the test can follow it.
  process.env.BASE_URL = baseUrl;
});

afterAll(async () => {
  restoreEnv();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  process.env.GMAIL_CLIENT_ID = 'gmail-client-id.apps.googleusercontent.example';
  const admin = await db.user.create({ data: { githubId: 289701, githubUsername: 'start-admin', roles: ['READER'] } });
  const member = await db.user.create({ data: { githubId: 289702, githubUsername: 'start-member', roles: ['READER'] } });
  adminId = admin.id;
  memberId = member.id;
  const org = await db.organization.create({ data: { name: 'Connect <Org> & Co', urn: 'connect-org' } });
  orgId = org.id;
  await db.orgMember.createMany({
    data: [
      { organizationId: orgId, userId: adminId, role: 'ADMIN' },
      { organizationId: orgId, userId: memberId, role: 'CONTRIBUTOR' },
    ],
  });
});

afterEach(() => {
  // Back to the values the suite started with, then the per-test default is re-set by beforeEach.
  const base = process.env.BASE_URL;
  restoreEnv();
  process.env.BASE_URL = base;
});

const START = (provider: string, orgRef: string) =>
  `mutation { startConnection(provider: ${provider}, orgRef: "${orgRef}") { provider orgId authorizeUrl expiresAt } }`;

async function gql(query: string, userId: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (userId) headers.authorization = `Bearer ${await signJwt({ sub: userId, roles: ['READER'] })}`;
  const res = await fetch(`${baseUrl}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query }) });
  return (await res.json()) as {
    data?: { startConnection?: { provider: string; orgId: string; authorizeUrl: string; expiresAt: string } | null };
    errors?: { message: string; extensions?: { code?: string } }[];
  };
}

const code = (r: Awaited<ReturnType<typeof gql>>) => r.errors?.map((e) => e.extensions?.code);
const nonceOf = (url: string) => new URL(url).searchParams.get('nonce')!;
const rows = () => db.authHandoffCode.findMany({ where: { kind: { startsWith: 'exchange_start' } } });

async function startAsAdmin() {
  const r = await gql(START('GMAIL', orgId), adminId);
  expect(r.errors).toBeUndefined();
  return r.data!.startConnection!;
}

/** Redeem the nonce at the browser leg and return the `state` the provider would echo back. */
async function consent(authorizeUrl: string): Promise<string> {
  const res = await confirmConnect(authorizeUrl);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!).searchParams.get('state')!;
}

describe('startConnection: the happy path and its single-use points', () => {
  it('returns the server authorize URL carrying a fresh nonce for an org ADMIN', async () => {
    const start = await startAsAdmin();
    expect(start.provider).toBe('GMAIL');
    expect(start.orgId).toBe(orgId);
    const url = new URL(start.authorizeUrl);
    expect(url.pathname).toBe('/auth/gmail');
    expect(nonceOf(start.authorizeUrl)).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(start.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it.each([
    ['MS_EXCHANGE', 'microsoft', 'ms-exchange', 'MICROSOFT_CLIENT_ID'],
    ['GMAIL', 'gmail', 'gmail', 'GMAIL_CLIENT_ID'],
    ['GOOGLE_CAL', 'google-cal', 'google-cal', 'GOOGLE_CAL_CLIENT_ID'],
    ['GOOGLE_DRIVE', 'google-drive', 'google-drive', 'GOOGLE_DRIVE_CLIENT_ID'],
  ])('%s starts at /auth/%s with a nonce bound to provider %s', async (enumValue, route, provider, envKey) => {
    process.env[envKey] = 'client-id.example';
    const r = await gql(START(enumValue, orgId), adminId);
    expect(r.errors).toBeUndefined();
    const start = r.data!.startConnection!;
    expect(start.provider).toBe(enumValue);
    expect(new URL(start.authorizeUrl).pathname).toBe(`/auth/${route}`);
    const row = await db.authHandoffCode.findFirstOrThrow({ where: { kind: { startsWith: 'exchange_start' } } });
    expect(row.kind).toBe(`exchange_start:${provider}:graphql`);
    // The nonce works at that route and nowhere else: the browser leg answers a redirect, not 400/503.
    expect((await confirmConnect(start.authorizeUrl)).status).toBe(302);
  });

  it('single-use point 1: the nonce redeems once at GET /auth/{provider}, a second redemption is refused', async () => {
    const { authorizeUrl } = await startAsAdmin();
    await consent(authorizeUrl);
    const again = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(again.status).toBe(400);
  });

  it('single-use point 2: the pending state is consumed once at the callback, a replayed state is refused', async () => {
    const { authorizeUrl } = await startAsAdmin();
    const state = await consent(authorizeUrl);
    const first = await fetch(`${baseUrl}/auth/gmail/callback?code=c1&state=${state}`, { redirect: 'manual' });
    expect(first.status).toBe(200);
    const replay = await fetch(`${baseUrl}/auth/gmail/callback?code=c1&state=${state}`, { redirect: 'manual' });
    expect(replay.status).toBe(400);
    expect(vi.mocked(createToolConnection)).toHaveBeenCalledTimes(1);
  });

  it('a nonce minted for one provider does not redeem at another provider', async () => {
    process.env.MICROSOFT_CLIENT_ID = 'ms-client-id';
    const { authorizeUrl } = await startAsAdmin();
    const res = await fetch(`${baseUrl}/auth/microsoft?nonce=${nonceOf(authorizeUrl)}`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    // ...and it is still good at the provider it was minted for.
    expect((await confirmConnect(authorizeUrl)).status).toBe(302);
  });

  it('accepts a user acting as themselves through a user API key too, not only a portal JWT', async () => {
    const { mintUserApiKey } = await import('../../middleware/auth.js');
    const { rawKey } = await mintUserApiKey(db, { userId: adminId, label: 'cli', createdBy: adminId, issuedVia: 'portal' });
    const res = await fetch(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ query: START('GMAIL', orgId) }),
    });
    const body = (await res.json()) as { data?: { startConnection?: { authorizeUrl: string } }; errors?: unknown };
    expect(body.errors).toBeUndefined();
    expect(body.data?.startConnection?.authorizeUrl).toContain('/auth/gmail?nonce=');
  });
});

describe('startConnection: parity with POST /auth/{provider}/start', () => {
  it('writes the same pending state: same user, org, provider binding and lifetime', async () => {
    const jwt = await signJwt({ sub: adminId, roles: ['READER'] });
    const rest = await fetch(`${baseUrl}/auth/gmail/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ orgId }),
    });
    expect(rest.status).toBe(200);
    await startAsAdmin();

    const all = await rows();
    expect(all).toHaveLength(2);
    const [a, b] = all;
    expect(a.userId).toBe(b.userId);
    expect(a.orgId).toBe(b.orgId);
    expect(a.kind.startsWith('exchange_start:gmail')).toBe(true);
    expect(b.kind.startsWith('exchange_start:gmail')).toBe(true);
    const ttl = (r: { expiresAt: Date; createdAt: Date }) => r.expiresAt.getTime() - r.createdAt.getTime();
    expect(Math.abs(ttl(a) - ttl(b))).toBeLessThan(2000);
  });

  it('a REST-started flow still lands on the portal, not the server done page', async () => {
    const jwt = await signJwt({ sub: adminId, roles: ['READER'] });
    const rest = await fetch(`${baseUrl}/auth/gmail/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ orgId, redirect: '/app/orgs/x/integrations' }),
    });
    const { nonce } = (await rest.json()) as { nonce: string };
    const state = await consent(`${baseUrl}/auth/gmail?nonce=${nonce}`);
    const cb = await fetch(`${baseUrl}/auth/gmail/callback?code=c&state=${state}`, { redirect: 'manual' });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toContain('/app/orgs/x/integrations');
    expect(cb.headers.get('location')).toContain('exchangeConnected=1');
  });
});

describe('startConnection: the server-hosted done page', () => {
  it('success: 200 HTML naming the provider and the org (escaped), no portal redirect, row recorded', async () => {
    const { authorizeUrl } = await startAsAdmin();
    const state = await consent(authorizeUrl);
    const cb = await fetch(`${baseUrl}/auth/gmail/callback?code=c&state=${state}`, { redirect: 'manual' });
    expect(cb.status).toBe(200);
    expect(cb.headers.get('location')).toBeNull();
    expect(cb.headers.get('content-type')).toContain('text/html');
    expect(cb.headers.get('cache-control')).toContain('no-store');
    expect(cb.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await cb.text();
    expect(html).toContain('close this tab');
    expect(html).toContain('Connect &lt;Org&gt; &amp; Co');
    expect(html).not.toContain('<Org>');
    const conn = await db.exchangeConnection.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(conn.mailboxEmail).toBe('owner@connect.example');
    expect(conn.userId).toBe(adminId);
  });

  it('provider-side refusal: an error page with a stable code, never the provider text', async () => {
    const { authorizeUrl } = await startAsAdmin();
    const state = await consent(authorizeUrl);
    const cb = await fetch(
      `${baseUrl}/auth/gmail/callback?error=access_denied&error_description=SECRET-PROVIDER-DETAIL&state=${state}`,
      { redirect: 'manual' },
    );
    expect(cb.status).toBe(200);
    const html = await cb.text();
    expect(html).toContain('access_denied');
    expect(html).not.toContain('SECRET-PROVIDER-DETAIL');
    expect(html).toContain('close this tab');
    // The refused flow consumed its state: it cannot be replayed into a success.
    const replay = await fetch(`${baseUrl}/auth/gmail/callback?code=c&state=${state}`, { redirect: 'manual' });
    expect(replay.status).toBe(400);
  });

  it('an unknown provider error code is shown as the generic stable code', async () => {
    const { authorizeUrl } = await startAsAdmin();
    const state = await consent(authorizeUrl);
    const cb = await fetch(`${baseUrl}/auth/gmail/callback?error=%3Cscript%3Ex%3C%2Fscript%3E&state=${state}`, {
      redirect: 'manual',
    });
    const html = await cb.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('provider_error');
  });

  it('tool failure: an error page with a stable code, never the thrown message, and no row', async () => {
    vi.mocked(createToolConnection).mockRejectedValueOnce(new Error('SECRET-TOOL-DETAIL refresh_token=abc'));
    const { authorizeUrl } = await startAsAdmin();
    const state = await consent(authorizeUrl);
    const cb = await fetch(`${baseUrl}/auth/gmail/callback?code=c&state=${state}`, { redirect: 'manual' });
    expect(cb.status).toBe(200);
    const html = await cb.text();
    expect(html).toContain('connection_failed');
    expect(html).not.toContain('SECRET-TOOL-DETAIL');
    expect(await db.exchangeConnection.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it('authority lost during the round-trip: not_authorized, nothing written', async () => {
    const { authorizeUrl } = await startAsAdmin();
    const state = await consent(authorizeUrl);
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: orgId, userId: adminId } },
      data: { deletedAt: new Date() },
    });
    const cb = await fetch(`${baseUrl}/auth/gmail/callback?code=c&state=${state}`, { redirect: 'manual' });
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('not_authorized');
    expect(vi.mocked(createToolConnection)).not.toHaveBeenCalled();
  });
});

describe('startConnection: refusals, each with its own code and no nonce minted', () => {
  it('a non-ADMIN org member is FORBIDDEN', async () => {
    const r = await gql(START('GMAIL', orgId), memberId);
    expect(code(r)).toEqual(['FORBIDDEN']);
    expect(await rows()).toHaveLength(0);
  });

  it("an unknown org answers the SAME FORBIDDEN as another org's (no existence oracle)", async () => {
    const other = await db.organization.create({ data: { name: 'Other', urn: 'other-org' } });
    const notAdmin = await gql(START('GMAIL', other.id), adminId);
    const unknown = await gql(START('GMAIL', generateId()), adminId);
    expect(code(unknown)).toEqual(['FORBIDDEN']);
    expect(unknown.errors?.map((e) => e.message)).toEqual(notAdmin.errors?.map((e) => e.message));
    expect(await rows()).toHaveLength(0);
  });

  it('an unauthenticated request is refused before any work', async () => {
    const r = await gql(START('GMAIL', orgId), null);
    expect(r.errors).toBeDefined();
    expect(await rows()).toHaveLength(0);
  });

  it('an unconfigured provider is the typed CONNECTION_PROVIDER_NOT_CONFIGURED and mints nothing', async () => {
    delete process.env.GMAIL_CLIENT_ID;
    const r = await gql(START('GMAIL', orgId), adminId);
    expect(code(r)).toEqual(['CONNECTION_PROVIDER_NOT_CONFIGURED']);
    expect(await rows()).toHaveLength(0);
  });

  it('a non-ADMIN learns nothing about configuration: FORBIDDEN, not CONNECTION_PROVIDER_NOT_CONFIGURED', async () => {
    delete process.env.GMAIL_CLIENT_ID;
    const r = await gql(START('GMAIL', orgId), memberId);
    expect(code(r)).toEqual(['FORBIDDEN']);
  });

  it('an unconfigured provider is reported before the nonce, so a retry after configuration still works', async () => {
    delete process.env.GMAIL_CLIENT_ID;
    await gql(START('GMAIL', orgId), adminId);
    process.env.GMAIL_CLIENT_ID = 'gmail-client-id.apps.googleusercontent.example';
    const ok = await gql(START('GMAIL', orgId), adminId);
    expect(ok.errors).toBeUndefined();
  });
});

describe('startConnection: credentials that may never start a connection (resolver level)', () => {
  const apollo = new ApolloServer<Context>({ typeDefs, resolvers });
  async function run(ctx: Partial<Context>, fn?: <T>(f: () => Promise<T>) => Promise<T>) {
    const exec = () =>
      apollo.executeOperation({ query: START('GMAIL', orgId) }, { contextValue: { db, ...ctx } as Context });
    const res = await (fn ? fn(exec) : exec());
    if (res.body.kind !== 'single') throw new Error('unexpected');
    return res.body.singleResult;
  }
  const codes = (r: Awaited<ReturnType<typeof run>>) => r.errors?.map((e) => e.extensions?.code);

  it('an App key with no user: UNAUTHENTICATED', async () => {
    const r = await run({ appId: 'app-1', roles: [] });
    expect(codes(r)).toEqual(['UNAUTHENTICATED']);
    expect(await rows()).toHaveLength(0);
  });

  it('no credential at all: UNAUTHENTICATED', async () => {
    const r = await run({ roles: [] });
    expect(codes(r)).toEqual(['UNAUTHENTICATED']);
  });

  it('an App run acting for the org ADMIN (appId and userId both set): FORBIDDEN', async () => {
    const r = await run({ appId: 'app-1', userId: adminId, roles: ['READER'] });
    expect(codes(r)).toEqual(['FORBIDDEN']);
    expect(await rows()).toHaveLength(0);
  });

  it('an impersonated request: FORBIDDEN', async () => {
    const r = await run({
      userId: adminId,
      roles: [],
      impersonation: { sessionId: 's', actorUserId: memberId, orgId, expiresAt: new Date(Date.now() + 60_000) },
    });
    expect(codes(r)).toEqual(['FORBIDDEN']);
    expect(await rows()).toHaveLength(0);
  });

  it('a bound worker session: FORBIDDEN, even for an org ADMIN user', async () => {
    const r = await run({ userId: adminId, roles: ['READER'] }, (f) =>
      runAsActor({ workerId: 'worker-1', agentId: null, userId: adminId }, f),
    );
    expect(codes(r)).toEqual(['FORBIDDEN']);
    expect(await rows()).toHaveLength(0);
  });

  it('an OAuth credential limited to the MCP surface: the existing surface refusal', async () => {
    const r = await run({ userId: adminId, roles: ['READER'], oauthScopes: ['mcp'] });
    expect(codes(r)).toEqual(['FORBIDDEN']);
    expect(r.errors?.[0]?.extensions).toMatchObject({ code: 'FORBIDDEN', reason: 'OAUTH_SCOPE_INSUFFICIENT' });
    expect(await rows()).toHaveLength(0);
  });
});
