/**
 * #5125 (hrn:node:hadronmemory.com:specs:cor:aut:030:01) — the code-entry completion of the authorization flow: an
 * authorize request may ask for a page that shows the code after consent instead of the redirect, and a pending
 * authorization is dead after five wrong entries. Numbers in the titles are the issue's acceptance items.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { parseHTML } from 'linkedom';
import { Client } from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { waitForLockWaiters } from '../lockWait.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../startServerFixture.js';

let server: Server;
let baseUrl: string;
let userId: string;
let cookie: string;
const REDIRECT = 'http://127.0.0.1:8765/callback';
const OTHER_REDIRECT = 'http://127.0.0.1:8766/callback';
const RESOURCE = 'https://hadron.example/mcp';
const CLIENT = `dcr_${'c'.repeat(32)}`;
const OTHER_CLIENT = `dcr_${'d'.repeat(32)}`;
const PAGE = { code_delivery: 'page' };
const GENERIC = { error: 'invalid_grant', error_description: 'code is unknown' };

beforeAll(async () => {
  server = createHttpServer(await createServerOnCleanDb());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(server); });

async function signedIn(handle: string) {
  const user = await db.user.create({ data: { id: generateId(), handle, githubUsername: handle, roles: ['CONTRIBUTOR'] } });
  return { id: user.id, cookie: `hadron_token=${await signJwt({ sub: user.id, roles: ['CONTRIBUTOR'] })}` };
}
beforeEach(async () => {
  await cleanDb(db);
  for (const clientId of [CLIENT, OTHER_CLIENT]) {
    await db.oAuthClient.create({ data: { clientId, clientName: 'Code <Entry> CLI', redirectUris: [REDIRECT, OTHER_REDIRECT] } });
  }
  ({ id: userId, cookie } = await signedIn('codeentry'));
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
type Params = Record<string, string>;
function authorize(extra: Params, challenge: string, headers: Params = { cookie }) {
  const p = new URLSearchParams({
    response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', resource: RESOURCE, state: 'st8', ...extra,
  });
  return fetch(`${baseUrl}/oauth/authorize?${p}`, { redirect: 'manual', headers });
}
/** Consent GET, then POST exactly the form's own hidden fields (what a browser sends), with overrides. */
async function consent(extra: Params, challenge: string, over: Params = {}, as = cookie, drop: string[] = []) {
  const res = await authorize(extra, challenge, { cookie: as });
  expect(res.status).toBe(200);
  const html = await res.text();
  const fields: Params = { decision: 'approve' };
  for (const input of parseHTML(html).document.querySelectorAll('form input[type="hidden"]')) {
    fields[input.getAttribute('name')!] = input.getAttribute('value') ?? '';
  }
  Object.assign(fields, over);
  for (const d of drop) delete fields[d];
  const csrf = res.headers.get('set-cookie')!.match(/_hadron_csrf=([^;]+)/)![1];
  const post = await fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${as}; _hadron_csrf=${csrf}` },
    body: new URLSearchParams(fields).toString(),
  });
  return { html, post };
}
const shownCode = (html: string) => parseHTML(html).document.querySelector('#code')?.textContent ?? '';
/** A pending authorization finished through the code page. */
async function pending(as = cookie) {
  const { verifier, challenge } = pkce();
  const { post } = await consent(PAGE, challenge, {}, as);
  expect(post.status).toBe(200);
  const code = shownCode(await post.text());
  expect(code).toMatch(/^[0-9a-f]{16}\.[0-9a-f]{64}$/);
  return { code, verifier };
}
type Pending = { code: string; verifier: string };
async function redeem({ code, verifier }: Pending, over: Params = {}) {
  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: CLIENT, redirect_uri: REDIRECT,
      code_verifier: verifier, resource: RESOURCE, ...over,
    }).toString(),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const wrong = (p: Pending): Pending => ({ ...p, code: `${p.code.split('.')[0]}.${randomBytes(32).toString('hex')}` });
const rowOf = (p: Pending) =>
  db.authCode.findUniqueOrThrow({ where: { codeHash: createHash('sha256').update(p.code).digest('hex') } });
async function refused(r: ReturnType<typeof redeem>) {
  expect(await r).toEqual({ status: 400, body: GENERIC });
}

describe('#5125 authorize', () => {
  it.each([{}, { code_delivery: '' }])('1: without the parameter (%j) the approval redirects with code and state, and the form has no new field', async (extra) => {
    const { html, post } = await consent(extra as Params, pkce().challenge);
    expect(html).not.toContain('code_delivery');
    expect(post.status).toBe(302);
    const u = new URL(post.headers.get('location')!);
    expect(`${u.origin}${u.pathname}`).toBe(REDIRECT);
    expect(u.searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('state')).toBe('st8');
  });

  it('2: with it, approval answers 200 with the code and a copy control, no redirect, on the same grant row', async () => {
    const { challenge } = pkce();
    const before = Date.now();
    const { html, post } = await consent(PAGE, challenge);
    expect(parseHTML(html).document.querySelector('#code')).toBeNull(); // nothing shown before consent
    expect(post.status).toBe(200);
    expect(post.headers.get('location')).toBeNull();
    expect(post.headers.get('cache-control')).toBe('no-store');
    expect(post.headers.get('referrer-policy')).toBe('no-referrer');
    expect(post.headers.get('x-content-type-options')).toBe('nosniff');
    expect(post.headers.get('x-frame-options')).toBe('DENY');
    const page = await post.text();
    const { document } = parseHTML(page);
    const code = shownCode(page);
    expect(code).toMatch(/^[0-9a-f]{16}\.[0-9a-f]{64}$/);
    // A wrapping field shows the whole 81-character code on a phone; the button exists only for a reader with script.
    expect(document.querySelector('#code')!.tagName).toBe('TEXTAREA');
    expect(document.querySelector('#code')!.hasAttribute('readonly')).toBe(true);
    expect(document.querySelector('button#copy')!.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('script')!.textContent).toContain('copy.hidden = false');
    expect(page).toContain('Code &lt;Entry&gt; CLI');
    const nonce = document.querySelector('script')!.getAttribute('nonce')!;
    const csp = post.headers.get('content-security-policy')!;
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const row = await rowOf({ code, verifier: '' });
    expect(row).toMatchObject({
      clientId: CLIENT, userId, redirectUri: REDIRECT, codeChallenge: challenge, resource: [RESOURCE],
      oauthScopes: ['mcp'], redeemedAt: null,
    });
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(9.9 * 60_000);
    expect(ttl).toBeLessThan(10.2 * 60_000);
    expect(JSON.stringify(row)).not.toContain(code.split('.')[1]);
  });

  it('2: the code does not appear for a request that is not signed in; the parameter survives the sign-in bounce', async () => {
    const res = await authorize(PAGE, pkce().challenge, {});
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('code_delivery=page');
    expect(await db.authCode.count()).toBe(0);
  });

  it('deny never shows a code', async () => {
    const { post } = await consent(PAGE, pkce().challenge, { decision: 'deny' });
    expect(new URL(post.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(await db.authCode.count()).toBe(0);
  });

  it('the choice is part of the consented grant: adding or removing it on the form is refused, no code', async () => {
    const removed = await consent(PAGE, pkce().challenge, {}, cookie, ['code_delivery']);
    const added = await consent({}, pkce().challenge, PAGE);
    const junk = await consent(PAGE, pkce().challenge, { code_delivery: 'junk' });
    for (const { post } of [removed, added, junk]) {
      expect(post.status).toBe(302);
      expect(new URL(post.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    }
    expect(await db.authCode.count()).toBe(0);
  });

  it('an unsupported or repeated value is invalid_request, never a silent redirect login', async () => {
    const junk = await authorize({ code_delivery: 'junk' }, pkce().challenge);
    expect(junk.status).toBe(302);
    expect(new URL(junk.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    const p = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT,
      code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: RESOURCE });
    const twice = await fetch(`${baseUrl}/oauth/authorize?${p}&code_delivery=page&code_delivery=page`, { redirect: 'manual', headers: { cookie } });
    expect(twice.status).toBe(302);
    expect(new URL(twice.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('7: an invalid client or redirect_uri is the existing 400 and shows nothing', async () => {
    const bads: Params[] = [{ client_id: 'nope' }, { redirect_uri: 'https://evil.example/cb' }];
    for (const bad of bads) {
      const plain = await authorize(bad, pkce().challenge);
      const asked = await authorize({ ...PAGE, ...bad }, pkce().challenge);
      expect(asked.status).toBe(400);
      expect(await asked.text()).toBe(await plain.text());
    }
    expect(await db.authCode.count()).toBe(0);
  });
});

describe('#5125 entry', () => {
  it('3: the shown code returns the key once, then the generic refusal', async () => {
    const p = await pending();
    const ok = await redeem(p);
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toMatch(/^hdr_user_/);
    expect(await db.userApiKey.count()).toBe(1);
    await refused(redeem(p));
    expect(await db.userApiKey.count()).toBe(1);
  });

  it('3: neither half of the code redeems on its own', async () => {
    const p = await pending();
    await refused(redeem({ ...p, code: p.code.split('.')[1] }));
    await refused(redeem({ ...p, code: p.code.split('.')[0] }));
    expect((await redeem(p)).status).toBe(200);
  });

  it.each([
    ['wrong verifier', { code_verifier: 'x'.repeat(43) }],
    ['malformed verifier', { code_verifier: 'x' }],
    ['wrong redirect_uri', { redirect_uri: OTHER_REDIRECT }],
    ["other client's", { client_id: OTHER_CLIENT }],
    ['wrong resource', { resource: 'https://other.example/mcp' }],
  ])('4: %s is the one generic refusal and ends the code', async (_n, over) => {
    const p = await pending();
    await refused(redeem(p, over as Params));
    await refused(redeem(p));
  });

  it('4: a repeated resource is the same generic refusal (it would otherwise confirm the code)', async () => {
    const p = await pending();
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `${new URLSearchParams({ grant_type: 'authorization_code', code: p.code, client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: p.verifier })}&resource=a&resource=b`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(GENERIC);
  });

  it('4: a wrong secret, an unknown handle and an expired code are the same refusal', async () => {
    const p = await pending();
    await refused(redeem(wrong(p)));
    await refused(redeem({ ...p, code: `${'0'.repeat(16)}.${p.code.split('.')[1]}` }));
    await db.$executeRaw`UPDATE auth_codes SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'`;
    await refused(redeem(p));
  });

  it('4: expiry is judged by the database clock once the row is held, with the same refusal', async () => {
    const p = await pending();
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM auth_codes FOR UPDATE');
      const r = redeem(p);
      await waitForLockWaiters(db, 1);
      await blocker.query("UPDATE auth_codes SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'");
      await blocker.query('COMMIT');
      await refused(r);
    } finally { await blocker.end(); }
  });

  it('a redirect-delivered code keeps its own descriptions (unchanged)', async () => {
    const { verifier, challenge } = pkce();
    const { post } = await consent({}, challenge);
    const code = new URL(post.headers.get('location')!).searchParams.get('code')!;
    expect((await redeem({ code, verifier }, { redirect_uri: OTHER_REDIRECT })).body.error_description)
      .toBe('redirect_uri does not match the authorization code');
  });
});

describe('#5125 five wrong entries', () => {
  it('5: four wrong then the right code succeeds', async () => {
    const p = await pending();
    for (let i = 0; i < 4; i++) await refused(redeem(wrong(p)));
    expect((await rowOf(p)).entryFailures).toBe(4);
    expect((await redeem(p)).status).toBe(200);
  });

  it('5: five wrong kill it for the right code; a new login starts clean', async () => {
    const p = await pending();
    for (let i = 0; i < 5; i++) await refused(redeem(wrong(p)));
    await refused(redeem(p));
    expect(await db.userApiKey.count()).toBe(0);
    expect((await redeem(await pending())).status).toBe(200);
  });

  it('5: a wrong entry is any other secret behind the handle, whatever its shape', async () => {
    const p = await pending();
    const [handle, secret] = p.code.split('.');
    for (const bad of ['', secret.slice(1), `${secret}0`, secret.toUpperCase() === secret ? 'z' : secret.toUpperCase(), 'x y']) {
      await refused(redeem({ ...p, code: `${handle}.${bad}` }));
    }
    await refused(redeem(p));
  });

  it('5: five concurrent wrong entries count five, held at one lock, and no sixth attempt succeeds', async () => {
    const p = await pending();
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    const watcher = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([blocker.connect(), watcher.connect()]);
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM auth_codes FOR UPDATE');
      const all = Array.from({ length: 5 }, () => redeem(wrong(p)));
      // The test pool holds five connections and all five are waiting, so watch from one of our own.
      for (let waiting = 0; waiting < 5;) {
        waiting = (await watcher.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0].n;
        if (waiting < 5) await new Promise((done) => setTimeout(done, 20));
      }
      await blocker.query('COMMIT');
      for (const r of all) await refused(r);
    } finally { await Promise.all([blocker.end(), watcher.end()]); }
    expect((await rowOf(p)).entryFailures).toBe(5);
    await refused(redeem(p));
  });

  it('5: a right entry already waiting on the row when the fifth wrong entry lands is refused', async () => {
    const p = await pending();
    for (let i = 0; i < 4; i++) await refused(redeem(wrong(p)));
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM auth_codes FOR UPDATE');
      const fifth = redeem(wrong(p));
      await waitForLockWaiters(db, 1);
      const right = redeem(p);
      await waitForLockWaiters(db, 2);
      await blocker.query('COMMIT');
      await refused(fifth);
      await refused(right);
    } finally { await blocker.end(); }
    expect(await db.userApiKey.count()).toBe(0);
  });

  it('5: the dead state is in the row, marked as the previous image reads it, and the count stops at five', async () => {
    const p = await pending();
    for (let i = 0; i < 7; i++) await refused(redeem(wrong(p)));
    const row = await rowOf(p);
    expect(row.entryFailures).toBe(5);
    expect(row.redeemedAt).not.toBeNull();
  });

  it('5: wrong entries after a successful login or after expiry change nothing', async () => {
    const used = await pending();
    expect((await redeem(used)).status).toBe(200);
    const late = await pending();
    await db.authCode.updateMany({ where: { redeemedAt: null }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    for (const p of [used, late]) {
      await refused(redeem(wrong(p)));
      expect((await rowOf(p)).entryFailures).toBe(0);
    }
  });

  it("6: wrong entries on one pending authorization leave another user's, and the same user's other one, alone", async () => {
    const other = await signedIn('someoneelse');
    const [a, b, c] = [await pending(), await pending(other.cookie), await pending()];
    for (let i = 0; i < 5; i++) await refused(redeem(wrong(a)));
    await refused(redeem(a));
    expect((await redeem(b)).status).toBe(200);
    expect((await redeem(c)).status).toBe(200);
  });

  it('a redirect-delivered code has no handle and no counter', async () => {
    const { verifier, challenge } = pkce();
    const { post } = await consent({}, challenge);
    const code = new URL(post.headers.get('location')!).searchParams.get('code')!;
    for (let i = 0; i < 6; i++) await refused(redeem({ code: randomBytes(32).toString('hex'), verifier }));
    expect(await rowOf({ code, verifier })).toMatchObject({ entryHandle: null, entryFailures: 0 });
    expect((await redeem({ code, verifier })).status).toBe(200);
  });
});

describe('#5125 logging', () => {
  it('9: no log line carries the code, its handle or its secret', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((v) => inspect(v)).join(' ')); }));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { lines.push(String(s)); return true; });
    let p: Pending;
    try {
      p = await pending();
      await redeem(wrong(p));
      await redeem(p);
    } finally { out.mockRestore(); spies.forEach((s) => s.mockRestore()); }
    const all = lines.join('\n');
    expect(all).toContain('authcode_minted');
    for (const part of p.code.split('.')) expect(all).not.toContain(part);
  });
});
