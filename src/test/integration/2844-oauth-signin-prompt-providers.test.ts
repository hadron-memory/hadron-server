/**
 * #2844 — the MCP connector sign-in prompt (#168) also offers Google and Apple,
 * each only when the deployment has that provider fully configured (a button
 * that 503s is worse than none). Each link carries the same `return_to` as the
 * GitHub link: the original authorize URL, a server-local path.
 *
 * Google is configured by GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, Apple by all
 * four APPLE_* variables (isAppleConfigured). Env is read per request, so the
 * tests stub it around each request.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { isServerLocalPath } from '../../auth/server-local-path.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';

const htmlValue = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const anchors = (html: string) =>
  [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: htmlValue(/href="([^"]*)"/.exec(m[1])?.[1] ?? ''),
    text: m[2].replace(/<[^>]*>/g, '').trim(),
  }));
const linkByLabel = (html: string, label: string) => anchors(html).find((a) => a.text === label);

let server: Server;
let baseUrl: string;
const REDIRECT = 'com.hadronmemory.ios://oauth/callback';
const clientId = `dcr_${'c'.repeat(32)}`;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});
beforeEach(async () => {
  await cleanDb(db);
  await db.oAuthClient.create({ data: { clientId, clientName: 'Claude Desktop', redirectUris: [REDIRECT] } });
});
afterEach(() => { vi.unstubAllEnvs(); });

const query = (overrides: Record<string, string | undefined> = {}) => {
  const p = new URLSearchParams();
  const merged: Record<string, string | undefined> = {
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
    resource: `${baseUrl}/mcp`, state: 'opaque-state', ...overrides,
  };
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) p.set(k, v);
  return p.toString();
};
const get = (q: string) => fetch(`${baseUrl}/oauth/authorize?${q}`, { redirect: 'manual' });
const configureGoogle = () => { vi.stubEnv('GOOGLE_CLIENT_ID', 'g-id'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'g-secret'); };
const APPLE_VARS = ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'] as const;
const configureApple = (except?: (typeof APPLE_VARS)[number]) => {
  for (const v of APPLE_VARS) vi.stubEnv(v, v === except ? '' : `apple-${v}`);
};
const unconfigureAll = () => {
  for (const v of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', ...APPLE_VARS]) vi.stubEnv(v, '');
};

describe('#2844 provider links on the MCP sign-in prompt', () => {
  it('with Google and Apple configured, offers both, each carrying the same return_to as the GitHub link', async () => {
    configureGoogle(); configureApple();
    const q = query();
    const html = await (await get(q)).text();
    const returnTo = `/oauth/authorize?${q}`;
    for (const [label, path] of [['Continue with GitHub', '/auth/github'], ['Continue with Google', '/auth/google'], ['Continue with Apple', '/auth/apple']] as const) {
      const link = linkByLabel(html, label);
      expect(link, label).toBeDefined();
      const url = new URL(link!.href, 'http://placeholder.invalid');
      expect(url.origin, label).toBe('http://placeholder.invalid');
      expect(url.pathname, label).toBe(path);
      expect(url.searchParams.get('return_to'), label).toBe(returnTo);
    }
    expect(linkByLabel(html, 'Use email instead')).toBeDefined();
  });

  it('with neither configured, offers neither (the page is the #168 page)', async () => {
    unconfigureAll();
    const html = await (await get(query())).text();
    expect(linkByLabel(html, 'Continue with GitHub')).toBeDefined();
    expect(html).not.toContain('Continue with Google');
    expect(html).not.toContain('Continue with Apple');
    expect(html).not.toContain('/auth/google');
    expect(html).not.toContain('/auth/apple');
  });

  it('Google only: Apple is absent; Apple only: Google is absent', async () => {
    unconfigureAll(); configureGoogle();
    let html = await (await get(query())).text();
    expect(linkByLabel(html, 'Continue with Google')).toBeDefined();
    expect(html).not.toContain('Continue with Apple');
    unconfigureAll(); configureApple();
    html = await (await get(query())).text();
    expect(linkByLabel(html, 'Continue with Apple')).toBeDefined();
    expect(html).not.toContain('Continue with Google');
  });

  it.each([['GOOGLE_CLIENT_ID'], ['GOOGLE_CLIENT_SECRET']])('Google needs BOTH variables: %s unset hides it', async (missing) => {
    unconfigureAll();
    vi.stubEnv('GOOGLE_CLIENT_ID', 'g-id'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'g-secret'); vi.stubEnv(missing, '');
    const html = await (await get(query())).text();
    expect(html).not.toContain('Continue with Google');
  });

  it.each(APPLE_VARS.map((v) => [v]))('Apple needs ALL FOUR variables: %s unset hides it', async (missing) => {
    unconfigureAll(); configureApple(missing);
    const html = await (await get(query())).text();
    expect(html).not.toContain('Continue with Apple');
  });

  it('never prompts or offers providers outside the connector flow (explicit login_provider keeps its redirect)', async () => {
    configureGoogle(); configureApple();
    for (const p of ['github', 'google', 'apple']) {
      const res = await get(query({ login_provider: p }));
      expect(res.status, p).toBe(302);
      expect(res.headers.get('location'), p).toMatch(new RegExp(`^/auth/${p}\\?return_to=`));
    }
    const noResource = await get(query({ resource: undefined }));
    expect(noResource.status).toBe(302);
  });

  it('a hostile query still yields only server-local links, and each link round-trips the original URL exactly', async () => {
    configureGoogle(); configureApple();
    const q = query({ state: '//evil.example/&login_provider=email&return_to=https://evil.example' });
    const html = await (await get(q)).text();
    for (const label of ['Continue with GitHub', 'Continue with Google', 'Continue with Apple']) {
      const href = linkByLabel(html, label)!.href;
      expect(href.startsWith('/'), label).toBe(true);
      expect(href.startsWith('//'), label).toBe(false);
      expect(new URL(href, 'http://x.invalid').searchParams.get('return_to'), label).toBe(`/oauth/authorize?${q}`);
    }
    expect(isServerLocalPath(`/oauth/authorize?${q}`)).toBe(true);
  });

  it('following the Google and Apple links starts the provider flow and stores the authorize URL as the return path', async () => {
    configureGoogle(); configureApple();
    const q = query();
    const html = await (await get(q)).text();
    for (const [label, provider, host] of [['Continue with Google', 'google', 'accounts.google.com'], ['Continue with Apple', 'apple', 'appleid.apple.com']] as const) {
      const start = await fetch(new URL(linkByLabel(html, label)!.href, baseUrl), { redirect: 'manual' });
      expect(start.status, label).toBe(302);
      const to = new URL(start.headers.get('location')!);
      expect(to.host, label).toBe(host);
      const row = await db.pendingLoginState.findUnique({ where: { state: to.searchParams.get('state')! } });
      expect(row?.provider, label).toBe(provider);
      expect(row?.returnTo, label).toBe(`/oauth/authorize?${q}`);
    }
  });

  it('an escaped client name still reaches no markup on the extended page', async () => {
    configureGoogle(); configureApple();
    await db.oAuthClient.update({ where: { clientId }, data: { clientName: `<img src=x onerror=1>` } });
    const html = await (await get(query())).text();
    expect(html).not.toContain('<img src=x');
  });
});
