/**
 * #2909 — the portal connect flow must not follow an absolute `redirect` out of the site.
 *
 * `POST /auth/{provider}/start` stored any non-empty `redirect` string, and the callback did
 * `new URL(pending.redirect, frontendUrl)`, so an absolute value sent the admin's browser to another origin.
 * Now the start refuses anything that is not a portal PATH (400, before any nonce is minted), and the callback
 * re-validates what a nonce minted before this change may still carry (a bad stored value fails closed to `/`).
 *
 * Real Express app over HTTP, real database; the provider tool is mocked, the callback is driven with a fabricated code.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';

vi.mock('../../lib/emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/emailClient.js')>()),
  createToolConnection: vi.fn(async () => ({
    id: 'tool-conn-2909',
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
import { signJwt } from '../../auth/index.js';
import { issueExchangeStartNonce } from '../../auth/authHandoff.js';
import { confirmConnect } from '../connectInterstitial.js';

const FRONTEND = 'https://portal.example';
const ENV_KEYS = ['BASE_URL', 'FRONTEND_URL', 'GMAIL_CLIENT_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};

let server: Server;
let baseUrl: string;
let adminId: string;
let orgId: string;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  process.env.BASE_URL = baseUrl;
  process.env.FRONTEND_URL = FRONTEND;
  process.env.GMAIL_CLIENT_ID = 'gmail-client-id.apps.googleusercontent.example';
  const admin = await db.user.create({ data: { githubId: 290901, githubUsername: 'redir-admin', roles: ['READER'] } });
  adminId = admin.id;
  const org = await db.organization.create({ data: { name: 'Redirect Org', urn: 'redirect-org' } });
  orgId = org.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
});

afterEach(() => {
  process.env.BASE_URL = baseUrl;
});

async function start(redirect: unknown) {
  const jwt = await signJwt({ sub: adminId, roles: ['READER'] });
  return fetch(`${baseUrl}/auth/gmail/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ orgId, redirect }),
  });
}

const nonces = () => db.authHandoffCode.count({ where: { kind: { startsWith: 'exchange_start' } } });

/** Redeem a nonce at the browser leg and finish the callback; returns the callback response. */
async function finish(nonce: string, callbackQuery = 'code=c') {
  const auth = await confirmConnect(`${baseUrl}/auth/gmail?nonce=${nonce}`);
  expect(auth.status).toBe(302);
  const state = new URL(auth.headers.get('location')!).searchParams.get('state')!;
  return fetch(`${baseUrl}/auth/gmail/callback?${callbackQuery}&state=${state}`, { redirect: 'manual' });
}

/** Values that are NOT a path inside the portal. */
const REFUSED: [string, string][] = [
  ['an absolute https URL', 'https://evil.example/x'],
  ['a protocol-relative URL', '//evil.example/x'],
  ['a backslash after the slash', '/\\evil.example/x'],
  ['a dot segment that resolves to a protocol-relative path', '/..//evil.example/x'],
  ['a tab before a protocol-relative URL', '\t//evil.example/x'],
  ['a tab inside the slashes', '/\t/evil.example/x'],
  ['a newline inside the slashes', '/\n/evil.example/x'],
  ['a javascript: URL', 'javascript:alert(1)'],
  ['a scheme with no slashes', 'http:evil.example'],
  ['no leading slash', 'evil.example/x'],
  ['a leading space', ' /app/dashboard'],
  ['a backslash first', '\\\\evil.example'],
  ['the portal origin spelled absolutely', `${FRONTEND}/app/dashboard`],
];

describe('start: a redirect that is not a portal path is refused with 400 before any nonce is minted', () => {
  it.each(REFUSED)('%s', async (_name, value) => {
    const res = await start(value);
    expect(res.status).toBe(400);
    expect(await nonces()).toBe(0);
  });

  it('a non-string redirect is refused too', async () => {
    expect((await start({ a: 1 })).status).toBe(400);
    expect(await nonces()).toBe(0);
  });
});

describe('start: a portal path is accepted and the callback still lands on it', () => {
  it('a normal path with a query keeps its query and gains the exchangeConnected + provider parameters', async () => {
    const res = await start('/app/dashboard?x=1');
    expect(res.status).toBe(200);
    const { nonce } = (await res.json()) as { nonce: string };
    const cb = await finish(nonce);
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get('location')!);
    expect(loc.origin).toBe(FRONTEND);
    expect(loc.pathname).toBe('/app/dashboard');
    expect(loc.searchParams.get('x')).toBe('1');
    expect(loc.searchParams.get('exchangeConnected')).toBe('1');
    expect(loc.searchParams.get('provider')).toBe('gmail');
  });

  it('an omitted redirect still defaults to /', async () => {
    const res = await start(undefined);
    expect(res.status).toBe(200);
    const { nonce } = (await res.json()) as { nonce: string };
    const loc = new URL((await finish(nonce)).headers.get('location')!);
    expect(loc.origin).toBe(FRONTEND);
    expect(loc.pathname).toBe('/');
  });

  it('/%5Chost is a valid PATH (percent-encoded, no escape): accepted, and it stays on the portal origin', async () => {
    const res = await start('/%5Cevil.example');
    expect(res.status).toBe(200);
    const { nonce } = (await res.json()) as { nonce: string };
    const loc = new URL((await finish(nonce)).headers.get('location')!);
    expect(loc.origin).toBe(FRONTEND);
  });
});

describe('callback: a nonce minted before this change fails closed to /', () => {
  const stored = REFUSED.filter(([, v]) => v !== `${FRONTEND}/app/dashboard`);

  it.each(stored)('success path, stored %s', async (_name, value) => {
    const nonce = await issueExchangeStartNonce({
      userId: adminId,
      orgId,
      redirect: value,
      provider: 'gmail',
      origin: 'portal',
    });
    const cb = await finish(nonce);
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get('location')!);
    expect(loc.origin).toBe(FRONTEND);
    expect(loc.pathname).toBe('/');
    expect(loc.searchParams.get('exchangeConnected')).toBe('1');
  });

  it('failure path (tool refuses), stored absolute URL', async () => {
    const { createToolConnection } = await import('../../lib/emailClient.js');
    vi.mocked(createToolConnection).mockRejectedValueOnce(new Error('tool said no'));
    const nonce = await issueExchangeStartNonce({
      userId: adminId,
      orgId,
      redirect: 'https://evil.example/x',
      provider: 'gmail',
      origin: 'portal',
    });
    const cb = await finish(nonce);
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get('location')!);
    expect(loc.origin).toBe(FRONTEND);
    expect(loc.pathname).toBe('/');
    expect(loc.searchParams.get('exchangeError')).toBeTruthy();
  });

  it('a stored valid path is still honored', async () => {
    const nonce = await issueExchangeStartNonce({
      userId: adminId,
      orgId,
      redirect: '/app/orgs/x/integrations',
      provider: 'gmail',
      origin: 'portal',
    });
    const loc = new URL((await finish(nonce)).headers.get('location')!);
    expect(loc.pathname).toBe('/app/orgs/x/integrations');
  });
});
