/**
 * #168 — GET /oauth/authorize shows a server-rendered sign-in prompt, not an
 * immediate provider redirect, ONLY for an MCP connector flow: no cookie,
 * `login_provider` omitted, and `resource` exactly `${origin}/mcp`
 * (Holger's scoped (b) ruling, 6378353067). Every other no-cookie request
 * keeps today's behavior. The discriminator is exact string equality, so each
 * near-miss is pinned to the unchanged 302.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { isServerLocalPath } from '../../auth/server-local-path.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

// Only the identity-provider boundary is synthetic. Login state, callback,
// JWT cookie and the authorize/consent handlers run locally for real (#2625).
// The mock is deliberately a FULL replacement, not an importOriginal partial
// (#2632): auth/github.ts has four runtime exports and every one is stubbed
// here, so a partial would add no isolation. It would only let a future
// network-calling export reach the real GitHub silently, where today it fails
// loudly as a missing export.
const githubFixture = vi.hoisted(() => ({
  exchangeCode: vi.fn(async () => 'synthetic-provider-token'),
  fetchUser: vi.fn(async () => ({id: 2625001, login: 'prompt-callback', name: 'Synthetic callback', avatar_url: ''})),
  checkOrgMembership: vi.fn(async () => true),
}));
vi.mock('../../auth/github.js', () => ({
  ...githubFixture,
  buildAuthUrl: (state: string) => `/synthetic/github?state=${encodeURIComponent(state)}`,
}));
// Decodes exactly the five forms the production escaper emits (escapeHtml in
// auth/oauth.ts), once, with &amp; last so an escaped entity is not decoded twice.
const htmlValue = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
interface Tag { attrs: Record<string, string>; inner: string }
// Attribute-order-independent element lookup. Values are decoded once here, so
// callers never re-decode.
function tagsOf(html: string, tag: 'a' | 'input'): Tag[] {
  const re = tag === 'a' ? /<a\b([^>]*)>([\s\S]*?)<\/a>/g : /<input\b([^>]*)>/g;
  return [...html.matchAll(re)].map(m => ({
    attrs: Object.fromEntries([...m[1].matchAll(/([a-zA-Z_:][\w:.-]*)="([^"]*)"/g)].map(a => [a[1], htmlValue(a[2])])),
    inner: m[2] ?? '',
  }));
}
// A missing element is a fixture/markup problem, so it fails with its own
// message instead of surfacing later as a misleading callback failure.
function requireValue<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined || value === '') throw new Error(`fixture: expected ${what}, found none`);
  return value;
}
function anchorHref(html: string, pick: (a: Tag) => boolean, what: string): string {
  return requireValue(tagsOf(html, 'a').find(pick)?.attrs.href, `${what} with an href`);
}
const signInHref = (html: string) => anchorHref(html, a => a.attrs.class === 'button', '<a class="button"> sign-in link');
const emailInsteadHref = (html: string) => anchorHref(html, a => a.inner.trim() === 'Use email instead', '"Use email instead" link');
const hiddenInputs = (html: string) =>
  Object.fromEntries(tagsOf(html, 'input').filter(i => i.attrs.type === 'hidden' && i.attrs.name).map(i => [i.attrs.name, i.attrs.value ?? '']));
const paramsOf = (params: URLSearchParams) => [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
function expectLocalAuthorizeLink(href: string, original: string) {
  expect(isServerLocalPath(href)).toBe(true);
  const url = new URL(href, baseUrl);
  expect(url.origin).toBe(baseUrl);
  expect(url.pathname).toBe('/oauth/authorize');
  expect(url.hash).toBe('');
  const expected = new URLSearchParams(original);
  expected.set('login_provider', 'email');
  expect(paramsOf(url.searchParams)).toEqual(paramsOf(expected));
}

let server: Server;
let baseUrl: string;
let port: number;
const REDIRECT = 'com.hadronmemory.ios://oauth/callback';
const clientId = `dcr_${'b'.repeat(32)}`;
let mcpResource: string;

beforeAll(async () => {
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  mcpResource = `${baseUrl}/mcp`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});
beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  await db.oAuthClient.create({ data: { clientId, clientName: 'Claude Desktop', redirectUris: [REDIRECT] } });
});

function query(overrides: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  const merged: Record<string, string | undefined> = {
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
    resource: mcpResource, state: 'opaque-state', ...overrides,
  };
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) params.set(k, v);
  return params.toString();
}
const get = (q: string, cookie?: string) =>
  fetch(`${baseUrl}/oauth/authorize?${q}`, { redirect: 'manual', headers: cookie ? { cookie } : undefined });
async function expectUnchangedRedirect(q: string) {
  const res = await get(q);
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toMatch(/^\/auth\/github\?return_to=/);
}

describe('sign-in prompt (no cookie, login_provider omitted, resource === origin/mcp)', () => {
  it('renders the prompt with the client name and a local GitHub sign-in link back to the same authorize URL', async () => {
    const q = query();
    const res = await get(q);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Claude Desktop');
    const target = new URL(signInHref(html), 'http://placeholder.invalid');
    expect(target.origin).toBe('http://placeholder.invalid');
    expect(target.pathname).toBe('/auth/github');
    expect(target.searchParams.get('return_to')).toBe(`/oauth/authorize?${q}`);
    expect(html).toContain('Continue with GitHub');
    expect(html).toContain('close this tab');
    expect(html).not.toContain('come back here');
  });

  it('offers "Use email instead": a local link to the same query with login_provider=email that reaches the email page', async () => {
    const q = query();
    const html = await (await get(q)).text();
    const emailHref = emailInsteadHref(html);
    expectLocalAuthorizeLink(emailHref, q);
    const page = await fetch(`${baseUrl}${emailHref}`, { redirect: 'manual' });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/oauth/authorize/email');
  });
});

// Walks prompt -> /auth/github -> synthetic provider and returns the minted callback state.
async function startPromptLogin(q: string) {
  const prompt = await get(q);
  expect(prompt.status).toBe(200);
  const html = await prompt.text();
  // Omission is already GitHub: label and actual start route must agree.
  expect(html).toContain('Continue with GitHub');
  const signIn = new URL(signInHref(html), baseUrl);
  expect(signIn.origin).toBe(baseUrl);
  expect(signIn.pathname).toBe('/auth/github');
  const expectedReturn = `/oauth/authorize?${q}`;
  expect(signIn.searchParams.get('return_to')).toBe(expectedReturn);
  const start = await fetch(signIn, {redirect: 'manual'});
  expect(start.status).toBe(302);
  const syntheticProvider = new URL(requireValue(start.headers.get('location'), 'a Location header on the sign-in start'), baseUrl);
  expect(syntheticProvider.origin).toBe(baseUrl);
  expect(syntheticProvider.pathname).toBe('/synthetic/github');
  return {expectedReturn, state: requireValue(syntheticProvider.searchParams.get('state'), 'a provider state')};
}
const callbackWith = (state: string) =>
  fetch(`${baseUrl}/auth/github/callback?${new URLSearchParams({code: 'synthetic-code', state})}`, {redirect: 'manual'});
const sessionCookie = (res: Response) => res.headers.getSetCookie().find(c => c.startsWith('hadron_token='))?.split(';')[0];

describe('#2625 local synthetic provider callback returns to consent', () => {
  it.each([undefined, 'account mcp'])('preserves all authorize parameters through GitHub callback (scope=%s)', async scope => {
    await db.user.create({data: {id: generateId(), handle: 'prompt-callback', githubUsername: 'prompt-callback', githubId: 2625001, roles: ['CONTRIBUTOR']}});
    const q = query({scope, state: 'opaque &state=other?return_to=//evil.example/#fragment'});
    const {expectedReturn, state: callbackState} = await startPromptLogin(q);
    const callback = await callbackWith(callbackState);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(expectedReturn);
    expect(githubFixture.exchangeCode).toHaveBeenCalledExactlyOnceWith('synthetic-code');
    expect(githubFixture.fetchUser).toHaveBeenCalledExactlyOnceWith('synthetic-provider-token');
    const cookie = requireValue(sessionCookie(callback), 'a hadron_token cookie on the callback');
    const consent = await fetch(new URL(requireValue(callback.headers.get('location'), 'a callback Location'), baseUrl), {redirect: 'manual', headers: {cookie}});
    expect(consent.status).toBe(200);
    const consentHtml = await consent.text();
    expect(consentHtml).toContain('Authorize Claude Desktop');
    expect(consentHtml).toContain('value="approve"');
    expect(consentHtml).not.toContain('Sign in to Hadron');
    const hidden = hiddenInputs(consentHtml);
    const original = new URLSearchParams(q);
    for (const key of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'resource']) expect(hidden[key], key).toBe(original.get(key));
    expect(requireValue(hidden.scope, 'a scope input').split(' ').sort()).toEqual((scope ?? 'mcp').split(' ').sort());
    expect(hidden._csrf).toBeTruthy();
    expect(hidden.grant_proof).toBeTruthy();
  });

  // Negative controls at the provider-callback boundary. Existing coverage
  // (durable-login-state.test.ts) pins the unknown-state 400 page and state
  // single-use at the claim level, and 025-auth-github-return-to.test.ts pins
  // the start route; neither follows a prompt-minted login through the
  // callback to the "no session, no provider call" outcome, and nothing
  // asserts the GITHUB_ORG membership refusal at all.
  describe('refused callbacks never authenticate', () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    it('an unknown/tampered state: 400, no provider call, no session, the real login survives', async () => {
      const {state} = await startPromptLogin(query());
      const tampered = `${state.slice(0, -1)}${state.endsWith('0') ? '1' : '0'}`;
      const res = await callbackWith(tampered);
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(sessionCookie(res)).toBeUndefined();
      expect(githubFixture.exchangeCode).not.toHaveBeenCalled();
      expect(githubFixture.fetchUser).not.toHaveBeenCalled();
      expect(await db.user.count()).toBe(0);
      // A wrong guess burns nothing: the genuine state is still claimable.
      expect(await db.pendingLoginState.findUnique({where: {state}})).not.toBeNull();
    });

    it('a replayed state is refused after its one successful use', async () => {
      const {state} = await startPromptLogin(query());
      expect((await callbackWith(state)).status).toBe(302);
      githubFixture.exchangeCode.mockClear();
      const replay = await callbackWith(state);
      expect(replay.status).toBe(400);
      expect(sessionCookie(replay)).toBeUndefined();
      expect(githubFixture.exchangeCode).not.toHaveBeenCalled();
    });

    it('GITHUB_ORG set and membership refused: 403, no session, no user provisioned, state consumed', async () => {
      vi.stubEnv('GITHUB_ORG', 'acme-required');
      githubFixture.checkOrgMembership.mockResolvedValueOnce(false);
      const {state} = await startPromptLogin(query());
      const res = await callbackWith(state);
      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
      expect(sessionCookie(res)).toBeUndefined();
      expect(githubFixture.checkOrgMembership).toHaveBeenCalledExactlyOnceWith('synthetic-provider-token', 'acme-required');
      expect(await db.user.count()).toBe(0);
      expect(await db.pendingLoginState.findUnique({where: {state}})).toBeNull();
    });

    it('GITHUB_ORG set and membership confirmed: the callback still sets a session and redirects to the authorize URL', async () => {
      vi.stubEnv('GITHUB_ORG', 'acme-required');
      const q = query();
      const {expectedReturn, state} = await startPromptLogin(q);
      const res = await callbackWith(state);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(expectedReturn);
      expect(sessionCookie(res)).toBeTruthy();
      expect(githubFixture.checkOrgMembership).toHaveBeenCalledExactlyOnceWith('synthetic-provider-token', 'acme-required');
    });
  });
});

describe('fixture HTML helpers fail with their own message', () => {
  it('accept any attribute order and decode the production escapes once', () => {
    const html = `<a href="/auth/github?a=1&amp;b=&amp;amp;" class="button">x</a><input value="v&quot;1&amp;quot;" name="n" type="hidden">`;
    expect(signInHref(html)).toBe('/auth/github?a=1&b=&amp;');
    // &amp;quot; is an escaped ampersand followed by 'quot;': decoding &amp; first would turn it into a quote.
    expect(hiddenInputs(html)).toEqual({n: 'v"1&quot;'});
  });
  it('a missing element is a fixture error, not a callback failure', () => {
    expect(() => signInHref('<p>no link</p>')).toThrow(/fixture: expected <a class="button"> sign-in link with an href/);
    expect(() => emailInsteadHref('<a class="button" href="/x">go</a>')).toThrow(/fixture: expected "Use email instead" link/);
  });
});

// Permanent hostile return-path controls (LOCAL P3, acceptance attach delta 1).
describe('hostile request targets never yield a non-local link', () => {
  it('encoded hostile state/query values round-trip exactly inside a local link', async () => {
    const q = query({ state: '//evil.example/&login_provider=email&return_to=https://evil.example' });
    const html = await (await get(q)).text();
    const href = signInHref(html);
    expect(href.startsWith('/auth/github?return_to=')).toBe(true);
    expect(new URL(href, 'http://x.invalid').searchParams.get('return_to')).toBe(`/oauth/authorize?${q}`);
    const email = emailInsteadHref(html);
    expectLocalAuthorizeLink(email, q);
    expect(new URL(email, baseUrl).searchParams.get('state')).toBe(new URLSearchParams(q).get('state'));
  });
  it('an absolute-form request line addressed to another origin still renders only local links, and its return_to fails isServerLocalPath', async () => {
    const q = query();
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(
        `GET http://evil.example/oauth/authorize?${q} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
      let data = '';
      socket.on('data', (d) => { data += d; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(raw.split('\r\n')[0]).toMatch(/ 200 /);
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    const hrefs = tagsOf(body, 'a').map((a) => requireValue(a.attrs.href, '<a> with an href'));
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of hrefs) expect(href.startsWith('/'), href).toBe(true);
    const signIn = requireValue(hrefs.find((h) => h.startsWith('/auth/github')), 'a /auth/github link');
    expect(isServerLocalPath(requireValue(new URL(signIn, 'http://x.invalid').searchParams.get('return_to'), 'a return_to value'))).toBe(false);
  });
});

describe('exclusions keep the immediate GitHub redirect', () => {
  const origin = () => baseUrl;
  it('resource missing (CLI default)', () => expectUnchangedRedirect(query({ resource: undefined })));
  it('resource not /mcp', () => expectUnchangedRedirect(query({ resource: `${origin()}/other` })));
  it('trailing slash', () => expectUnchangedRedirect(query({ resource: `${origin()}/mcp/` })));
  it('different path case', () => expectUnchangedRedirect(query({ resource: `${origin()}/MCP` })));
  it('different scheme case', () => expectUnchangedRedirect(query({ resource: `HTTP://127.0.0.1:${port}/mcp` })));
  it('different port', () => expectUnchangedRedirect(query({ resource: `http://127.0.0.1:${port + 1}/mcp` })));
  it('different host', () => expectUnchangedRedirect(query({ resource: `http://evil.example:${port}/mcp` })));
  it('suffix/prefix/embedded match', async () => {
    await expectUnchangedRedirect(query({ resource: `${origin()}/mcp?x=1` }));
    await expectUnchangedRedirect(query({ resource: `${origin()}/mcp#f` }));
    await expectUnchangedRedirect(query({ resource: `x${origin()}/mcp` }));
    await expectUnchangedRedirect(query({ resource: `https://hadron.example/?r=${origin()}/mcp` }));
  });
  it('explicit login_provider=github, even with the exact resource', () => expectUnchangedRedirect(query({ login_provider: 'github' })));
  it('empty login_provider is not "omitted"', async () => {
    const res = await get(query({ login_provider: '' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).not.toBeNull();
  });
  it('repeated resource still 400s unchanged', async () => {
    const res = await get(`${query({ resource: undefined })}&resource=${encodeURIComponent(mcpResource)}&resource=${encodeURIComponent(mcpResource)}`);
    expect(res.status).toBe(400);
  });
  it('no resolvable server origin (no Host header) never prompts', async () => {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(`GET /oauth/authorize?${query({ resource: 'null/mcp' })} HTTP/1.0\r\n\r\n`));
      let data = '';
      socket.on('data', (d) => { data += d; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(raw).not.toMatch(/Sign in to Hadron/i);
    expect(raw.split('\r\n')[0]).toMatch(/ 302 /);
  });
});

describe('unchanged paths', () => {
  it('login_provider=email still renders the email entry page', async () => {
    const res = await get(query({ login_provider: 'email' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/oauth/authorize/email');
  });
  it('invalid client_id keeps the 400 with no prompt', async () => {
    const res = await get(query({ client_id: `dcr_${'z'.repeat(32)}` }));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/Sign in to Hadron/i);
  });
  it('unregistered redirect_uri keeps the 400 with no prompt', async () => {
    const res = await get(query({ redirect_uri: 'https://evil.example/cb' }));
    expect(res.status).toBe(400);
  });
  it('invalid login_provider keeps the OAuth error redirect', async () => {
    const res = await get(query({ login_provider: 'nope' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^com\.hadronmemory\.ios:\/\/oauth\/callback\?.*error=invalid_request/);
  });
  it('a valid cookie skips the prompt and reaches consent', async () => {
    const user = await db.user.create({ data: { id: generateId(), handle: 'carol', githubUsername: 'carol', roles: ['CONTRIBUTOR'] } });
    const jwt = await signJwt({ sub: user.id, roles: ['CONTRIBUTOR'] });
    const res = await get(query(), `hadron_token=${jwt}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toMatch(/Sign in to Hadron/i);
    expect(html).toMatch(/Approve/i);
  });
});

describe('attacker-controlled client_name', () => {
  it('is escaped; no raw markup reaches the page', async () => {
    const evil = `<script>alert("x")</script> & 'q' <img src=x onerror=1>`;
    await db.oAuthClient.update({ where: { clientId }, data: { clientName: evil } });
    const res = await get(query());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
  });
});
