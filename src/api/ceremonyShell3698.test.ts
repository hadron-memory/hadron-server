/**
 * #3698 slice 1 of #3682: one shared ceremony shell for every server-hosted ceremony page (lang, color-scheme, one
 * stylesheet, 2.75rem targets, focus ring, narrow-screen stacking), the sign-in pages' CSP gaining exactly
 * `style-src 'unsafe-inline'`, and a rate-limited GET of the signing page answering a small HTML 429. No visible copy
 * changes: each page's visible text is pinned to what main served before the change.
 */
import { createHash } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { generateId } from '../lib/id.js';
import { page, PAGE_HEADERS, sendPage } from './ceremonyPages.js';
import { CEREMONY_SCRIPT_PATH } from './ceremonyClientPages.js';
import { SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE } from './signingCeremonyRoutes.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
let server: Server | undefined;
let base: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

/** What a person reads: head, style, script and tags removed, whitespace collapsed. */
const visibleText = (html: string) => html
  .replace(/<head>[\s\S]*?<\/head>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Captured from main before the change (the same strings are asserted green there).
const TEXT = {
  assert: "Confirm it's you Use your passkey to finish signing in. Use passkey",
  enroll: 'Add a passkey to finish signing in This account has no passkey yet. Add one, then come back to this page to sign in with it. You will confirm who you are once more, with a second link we email you, in this browser. Add a passkey',
  invalid: "This sign-in link can't be used It may have expired or already been used. Start again from the sign-in page.",
  signing: 'Review and sign This page needs JavaScript to ask for your passkey. Turn it on and reload. To see what you have been asked to sign, confirm it is you with your passkey. Nothing is shown until you do. Use passkey',
};
const SIGN_IN_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TOO_MANY = 'Too many requests. Wait a minute, then reload this page.';

async function pendingCookie(email: string): Promise<string> {
  const token = generateId() + generateId();
  await db.emailVerificationToken.create({ data: { email, token, expiresAt: new Date(Date.now() + 600_000), clientStateHash: sha('portal-nonce') } });
  const r = await fetch(`${base}/auth/email/verify?token=${token}`, { redirect: 'manual' });
  const c = (r.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]!).find((x) => x.startsWith('hadron_pending_signin='));
  expect(c).toBeTruthy();
  return c!;
}

async function servedPages() {
  const withKey = await db.user.create({ data: { email: 'shell-key@example.test', handle: 'shell-key', roles: ['READER'] } });
  await insertSoftPasskey(db, withKey.id, softPasskey());
  await db.user.create({ data: { email: 'shell-nokey@example.test', handle: 'shell-nokey', roles: ['READER'] } });
  const get = (cookie?: string) => fetch(`${base}/auth/passkey/sign-in`, { headers: cookie ? { cookie } : {} });
  const assert = await get(await pendingCookie('shell-key@example.test'));
  const enroll = await get(await pendingCookie('shell-nokey@example.test'));
  const invalid = await get();
  const signing = await fetch(`${base}/signing/${'a'.repeat(26)}`);
  return { assert, enroll, invalid, signing };
}

describe('the shared shell is on every ceremony page', () => {
  it('serves the four sign-in and signing pages with lang, color-scheme and exactly one stylesheet', async () => {
    const pages = await servedPages();
    expect([pages.assert.status, pages.enroll.status, pages.invalid.status, pages.signing.status]).toEqual([200, 200, 400, 200]);
    for (const [name, res] of Object.entries(pages)) {
      const html = await res.text();
      expect(html, name).toContain('<html lang="en">');
      expect(html, name).toContain('<meta name="color-scheme" content="light dark">');
      expect(html.match(/<style[ >]/g)?.length, name).toBe(1);
      expect(html, name).toContain('min-height:2.75rem');
      expect(html, name).toContain(':focus-visible');
      expect(html, name).toMatch(/@media\s*\(max-width:480px\)/);
    }
  });

  it('the page() shell used by the register, remove and end-window pages has them too, and no inline style attribute', () => {
    const html = page('Remove this passkey', '<h1>Remove this passkey?</h1><p>Sure?</p><button type="submit">Remove</button>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html.match(/<style[ >]/g)?.length).toBe(1);
    expect(html).toContain('min-height:2.75rem');
    expect(html).toContain(':focus-visible');
    expect(html).toMatch(/@media\s*\(max-width:480px\)/);
    expect(html).not.toContain('style="');
    expect(html).toContain('<title>Remove this passkey</title>');
  });

  it('keeps a 1rem gutter either side of the card on a narrow screen (Charles, #3703)', () => {
    // The card is the <main>; a bare max-width with auto margins sits flush with the viewport edge under ~546px.
    const html = page('T', '<p>x</p>');
    expect(html).toContain('width:min(32rem,calc(100% - 2rem))');
    expect(html).toContain('main.wide{width:min(44rem,calc(100% - 2rem))}');
    expect(html).not.toMatch(/main\{[^}]*max-width/);
  });

  it('sendPage still sends the ceremony headers', () => {
    const sent: { status?: number; headers?: Record<string, string>; body?: string } = {};
    const res: any = {
      status(s: number) { sent.status = s; return this; }, set(h: Record<string, string>) { sent.headers = h; return this; },
      type() { return this; }, send(b: string) { sent.body = b; return this; },
    };
    sendPage(res, 200, 'T', '<p>x</p>');
    expect(sent.headers).toEqual(PAGE_HEADERS);
    expect(sent.body).toContain('<html lang="en">');
  });
});

describe('copy is unchanged (no visible text moves)', () => {
  it('each served page reads exactly what main served', async () => {
    const pages = await servedPages();
    expect(visibleText(await pages.assert.text())).toBe(TEXT.assert);
    expect(visibleText(await pages.enroll.text())).toBe(TEXT.enroll);
    expect(visibleText(await pages.invalid.text())).toBe(TEXT.invalid);
    expect(visibleText(await pages.signing.text())).toBe(TEXT.signing);
  });

  it('page() shows its body and nothing else', () => {
    expect(visibleText(page('Title', '<h1>Heading</h1><p>Body text.</p>'))).toBe('Heading Body text.');
  });
});

describe('the sign-in pages CSP gains exactly style-src', () => {
  it('is today\'s string plus style-src \'unsafe-inline\', as an exact string, on all three pages', async () => {
    const pages = await servedPages();
    for (const res of [pages.assert, pages.enroll, pages.invalid]) {
      expect(res.headers.get('content-security-policy')).toBe(SIGN_IN_CSP);
    }
  });

  // The red control is a mutant, not arithmetic: dropping the directive from the production string fails the exact pin above.
});

describe('a rate-limited GET of the signing page answers a small HTML page', () => {
  const id = 'b'.repeat(26);

  it('GET beyond the limit: 429, HTML, the sentence, the ceremony headers, and nothing about the request', async () => {
    for (let i = 0; i < SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE; i++) expect((await fetch(`${base}/signing/${id}`)).status).toBe(200);
    const limited = await fetch(`${base}/signing/${id}`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('content-type')).toMatch(/text\/html/);
    const html = await limited.text();
    expect(visibleText(html)).toContain(TOO_MANY);
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain(id);
    for (const [k, v] of Object.entries({ 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' })) {
      expect(limited.headers.get(k)).toBe(v);
    }
    expect(limited.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(limited.headers.get('retry-after')).toBe('60');
    // Same page for a different id once the per-IP window is spent.
    expect(await (await fetch(`${base}/signing/${'c'.repeat(26)}`)).text()).toBe(html);
  });

  it('POST beyond the limit: 429 with an empty body, as before', async () => {
    const post = () => fetch(`${base}/signing/${id}/proof/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' });
    for (let i = 0; i < SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE; i++) await post();
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('');
  });

  it('the script GET beyond the limit keeps the empty 429 the page script maps', async () => {
    for (let i = 0; i < SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE; i++) await fetch(`${base}/signing/ceremony.js`);
    const limited = await fetch(`${base}/signing/ceremony.js`);
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('');
  });
});

describe('the shell keeps what the page scripts depend on (Dorian P2-1, #3703)', () => {
  // A bounded start-tag matcher: each opening tag ends at its own `>`, so two nested mains count as two.
  const mains = (html: string) => html.match(/<main(?=[\s>])[^>]*>/g) ?? [];

  it('the matcher counts nested mains separately (a nested-main regression cannot hide as one match)', () => {
    expect(mains('<main><main data-page="window"><p>x</p></main></main>')).toHaveLength(2);
    expect(mains('<main class="wide"><mainly>x</mainly></main>')).toHaveLength(1);
  });

  it.each(['/passkeys/register', '/passkeys/window/end', '/passkeys/revoke'])('%s serves exactly one main, and it is the one carrying data-page', async (path) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    const found = mains(await res.text());
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('data-page=');
  });

  it('the served client script still reads its page metadata from the first main', async () => {
    const js = await (await fetch(`${base}${CEREMONY_SCRIPT_PATH}`)).text();
    expect(js).toContain("document.querySelector('main')");
  });

  it('page() wraps a main-less body in one main and leaves a body with its own main alone', () => {
    expect(mains(page('T', '<h1>x</h1>'))).toHaveLength(1);
    const own = page('T', '<main data-page="window"><p>x</p></main>');
    expect(mains(own)).toEqual(['<main data-page="window">']);
  });
});

describe('script aliases keep the empty 429 (Dorian P2-2, #3703)', () => {
  it('/signing/CEREMONY.JS and /signing/ceremony.js/ answer the script route, and past the limit the empty 429', async () => {
    expect((await fetch(`${base}/signing/CEREMONY.JS`)).status).toBe(200);
    expect((await fetch(`${base}/signing/ceremony.js/`)).status).toBe(200);
    for (let i = 0; i < SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE; i++) await fetch(`${base}/signing/ceremony.js`);
    for (const path of ['/signing/CEREMONY.JS', '/signing/ceremony.js/', '/signing/ceremony.js']) {
      const limited = await fetch(`${base}${path}`);
      expect(limited.status, path).toBe(429);
      expect(await limited.text(), path).toBe('');
    }
  });
});

describe('wiring the BLIND seat asked to see (#3703)', () => {
  it('the signing page still loads its script, and the client pages allow the inline stylesheet', async () => {
    expect(await (await fetch(`${base}/signing/${'a'.repeat(26)}`)).text()).toContain('<script src="/signing/ceremony.js"></script>');
    for (const path of ['/passkeys/register', '/passkeys/window/end', '/passkeys/revoke']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('content-security-policy'), path).toContain("style-src 'unsafe-inline'");
      expect(await res.text(), path).toContain('<style>');
    }
  });

  it('the title is text: markup in it is escaped', () => {
    const html = page('A <b>&</b> "q"', '<p>x</p>');
    expect(html).toContain('<title>A &lt;b&gt;&amp;&lt;/b&gt; &quot;q&quot;</title>');
    expect(html).not.toContain('<b>');
  });
});
