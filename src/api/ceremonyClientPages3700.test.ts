/**
 * #3700 slice 3 of #3682 (R3-R6): the account check sits under the button that opened it, the remove list is one
 * row per passkey, the end-window preview names the provider by its display name, and each success state says what
 * happens next in text only. The page script runs against the served HTML in a linkedom document.
 */
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';

let server: Server | undefined;
let base: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', 'example.test');
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', 'https://sign.example.test');
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_ID', 'gh-client');
  vi.stubEnv('GITHUB_OAUTH_APP_CLIENT_SECRET', 'gh-secret');
  vi.stubEnv('GITHUB_ORG', '');
  server = httpServer(await createServer());
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

const get = async (path: string) => (await fetch(`${base}${path}`)).text();
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

/** Serve a page, run its script in a DOM built from it; `answers` are the fetch replies in order. */
async function load(path: string, answers: Array<{ status?: number; body?: unknown }>) {
  const html = await get(path);
  const { document, window } = parseHTML(html);
  const queue = structuredClone(answers); // the script mutates the options it is given
  const calls: Array<{ path: string; method?: string; body: unknown }> = [];
  const fetchFake = async (path: string, init?: { body?: string; method?: string }) => {
    calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    const a = queue.shift() ?? { status: 500 }; const status = a.status ?? 200; return { ok: status < 300, status, json: async () => a.body };
  };
  const assertion = { rawId: new Uint8Array([1]), response: { authenticatorData: new Uint8Array([1]), clientDataJSON: new Uint8Array([1]), signature: new Uint8Array([1]) } };
  const script = await get('/passkeys/assets/ceremony.js');
  runInNewContext(script, {
    document, window: Object.assign(window, { confirm: () => true }), fetch: fetchFake,
    navigator: { credentials: { get: async () => assertion, create: async () => ({ id: 'x', rawId: new Uint8Array([1]), type: 'public-key', response: { clientDataJSON: new Uint8Array([1]), attestationObject: new Uint8Array([1]) }, getClientExtensionResults: () => ({}) }) } },
    btoa, atob, Uint8Array, JSON, Error, Date, Promise, Array,
  });
  const click = (id: string) => document.getElementById(id)!.dispatchEvent(new window.Event('click'));
  return { html, document, click, calls, unconsumed: () => queue.length };
}

const options = { account: { handle: 'ana' }, publicKey: { challenge: 'AA', user: { id: 'AA' }, excludeCredentials: [] } };

describe('R3: the account check follows the button that opened it', () => {
  it('is served directly under the add button, not after "Already have a passkey?"', async () => {
    const { document } = await load('/passkeys/register', []);
    const box = document.getElementById('account-check')!;
    expect(document.getElementById('add-first')!.nextElementSibling).toBe(box);
    expect(document.getElementById('add-later')!.nextElementSibling).toBeNull();
  });

  it.each([['add-first', [{ body: { ceremonyId: 'c', challenge: 'AA' } }, { body: options }]],
    ['add-later', [{ body: { ceremonyId: 'c', challenge: 'AA' } }, { body: options }]]] as const)('after %s it is that button\'s next sibling and shows the account', async (id, answers) => {
    const { document, click } = await load('/passkeys/register', [...answers]);
    click(id);
    await flush();
    const box = document.getElementById('account-check')!;
    expect(document.getElementById(id)!.nextElementSibling).toBe(box);
    expect(box.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('account')!.textContent).toContain('@ana');
  });
});

describe('R3 (BLIND P2): a second attempt cannot move the pending account check', () => {
  it('ignores the other opener while one confirmation is pending, and allows a new attempt after stop', async () => {
    const { document, click, calls } = await load('/passkeys/register', [
      { body: { ceremonyId: 'c', challenge: 'AA' } }, { body: options }, { body: {} }]);
    click('add-first');
    await flush();
    const box = document.getElementById('account-check')!;
    expect(document.getElementById('add-first')!.nextElementSibling).toBe(box);
    const before = calls.length;
    click('add-later');
    await flush();
    expect(calls.length).toBe(before); // no second request
    expect(document.getElementById('add-first')!.nextElementSibling).toBe(box);
    expect(document.getElementById('add-later')!.nextElementSibling).toBeNull();
    // Stop ends the attempt; a later attempt is allowed again.
    document.getElementById('stop-account')!.dispatchEvent(new (document.defaultView as any).Event('click'));
    await flush();
    expect(document.getElementById('status-first')!.textContent).toContain('Stopped');
  });

  it.each([['success', [{ body: { ceremonyId: 'c1', challenge: 'AA' } }, { body: options }, { body: { kind: 'later' } }], true],
    ['a refused start', [{ body: { ceremonyId: 'c1', challenge: 'AA' } }, { status: 403 }], false]] as const)('the guard resets after %s, so the next attempt runs', async (_label, first, confirm) => {
    const { document, click, calls } = await load('/passkeys/register', [...first,
      { body: { ceremonyId: 'c2', challenge: 'AA' } }, { body: options }]);
    click('add-later');
    await flush();
    if (confirm) { document.getElementById('confirm-account')!.dispatchEvent(new (document.defaultView as any).Event('click')); await flush(); }
    const before = calls.length;
    click('add-first');
    await flush();
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.slice(before)[0]).toMatchObject({ path: '/passkeys/register/challenge', method: 'POST' });
  });

  it('a new attempt after stop is accepted and runs its own requests', async () => {
    const { document, click, calls } = await load('/passkeys/register', [
      { body: { ceremonyId: 'c1', challenge: 'AA' } }, { body: options }, { body: {} },
      { body: { ceremonyId: 'c2', challenge: 'AA' } }, { body: options }]);
    click('add-first');
    await flush();
    document.getElementById('stop-account')!.dispatchEvent(new (document.defaultView as any).Event('click'));
    await flush();
    const before = calls.length;
    click('add-later');
    await flush();
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.slice(before)[0]).toMatchObject({ path: '/passkeys/register/challenge', method: 'POST' });
    expect(document.getElementById('add-later')!.nextElementSibling).toBe(document.getElementById('account-check'));
  });
});

describe('R4: one row per passkey', () => {
  const list = [
    { label: 'Laptop', credentialId: 'a', registeredAt: '2026-11-01T10:00:00Z', revokedAt: null, inWindow: false, prover: false, cancel: null },
    { label: 'Old phone', credentialId: 'b', registeredAt: '2026-10-01T10:00:00Z', revokedAt: '2026-10-05T10:00:00Z', inWindow: false, prover: false,
      cancel: { at: '2026-10-05T10:00:00Z', ip: '203.0.113.9', userAgent: 'TestAgent/1' } },
    { label: 'Key', credentialId: 'c', registeredAt: '2026-09-01T10:00:00Z', revokedAt: null, inWindow: false, prover: true, cancel: null },
  ];

  it('lists active first, then a sub-heading with the removed and prover entries; Remove only on active; details closed', async () => {
    const { document, click } = await load('/passkeys/revoke', [{ body: { ceremonyId: 'c', challenge: 'AA' } }, { body: { passkeys: list } }]);
    click('revoke-passkey');
    await flush();
    const box = document.getElementById('passkey-list')!;
    const kids = [...box.children].map((c: { tagName: string }) => c.tagName);
    expect(kids).toEqual(['UL', 'H3', 'UL']);
    expect(box.querySelector('h3')!.textContent).toContain('Removed');
    const [first, second] = [...box.querySelectorAll('ul')];
    expect(first.querySelectorAll('li').length).toBe(1);
    expect(second.querySelectorAll('li').length).toBe(2);
    expect(box.querySelectorAll('button').length).toBe(1);
    expect(first.querySelectorAll('button').length).toBe(1);
    expect(first.textContent).toContain('Active');
    expect(second.textContent).toContain('Removed');
    expect(second.textContent).toContain('In use');
    const details = box.querySelectorAll('details');
    expect(details.length).toBe(1);
    expect(details[0].hasAttribute('open')).toBe(false);
    expect(details[0].textContent).toContain('203.0.113.9');
    expect(details[0].textContent).toContain('TestAgent/1');
    expect(first.textContent).not.toContain('203.0.113.9');
    expect(box.textContent).not.toMatch(/:\d\d:\d\d/); // no seconds
  });
});

describe('R5: the end-window preview', () => {
  it.each([['github', 'GitHub'], ['google', 'Google'], ['apple', 'Apple'], ['email', 'an email link']])('names %s as %s, in capitalised sentences', async (method, shown) => {
    const { document, click } = await load('/passkeys/window/end', [{ body: { label: 'Laptop', registeredAt: '2026-11-01T10:00:00Z', method } }]);
    click('end-window');
    await flush();
    const text = document.getElementById('window-passkey')!.textContent as string;
    expect(text).toContain(`after confirming with ${shown}`);
    if (method !== 'email') expect(text).not.toContain(method);
    expect(text).toMatch(/^[A-Z]/);
    // Two sentences, asserted as two fixed pieces so the host locale's date format cannot change the count.
    expect(text).toContain('Ending its cooling-off window makes anything it signed count as signed by you, so continue only if you added it.');
    expect(text).toMatch(/^The passkey "Laptop" was added on .+ after confirming with /);
  });
});

describe('R6: success states say what happens next, in text', () => {
  const finishFirst = [{ body: { ceremonyId: 'c', challenge: 'AA' } }, { body: options }, { body: { kind: 'first' } }];
  it('adding a passkey', async () => {
    const { document, click } = await load('/passkeys/register', [...finishFirst]);
    const anchors = document.querySelectorAll('a').length;
    click('add-first');
    await flush();
    document.getElementById('confirm-account')!.dispatchEvent(new (document.defaultView as any).Event('click'));
    await flush();
    expect(document.getElementById('status-first')!.textContent).toContain('Next: nothing more to do here; you can close this page.');
    expect(document.querySelectorAll('a').length).toBe(anchors);
  });

  it('adding one from a sign-in points back to it with the link the page already has', async () => {
    const { document, click } = await load('/passkeys/register?next=sign-in', [...finishFirst]);
    const anchors = document.querySelectorAll('a').length;
    click('add-first');
    await flush();
    document.getElementById('confirm-account')!.dispatchEvent(new (document.defaultView as any).Event('click'));
    await flush();
    expect(document.getElementById('status-first')!.textContent).toContain('Next: continue signing in.');
    const cont = document.getElementById('continue-signin')!;
    expect(cont.hasAttribute('hidden')).toBe(false);
    expect(cont.querySelector('a')!.getAttribute('href')).toBe('/auth/passkey/sign-in');
    expect(document.querySelectorAll('a').length).toBe(anchors);
  });

  it('adding another passkey (vouched) says nothing more to do', async () => {
    const { document, click } = await load('/passkeys/register', [
      { body: { ceremonyId: 'c', challenge: 'AA' } }, { body: options }, { body: { kind: 'later' } }]);
    click('add-later');
    await flush();
    document.getElementById('confirm-account')!.dispatchEvent(new (document.defaultView as any).Event('click'));
    await flush();
    expect(document.getElementById('status-later')!.textContent).toBe('Passkey added. We emailed you a notice. Next: nothing more to do here; you can close this page.');
  });

  it('ending the window', async () => {
    const { document, click } = await load('/passkeys/window/end', [
      { body: { label: 'L', registeredAt: '2026-11-01T10:00:00Z', method: 'github' } }, { body: {} }]);
    click('end-window');
    await flush();
    click('confirm-window');
    await flush();
    expect(document.getElementById('status-window')!.textContent).toContain('Next: nothing more to do here; you can close this page.');
  });

  it('removing a passkey', async () => {
    const list = [{ label: 'Laptop', credentialId: 'a', registeredAt: '2026-11-01T10:00:00Z', revokedAt: null, inWindow: false, prover: false, cancel: null }];
    const { document, click } = await load('/passkeys/revoke', [{ body: { ceremonyId: 'c', challenge: 'AA' } }, { body: { passkeys: list } }, { body: {} }]);
    click('revoke-passkey');
    await flush();
    (document.querySelector('#passkey-list button') as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new (document.defaultView as any).Event('click'));
    await flush();
    expect(document.getElementById('status-revoke')!.textContent).toContain('Next: start again from step 1 to remove another passkey, or close this page.');
  });

  it('removing sends the clicked row\'s credential and ceremony, and a refused removal keeps the list', async () => {
    const list = [{ label: 'Laptop', credentialId: 'cred-a', registeredAt: '2026-11-01T10:00:00Z', revokedAt: null, inWindow: false, prover: false, cancel: null }];
    const { document, click, calls, unconsumed } = await load('/passkeys/revoke', [{ body: { ceremonyId: 'cer-1', challenge: 'AA' } }, { body: { passkeys: list } }, { status: 403 }]);
    click('revoke-passkey');
    await flush();
    (document.querySelector('#passkey-list button') as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new (document.defaultView as any).Event('click'));
    await flush();
    expect(calls.at(-1)).toEqual({ path: '/passkeys/revoke/finish', method: 'POST', body: { ceremonyId: 'cer-1', credentialId: 'cred-a' } });
    expect(calls.every((c) => c.method === 'POST')).toBe(true);
    expect(unconsumed()).toBe(0);
    expect(document.getElementById('status-revoke')!.textContent).toBe('Not removed. Start again.');
    expect(document.querySelectorAll('#passkey-list li').length).toBe(1);
  });
});

describe('CSP and script source are unchanged', () => {
  it('the register page keeps its CSP and external script', async () => {
    const r = await fetch(`${base}/passkeys/register`);
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://github.com https://accounts.google.com https://appleid.apple.com; frame-ancestors 'none'; base-uri 'none'");
    expect(await r.text()).toContain('<script src="/passkeys/assets/ceremony.js" defer></script>');
  });
});
