/**
 * #3764 — the authorize flow returns a supplied `state` unchanged (RFC 6749 §4.1.2, §4.1.2.1).
 *
 * Before: a state over 512 characters was dropped silently and a code was still issued. Now the server accepts a
 * state up to OAUTH_STATE_MAX_LENGTH and echoes it byte for byte, and above that bound refuses with
 * `invalid_request` and NO code, echoing the supplied state exactly. Absent stays absent. Both legs (authorize GET
 * and consent POST) behave the same. States here are synthetic filler: no real code, token or state value.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';
import { STATE_MAX_LENGTH } from '../../auth/oauth.js';

let server: Server;
let baseUrl: string;
let cookie: string;
const REDIRECT = 'https://client.example.com/callback';
const RESOURCE = 'https://hadron.example/mcp';
const clientId = `dcr_${'b'.repeat(32)}`;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});
beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: { id: generateId(), handle: 'stateecho', githubUsername: 'stateecho', roles: ['CONTRIBUTOR'] } });
  await db.oAuthClient.create({ data: { clientId, clientName: 'State Echo Client', redirectUris: [REDIRECT] } });
  cookie = `hadron_token=${await signJwt({ sub: user.id, roles: ['CONTRIBUTOR'] })}`;
});

/** The accepted bound, imported so the boundary rows can never test a stale number. */
const OAUTH_STATE_MAX_LENGTH = STATE_MAX_LENGTH;
const CHALLENGE = 'a'.repeat(43);
// Characters that need URL-encoding in the redirect and escaping in the form, repeated to length.
const filler = (n: number) => 'sT%&=+ "<>\'/?#é'.repeat(Math.ceil(n / 14)).slice(0, n);

function query(extra: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  const all: Record<string, string | undefined> = {
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE,
    code_challenge_method: 'S256', resource: RESOURCE, ...extra,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) p.set(k, v);
  return p.toString();
}
const get = (extra: Record<string, string | undefined>) =>
  fetch(`${baseUrl}/oauth/authorize?${query(extra)}`, { redirect: 'manual', headers: { cookie } });

/** GET to the consent page, then POST the form's own fields back (decision=approve unless given). */
async function consentPost(state: string | undefined, decision = 'approve', formState?: string) {
  const res = await get({ state });
  expect(res.status).toBe(200);
  const html = await res.text();
  const csrf = html.match(/name="_csrf"\s+value="([^"]+)"/)![1];
  const proof = html.match(/name="grant_proof"\s+value="([^"]+)"/)![1];
  const csrfCookie = res.headers.get('set-cookie')!.match(/_hadron_csrf=([^;]+)/)![1];
  const fields: Record<string, string> = {
    _csrf: csrf, decision, client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE,
    code_challenge_method: 'S256', resource: RESOURCE, scope: 'mcp', grant_proof: proof,
  };
  // The honest path posts what the browser decodes from the page's hidden field, not the original string.
  const hidden = html.match(/name="state"\s+value="([^"]*)"/)?.[1];
  const posted = formState !== undefined ? formState : hidden === undefined ? undefined : htmlDecode(hidden);
  if (posted !== undefined) fields.state = posted;
  const post = await fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${cookie}; _hadron_csrf=${csrfCookie}` },
    body: new URLSearchParams(fields).toString(),
  });
  return { html, post };
}
/** What a browser does with an attribute value: decode the character references. `&amp;` goes last. */
const htmlDecode = (v: string) => v
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&amp;/g, '&');
const loc = (r: Response) => new URL(r.headers.get('location')!);
const authCodes = () => db.authCode.count();

describe('#3764 GET /oauth/authorize — a supplied state is returned unchanged', () => {
  it.each([16, 512, 513, 2048, OAUTH_STATE_MAX_LENGTH])('a %i-character state round-trips through consent and approve, byte for byte', async (n) => {
    const state = filler(n);
    const { html, post } = await consentPost(state);
    // The consent page carries it in the hidden field, HTML-escaped (the browser decodes it back).
    const field = html.match(/name="state"\s+value="([^"]*)"/)?.[1];
    expect(field).toBeDefined();
    expect(field).not.toMatch(/[<>"']/);
    expect(field).not.toMatch(/&amp;amp;|&amp;lt;|&amp;quot;|&amp;#39;/); // no double escaping
    expect(htmlDecode(field!)).toBe(state); // the browser's view of the field is the supplied state
    expect(post.status).toBe(302);
    const u = loc(post);
    expect(u.searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('state')).toBe(state);
    expect(await authCodes()).toBe(1);
  });

  it('an absent state stays absent on the consent POST redirect (no invented state)', async () => {
    const { post } = await consentPost(undefined);
    expect(post.status).toBe(302);
    expect(loc(post).searchParams.has('state')).toBe(false);
    expect(loc(post).searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a state over the bound is refused: invalid_request, state echoed exactly, no consent page, no code', async () => {
    const state = filler(OAUTH_STATE_MAX_LENGTH + 1);
    const res = await get({ state });
    expect(res.status).toBe(302);
    const u = loc(res);
    expect(`${u.origin}${u.pathname}`).toBe(REDIRECT);
    expect(u.searchParams.get('error')).toBe('invalid_request');
    expect(u.searchParams.get('state')).toBe(state);
    expect(u.searchParams.has('code')).toBe(false);
    expect(await authCodes()).toBe(0);
  });

  it('invalid response_type still echoes a supplied state and omits an absent one', async () => {
    const withState = loc(await get({ response_type: 'token', state: 'synthetic-state' }));
    expect(withState.searchParams.get('error')).toBe('invalid_request');
    expect(withState.searchParams.get('state')).toBe('synthetic-state');
    const without = loc(await get({ response_type: 'token', state: undefined }));
    expect(without.searchParams.has('state')).toBe(false);
  });
});

describe('#3764 POST /oauth/authorize (consent) — the same rules on the second leg', () => {
  it('a forged over-bound state in the form is refused: invalid_request, state echoed, no code', async () => {
    const forged = filler(OAUTH_STATE_MAX_LENGTH + 1);
    const { post } = await consentPost('short-state', 'approve', forged);
    expect(post.status).toBe(302);
    const u = loc(post);
    expect(u.searchParams.get('error')).toBe('invalid_request');
    expect(u.searchParams.get('state')).toBe(forged);
    expect(u.searchParams.has('code')).toBe(false);
    expect(await authCodes()).toBe(0);
  });

  it('deny at a long in-bound state echoes it with access_denied and no code', async () => {
    const state = filler(2048);
    const { post } = await consentPost(state, 'deny');
    const u = loc(post);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('state')).toBe(state);
    expect(await authCodes()).toBe(0);
  });
});

describe('#3764 review follow-ups (blind P2/P3, security P3)', () => {
  it('deny with a forged over-bound state is refused before any echo of the unbounded value', async () => {
    const forged = filler(OAUTH_STATE_MAX_LENGTH + 1);
    const { post } = await consentPost('short-state', 'deny', forged);
    const u = loc(post);
    expect(u.searchParams.get('error')).toBe('invalid_request');
    expect(u.searchParams.has('code')).toBe(false);
    expect(await authCodes()).toBe(0);
  });

  it('an in-bound state swapped between GET and POST fails the grant proof: no code', async () => {
    const { post } = await consentPost('state-A', 'approve', 'state-B');
    const u = loc(post);
    expect(u.searchParams.get('error')).toBe('invalid_request');
    expect(u.searchParams.get('state')).toBe('state-B');
    expect(await authCodes()).toBe(0);
  });

  it('an over-bound state with an UNREGISTERED redirect_uri never redirects', async () => {
    const res = await get({ state: filler(OAUTH_STATE_MAX_LENGTH + 1), redirect_uri: 'https://evil.example.com/cb' });
    expect(res.status).not.toBe(302);
    expect(res.headers.get('location')).toBeNull();
    expect(await authCodes()).toBe(0);
  });

  it('an over-bound state holding control characters refuses with a redirect, not a 500', async () => {
    const state = `a\r\nb\u0000${'x'.repeat(OAUTH_STATE_MAX_LENGTH)}`;
    const res = await get({ state });
    expect(res.status).toBe(302);
    expect(loc(res).searchParams.get('error')).toBe('invalid_request');
    expect(loc(res).searchParams.get('state')).toBe(state);
  });

  it('a repeated state parameter counts as absent: no state on the redirect, no error', async () => {
    const res = await fetch(`${baseUrl}/oauth/authorize?${query({})}&state=a&state=b`, { redirect: 'manual', headers: { cookie } });
    expect(res.status).toBe(200); // the consent page, i.e. not refused
    expect(await res.text()).not.toMatch(/name="state"\s+value="[^"]+"/);
  });
});
