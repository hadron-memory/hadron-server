/**
 * #2908 — opening a connect link is a read. `GET /auth/{provider}?nonce=` shows a confirmation page naming the
 * organization and who asked; `POST` (the Continue button) redeems the single-use nonce and 302s to the provider.
 * A link preview or prefetch that only GETs consumes nothing and starts nothing.
 *
 * Real Express app over HTTP, real database; the provider tool is mocked (the provider's own consent is not reachable).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { confirmConnect } from '../connectInterstitial.js';
import { connectInterstitialToken, issueExchangeStartNonce } from '../../auth/authHandoff.js';

const ENV_KEYS = ['BASE_URL', 'GMAIL_CLIENT_ID', 'MICROSOFT_CLIENT_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};

let server: Server;
let baseUrl: string;
let adminId: string;
let orgId: string;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  server = createHttpServer(await createServer());
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
  await cleanDb(db);
  process.env.BASE_URL = baseUrl;
  process.env.GMAIL_CLIENT_ID = 'gmail-client-id.apps.googleusercontent.example';
  process.env.MICROSOFT_CLIENT_ID = 'ms-client-id';
  const admin = await db.user.create({ data: { githubId: 290801, githubUsername: 'interstitial-admin', roles: ['READER'], name: 'Ada <b>Admin</b>' } });
  adminId = admin.id;
  const org = await db.organization.create({ data: { name: 'Connect <Org> & "Co"', urn: 'interstitial-org' } });
  orgId = org.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
});

afterEach(() => {
  process.env.GMAIL_CLIENT_ID = savedEnv.GMAIL_CLIENT_ID;
});

const mint = (over: { provider?: string; origin?: 'portal' | 'graphql'; userId?: string; orgId?: string } = {}) =>
  issueExchangeStartNonce({
    userId: over.userId ?? adminId,
    orgId: over.orgId ?? orgId,
    redirect: '/app',
    provider: over.provider ?? 'gmail',
    origin: over.origin ?? 'portal',
  });
const url = (nonce: string, route = 'gmail') => `${baseUrl}/auth/${route}?nonce=${nonce}`;
const fieldOf = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)![1];
/** A browser binding for tests that post directly; `null` sends no cookie at all. */
const B = 'ab'.repeat(16);
const post = (route: string, body: Record<string, string>, cookieBinding: string | null = B) =>
  fetch(`${baseUrl}/auth/${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookieBinding ? { cookie: `hadron_connect_bind=${cookieBinding}` } : {}),
    },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });

describe('GET /auth/{provider}?nonce= is a read', () => {
  it('two GETs consume nothing, then the confirmation POST succeeds', async () => {
    const nonce = await mint();
    expect((await fetch(url(nonce), { redirect: 'manual' })).status).toBe(200);
    expect((await fetch(url(nonce), { redirect: 'manual' })).status).toBe(200);
    const row = await db.authHandoffCode.findFirstOrThrow({ where: { kind: { startsWith: 'exchange_start' } } });
    expect(row.redeemedAt).toBeNull();
    const res = await confirmConnect(url(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('https://accounts.google.com/');
  });

  it('the page names the org and the initiator, escaped, with one Continue button', async () => {
    const html = await (await fetch(url(await mint()), { redirect: 'manual' })).text();
    expect(html).toContain('Connect &lt;Org&gt; &amp; &quot;Co&quot;');
    expect(html).toContain('Ada &lt;b&gt;Admin&lt;/b&gt;');
    expect(html).not.toContain('<b>Admin</b>');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('falls back to @handle when the initiator has no name', async () => {
    const u = await db.user.update({ where: { id: adminId }, data: { name: null } });
    const html = await (await fetch(url(await mint()), { redirect: 'manual' })).text();
    expect(html).toContain(`@${u.handle}`);
  });

  it('sends the hardening headers', async () => {
    const res = await fetch(url(await mint()), { redirect: 'manual' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('shows the page for a REST-started and a GraphQL-started nonce alike', async () => {
    expect((await fetch(url(await mint({ origin: 'portal' })), { redirect: 'manual' })).status).toBe(200);
    expect((await fetch(url(await mint({ origin: 'graphql' })), { redirect: 'manual' })).status).toBe(200);
  });
});

describe('POST /auth/{provider}', () => {
  it('redeems once: a second confirmation is refused', async () => {
    const nonce = await mint();
    expect((await confirmConnect(url(nonce))).status).toBe(302);
    const again = await post('gmail', { nonce, token: connectInterstitialToken('gmail', nonce, B) });
    expect(again.status).toBe(400);
  });

  it('a wrong or missing token is refused WITHOUT burning the nonce', async () => {
    const nonce = await mint();
    expect((await post('gmail', { nonce, token: 'f'.repeat(64) })).status).toBe(400);
    expect((await post('gmail', { nonce })).status).toBe(400);
    expect((await post('gmail', { nonce, token: 'zz' })).status).toBe(400);
    expect((await confirmConnect(url(nonce))).status).toBe(302);
  });

  it('a token fetched in one browser does not confirm in another (no cookie, or another browser binding)', async () => {
    const nonce = await mint();
    // The page is fetched with no cookie jar of the victim's: the attacker holds the token and its binding.
    const page = await fetch(url(nonce), { redirect: 'manual' });
    const token = fieldOf(await page.text(), 'token');
    const attackerBinding = /hadron_connect_bind=([0-9a-f]{32})/.exec(page.headers.get('set-cookie') ?? '')![1];
    expect((await post('gmail', { nonce, token }, null)).status).toBe(400);
    expect((await post('gmail', { nonce, token }, 'cd'.repeat(16))).status).toBe(400);
    expect((await post('gmail', { nonce, token }, 'not-a-binding')).status).toBe(400);
    const row = await db.authHandoffCode.findFirstOrThrow({ where: { kind: { startsWith: 'exchange_start' } } });
    expect(row.redeemedAt).toBeNull();
    // ...and it does confirm in the browser that received the page.
    expect((await post('gmail', { nonce, token }, attackerBinding)).status).toBe(302);
  });

  it('the page sets the binding as an HttpOnly, SameSite=Strict cookie scoped to the route, and a second tab reuses it', async () => {
    const nonce = await mint();
    const first = await fetch(url(nonce), { redirect: 'manual' });
    const cookie = first.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^hadron_connect_bind=[0-9a-f]{32}; Path=\/auth\/gmail; Max-Age=120; HttpOnly; SameSite=Strict/);
    const again = await fetch(url(nonce), { redirect: 'manual', headers: { cookie: cookie.split(';')[0] } });
    expect(fieldOf(await again.text(), 'token')).toBe(fieldOf(await first.text(), 'token'));
  });

  it('a token for one nonce, or one provider, fails for another', async () => {
    const a = await mint();
    const b = await mint();
    expect((await post('gmail', { nonce: b, token: connectInterstitialToken('gmail', a, B) })).status).toBe(400);
    expect((await post('gmail', { nonce: a, token: connectInterstitialToken('ms-exchange', a, B) })).status).toBe(400);
    expect((await post('gmail', { nonce: a, token: connectInterstitialToken('gmail', a, B) })).status).toBe(302);
  });

  it('judges eligibility before redeeming: an ex-admin POST is refused and the nonce stays unredeemed', async () => {
    const nonce = await mint();
    const token = connectInterstitialToken('gmail', nonce, B);
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: adminId }, data: { deletedAt: new Date() } });
    expect((await post('gmail', { nonce, token })).status).toBe(400);
    const row = await db.authHandoffCode.findFirstOrThrow({ where: { kind: { startsWith: 'exchange_start' } } });
    expect(row.redeemedAt).toBeNull();
  });

  it('503s while the provider is unconfigured, without burning the nonce', async () => {
    const nonce = await mint();
    const token = connectInterstitialToken('gmail', nonce, B);
    delete process.env.GMAIL_CLIENT_ID;
    expect((await post('gmail', { nonce, token })).status).toBe(503);
    process.env.GMAIL_CLIENT_ID = 'gmail-client-id.apps.googleusercontent.example';
    expect((await post('gmail', { nonce, token })).status).toBe(302);
  });
});

describe('one refusal for every shape', () => {
  async function snapshot(res: Response) {
    const headers = [...res.headers.entries()].filter(([k]) => !['date', 'etag', 'x-request-id'].includes(k));
    return { status: res.status, body: await res.text(), headers };
  }

  it('unknown, expired, redeemed, wrong provider, deleted org, deleted user and ex-admin are byte-identical', async () => {
    const shapes: Record<string, () => Promise<string>> = {
      unknown: async () => 'nope',
      expired: async () => {
        const n = await mint();
        await db.authHandoffCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
        return n;
      },
      redeemed: async () => {
        const n = await mint();
        await db.authHandoffCode.updateMany({ data: { redeemedAt: new Date() } });
        return n;
      },
      wrongProvider: async () => mint({ provider: 'ms-exchange' }),
      deletedOrg: async () => {
        const o = await db.organization.create({ data: { name: 'gone', urn: 'gone-org', deletedAt: new Date() } });
        await db.orgMember.create({ data: { organizationId: o.id, userId: adminId, role: 'ADMIN' } });
        return mint({ orgId: o.id });
      },
      deletedUser: async () => {
        const u = await db.user.create({ data: { githubId: 290802, githubUsername: 'gone-user', deletedAt: new Date() } });
        await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role: 'ADMIN' } });
        return mint({ userId: u.id });
      },
      exAdmin: async () => {
        const u = await db.user.create({ data: { githubId: 290803, githubUsername: 'ex-admin' } });
        await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role: 'ADMIN', deletedAt: new Date() } });
        return mint({ userId: u.id });
      },
    };
    const seen: Record<string, Awaited<ReturnType<typeof snapshot>>> = {};
    for (const [name, make] of Object.entries(shapes)) {
      await db.authHandoffCode.deleteMany({});
      const nonce = await make();
      const get = await snapshot(await fetch(url(nonce), { redirect: 'manual' }));
      const postRes = await snapshot(await post('gmail', { nonce, token: connectInterstitialToken('gmail', nonce, B) }));
      seen[`${name}:get`] = get;
      seen[`${name}:post`] = postRes;
    }
    const first = seen['unknown:get'];
    expect(first.status).toBe(400);
    expect(first.body).toBe(JSON.stringify({ error: 'Invalid or expired nonce' }));
    expect(first.headers.find(([k]) => k === 'content-length')?.[1]).toBe('36');
    for (const [name, snap] of Object.entries(seen)) expect({ name, ...snap }).toEqual({ name, ...first });
  });
});

describe('the other providers share the page', () => {
  it('Microsoft shows the interstitial and redirects on confirmation', async () => {
    const nonce = await mint({ provider: 'ms-exchange' });
    expect((await fetch(url(nonce, 'microsoft'), { redirect: 'manual' })).status).toBe(200);
    expect((await confirmConnect(url(nonce, 'microsoft'))).status).toBe(302);
  });

  it('page action posts back to the same provider route', async () => {
    const html = await (await fetch(url(await mint()), { redirect: 'manual' })).text();
    expect(html).toContain('action="/auth/gmail"');
    expect(fieldOf(html, 'token')).toMatch(/^[0-9a-f]{64}$/);
  });
});
