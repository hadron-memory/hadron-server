/**
 * #2948 — Google connect hub core: an optional account hint on the three Google connect starts
 * (POST /auth/gmail/start, /auth/google-cal/start, /auth/google-drive/start), passed to Google as
 * `login_hint` so a second service for an already-connected account skips the account picker.
 *
 * Scope (ruling 0156): a hint is accepted ONLY when it equals the `mailboxEmail` of a live Google
 * connection (provider gmail/google-cal/google-drive, deletedAt null) the CALLER holds in THAT org.
 * Every other shape — malformed, a stranger's address, another member's connected address, the
 * caller's own address held only in another org, a soft-deleted connection, a non-Google
 * connection, any hint at all on the Microsoft start — is ONE typed 400, before any nonce row
 * exists, and the refusal says nothing about which it was (no cross-member oracle).
 *
 * The hint is a HINT only (ruling 0155): the callback still records the account Google actually
 * authenticated — a mismatch never attaches the connection to the hinted address. The hint rides
 * the DB-backed nonce row (never a URL) from the start to the authorize redirect, and appears in
 * no URL other than the Google redirect.
 *
 * Real Express app over HTTP, real database; the provider tool (emailClient) is mocked where the
 * callback is driven, as in the #2913 suite.
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

let server: Server | undefined;
let baseUrl: string;
let adminId: string;
let memberId: string;
let orgId: string;
let otherOrgId: string;
const savedEnv: Record<string, string | undefined> = {};

const GOOGLE_ENV = {
  GMAIL_CLIENT_ID: 'gmail-client-id.apps.googleusercontent.example',
  GOOGLE_CAL_CLIENT_ID: 'google-cal-client-id.apps.googleusercontent.example',
  GOOGLE_DRIVE_CLIENT_ID: 'google-drive-client-id.apps.googleusercontent.example',
} as const;

const OWN_GMAIL = 'chain.owner@example.com';
const OTHER_MEMBER_DRIVE = 'chain.member@example.com';

beforeAll(async () => {
  for (const key of [...Object.keys(GOOGLE_ENV), 'MICROSOFT_CLIENT_ID', 'FRONTEND_URL']) {
    savedEnv[key] = process.env[key];
  }
  const app = await createServer();
  const listening = createHttpServer(app);
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
});

afterAll(async () => {
  try {
    const listening = server;
    if (listening) await new Promise<void>((resolve, reject) => listening.close((err) => (err ? reject(err) : resolve())));
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

beforeEach(async () => {
  vi.mocked(createToolConnection).mockReset();
  await cleanDb(db);
  const admin = await db.user.create({ data: { githubId: 29481, githubUsername: 'hint-admin', roles: ['READER'] } });
  adminId = admin.id;
  const member = await db.user.create({ data: { githubId: 29482, githubUsername: 'hint-member', roles: ['READER'] } });
  memberId = member.id;
  const org = await db.organization.create({ data: { name: 'hint-org', urn: 'hint-org' } });
  orgId = org.id;
  const otherOrg = await db.organization.create({ data: { name: 'hint-other-org', urn: 'hint-other-org' } });
  otherOrgId = otherOrg.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: memberId, role: 'CONTRIBUTOR' } });
  Object.assign(process.env, GOOGLE_ENV);
});

/** POST /auth/<route>/start as the admin, with an optional body extension. */
async function start(route: string, extra: Record<string, unknown> = {}): Promise<Response> {
  const jwt = await signJwt({ sub: adminId, roles: ['READER'] });
  return fetch(`${baseUrl}/auth/${route}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ orgId, ...extra }),
    redirect: 'manual',
  });
}

/** Seed a connection row (the hint's scope: own, live, Google-provider, in-org). */
function seedConnection(args: {
  userId: string;
  organizationId: string;
  mailboxEmail: string;
  provider: string;
  deletedAt?: Date | null;
}): Promise<{ id: string }> {
  return db.exchangeConnection.create({
    data: {
      organizationId: args.organizationId,
      userId: args.userId,
      mailboxEmail: args.mailboxEmail,
      displayName: args.mailboxEmail,
      provider: args.provider,
      toolConnectionId: `tool-${args.provider}`,
      syncStatus: 'OK',
      createdBy: args.userId,
      deletedAt: args.deletedAt ?? null,
    },
    select: { id: true },
  });
}

/** Start → confirm → the 302 Location of the authorize redirect (asserted by the caller). */
async function startAndConfirm(route: string, extra: Record<string, unknown> = {}): Promise<{ location: URL; pageUrl: string; pageHtml: string }> {
  const started = await start(route, extra);
  expect(started.status).toBe(200);
  const { nonce } = (await started.json()) as { nonce: string };
  const pageUrl = `${baseUrl}/auth/${route}?nonce=${nonce}`;
  const page = await fetch(pageUrl, { redirect: 'manual' });
  expect(page.status).toBe(200);
  const pageHtml = await page.text();
  const posted = await confirmConnect(pageUrl);
  expect(posted.status).toBe(302);
  return { location: new URL(posted.headers.get('location') as string), pageUrl, pageHtml };
}

/** Every handoff row written so far in this test (a refused hint must leave zero). */
const handoffRowCount = (): Promise<number> => db.authHandoffCode.count();

describe('#2948 login_hint on the Google connect starts', () => {
  it('carries an accepted hint to Google as login_hint (gmail start, own gmail connection)', async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'gmail' });
    const { location } = await startAndConfirm('gmail', { accountHint: OWN_GMAIL });
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('login_hint')).toBe(OWN_GMAIL);
    expect([...location.searchParams.keys()].filter((k) => k === 'login_hint')).toHaveLength(1);
  });

  it('chains across providers: a google-drive connection hints a google-cal start', async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'google-drive' });
    const { location } = await startAndConfirm('google-cal', { accountHint: OWN_GMAIL });
    expect(location.searchParams.get('login_hint')).toBe(OWN_GMAIL);
  });

  it('carries the hint on the google-drive start (the issue-named provider)', async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'google-drive' });
    const { location } = await startAndConfirm('google-drive', { accountHint: OWN_GMAIL });
    expect(location.searchParams.get('login_hint')).toBe(OWN_GMAIL);
  });

  it('without a hint the authorize URL is byte-identical to today (no login_hint param at all)', async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'gmail' });
    const { location } = await startAndConfirm('gmail');
    expect(location.search).not.toContain('login_hint');
    // The pre-#2948 contract, unchanged: the refresh-token prerequisites and the provider binding.
    expect(location.searchParams.get('client_id')).toBe(GOOGLE_ENV.GMAIL_CLIENT_ID);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent');
    expect(location.searchParams.get('redirect_uri')).toMatch(/\/auth\/gmail\/callback$/);
    expect(location.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('treats a null or empty accountHint as absent (no login_hint, start succeeds)', async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'gmail' });
    for (const empty of [null, '']) {
      const { location } = await startAndConfirm('gmail', { accountHint: empty });
      expect(location.searchParams.has('login_hint')).toBe(false);
    }
  });
});

describe('#2948 hint scope — own live Google connection in that org, else ONE typed 400', () => {
  const REFUSALS: [string, () => Promise<unknown>, Record<string, unknown>][] = [];

  const refuseCase = (name: string, extra: Record<string, unknown>, seed?: () => Promise<unknown>) => {
    REFUSALS.push([name, seed ?? (async () => {}), extra]);
  };

  refuseCase('malformed: not an email', { accountHint: 'not-an-email' });
  refuseCase('malformed: 300-char blob', { accountHint: 'a'.repeat(300) });
  refuseCase('malformed: non-string (number)', { accountHint: 42 });
  refuseCase('well-formed but no such connection anywhere', { accountHint: 'stranger@example.com' });
  refuseCase('another member’s connected address (same org)', { accountHint: OTHER_MEMBER_DRIVE }, async () => {
    await seedConnection({ userId: memberId, organizationId: orgId, mailboxEmail: OTHER_MEMBER_DRIVE, provider: 'google-drive' });
  });
  refuseCase('own address held only in ANOTHER org', { accountHint: OWN_GMAIL }, async () => {
    await seedConnection({ userId: adminId, organizationId: otherOrgId, mailboxEmail: OWN_GMAIL, provider: 'gmail' });
  });
  refuseCase('own connection but soft-deleted', { accountHint: OWN_GMAIL }, async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'gmail', deletedAt: new Date() });
  });
  refuseCase('own connection but NOT a Google provider (ms-exchange)', { accountHint: OWN_GMAIL }, async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'ms-exchange' });
  });

  it('refuses every out-of-scope shape with the same typed 400, before any nonce row exists', async () => {
    const bodies: string[] = [];
    for (const [name, seed, extra] of REFUSALS) {
      await seed();
      const res = await start('gmail', extra);
      expect(res.status, name).toBe(400);
      const body = await res.text();
      bodies.push(body);
      expect(JSON.parse(body), name).toEqual({ error: 'invalid_account_hint' });
      // Before the nonce: the refusal writes no handoff row of any kind.
      expect(await handoffRowCount(), name).toBe(0);
    }
    // One refusal shape for every cause: byte-identical bodies, no oracle.
    expect(new Set(bodies).size).toBe(1);
  });

  it('the refusal says nothing about whether the address is connected for anyone else', async () => {
    // Same body whether or not the address exists as another member's connection.
    const stranger = await (await start('gmail', { accountHint: 'stranger@example.com' })).text();
    await seedConnection({ userId: memberId, organizationId: orgId, mailboxEmail: OTHER_MEMBER_DRIVE, provider: 'google-drive' });
    const member = await (await start('gmail', { accountHint: OTHER_MEMBER_DRIVE })).text();
    expect(stranger).toBe(member);
  });

  it('refuses a hint on the Microsoft start with the same typed 400 (no hint outside the Google providers)', async () => {
    process.env.MICROSOFT_CLIENT_ID = 'microsoft-client-id';
    try {
      await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'ms-exchange' });
      const res = await start('microsoft', { accountHint: OWN_GMAIL });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_account_hint' });
      expect(await handoffRowCount()).toBe(0);
    } finally {
      delete process.env.MICROSOFT_CLIENT_ID;
    }
  });
});

describe('#2948 existing gates unchanged (order: role, configuration, then the hint)', () => {
  it('403s a non-admin before the hint is judged, as today', async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'gmail' });
    const jwt = await signJwt({ sub: memberId, roles: ['READER'] });
    const res = await fetch(`${baseUrl}/auth/gmail/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ orgId, accountHint: 'not-even-an-email' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });

  it('503s an unconfigured provider before the hint is judged, as today', async () => {
    delete process.env.GMAIL_CLIENT_ID;
    const res = await start('gmail', { accountHint: 'not-even-an-email' });
    expect(res.status).toBe(503);
  });

  it('refuses a non-portal redirect path as today, with a hint present', async () => {
    const res = await start('gmail', { accountHint: 'not-even-an-email', redirect: 'https://evil.example.com/app' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'redirect must be a path inside the portal, such as /app/dashboard' });
  });
});

describe('#2948 the hint is a hint only, and rides no URL but the Google redirect', () => {
  it('records the account Google AUTHENTICATED (tool identity), never the hinted address', async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'gmail' });
    const authenticated = 'actually.signed.in@example.com';
    vi.mocked(createToolConnection).mockResolvedValueOnce({
      id: 'tool-new',
      provider: 'gmail',
      mailboxEmail: authenticated,
      displayName: authenticated,
    } as Awaited<ReturnType<typeof createToolConnection>>);

    const started = await start('gmail', { accountHint: OWN_GMAIL });
    expect(started.status).toBe(200);
    const { nonce } = (await started.json()) as { nonce: string };
    const posted = await confirmConnect(`${baseUrl}/auth/gmail?nonce=${nonce}`);
    expect(posted.status).toBe(302);
    const state = new URL(posted.headers.get('location') as string).searchParams.get('state') as string;
    const cb = await fetch(`${baseUrl}/auth/gmail/callback?code=c1&state=${state}`, { redirect: 'manual' });
    expect(cb.status).toBe(302);
    const cbLocation = new URL(cb.headers.get('location') as string);

    const rows = await db.exchangeConnection.findMany({ where: { organizationId: orgId, provider: 'gmail' } });
    expect(rows.map((r) => r.mailboxEmail).sort()).toEqual([OWN_GMAIL, authenticated].sort());
    expect(rows.find((r) => r.mailboxEmail === authenticated)?.toolConnectionId).toBe('tool-new');
    // The callback's browser redirect (portal origin) carries no hint.
    expect(cbLocation.origin).not.toBe('https://accounts.google.com');
    expect(cbLocation.search).not.toContain(OWN_GMAIL);
    expect(cbLocation.search).not.toContain('login_hint');
  });

  it('shows the hint on NO surface except the Google authorize redirect', async () => {
    await seedConnection({ userId: adminId, organizationId: orgId, mailboxEmail: OWN_GMAIL, provider: 'gmail' });
    const { location, pageUrl, pageHtml } = await startAndConfirm('gmail', { accountHint: OWN_GMAIL });
    // The one place it appears: the Google authorize URL.
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('login_hint')).toBe(OWN_GMAIL);
    // Not on the confirmation page's URL, its HTML (form fields), or the POST target path.
    expect(pageUrl).not.toContain(OWN_GMAIL);
    expect(pageHtml).not.toContain(OWN_GMAIL);
    expect(pageHtml).not.toContain('login_hint');
    // Not in the URL-encoded local part either (the POST posts to the bare route path).
    const postedPath = new URL(pageUrl).pathname;
    expect(postedPath).not.toContain(encodeURIComponent(OWN_GMAIL));
  });
});
