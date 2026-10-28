/**
 * #2626 — the registered redirect destination is shown as opaque plain text
 * beneath the client name on BOTH the #168 sign-in prompt and the consent page.
 * Source is the registered redirect URI only; userinfo/path/query/fragment are
 * never shown; the hidden redirect_uri input is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

let server: Server;
let baseUrl: string;
const clientId = `dcr_${'c'.repeat(32)}`;

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
});

async function pages(redirectUri: string, clientName = 'Claude Desktop', extra: Record<string, string> = {}) {
  await db.oAuthClient.create({ data: { clientId, clientName, redirectUris: [redirectUri] } });
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: 'a'.repeat(43), code_challenge_method: 'S256',
    resource: `${baseUrl}/mcp`, state: 'opaque-state', ...extra,
  }).toString();
  const user = await db.user.create({ data: { id: generateId(), handle: 'anchor', githubUsername: 'anchor', roles: ['CONTRIBUTOR'] } });
  const jwt = await signJwt({ sub: user.id, roles: ['CONTRIBUTOR'] });
  const prompt = await (await fetch(`${baseUrl}/oauth/authorize?${q}`, { redirect: 'manual' })).text();
  const consent = await (await fetch(`${baseUrl}/oauth/authorize?${q}`, { redirect: 'manual', headers: { cookie: `hadron_token=${jwt}` } })).text();
  return { prompt, consent };
}
const anchorOf = (html: string) => html.match(/Returns to: <code>([^<]*)<\/code>/)?.[1];

describe('redirect anchor on prompt and consent', () => {
  it.each([
    ['https://app.example.com/cb', 'app.example.com'],
    ['https://app.example.com:8443/cb', 'app.example.com:8443'],
    ['https://app.example.com:443/cb', 'app.example.com'],
    ['http://localhost:3000/cb', 'localhost:3000'],
    ['com.hadronmemory.ios://oauth/callback', 'com.hadronmemory.ios://oauth'],
  ])('%s shows %s', async (uri, expected) => {
    const { prompt, consent } = await pages(uri);
    expect(anchorOf(prompt)).toBe(expected);
    expect(anchorOf(consent)).toBe(expected);
  });

  it('userinfo, path, query and fragment are never shown', async () => {
    const { prompt, consent } = await pages('https://admin:s3cret@app.example.com/secret/path?token=abc');
    for (const html of [prompt, consent]) {
      expect(anchorOf(html)).toBe('app.example.com');
      // Visible text only: the existing hrefs/hidden inputs legitimately carry the registered URI.
      const visible = html.replace(/(href|value)="[^"]*"/g, '');
      expect(visible).not.toContain('s3cret');
      expect(visible).not.toContain('admin');
      expect(visible).not.toContain('token=abc');
    }
    // The hidden redirect input is unchanged (full registered URI).
    expect(consent).toContain('value="https://admin:s3cret@app.example.com/secret/path?token=abc"');
  });

  it('a native URI with an EMPTY authority shows the scheme only, on both pages', async () => {
    const { prompt, consent } = await pages('com.example.app:/callback?x=1');
    expect(anchorOf(prompt)).toBe('com.example.app');
    expect(anchorOf(consent)).toBe('com.example.app');
  });

  it('hostile client_name and redirect text render escaped; hostile Host/resource/query never become the anchor', async () => {
    const { prompt, consent } = await pages('https://app.example.com/cb', '<script>alert(1)</script>', { evil: 'evil.example', foo: 'bar' });
    for (const html of [prompt, consent]) {
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(anchorOf(html)).toBe('app.example.com');
      expect(anchorOf(html)).not.toContain('127.0.0.1');
    }
  });

  it('is plain text: no link or input carries the anchor beyond the existing hidden redirect_uri', async () => {
    const { prompt, consent } = await pages('https://app.example.com:8443/cb');
    // The existing sign-in links carry the original query (by design); the anchor itself is never link text.
    for (const html of [prompt, consent]) {
      for (const m of html.matchAll(/<a [^>]*>([^<]*)<\/a>/g)) expect(m[1]).not.toContain('app.example.com');
      expect(html).not.toMatch(/<code>[^<]*<a /);
    }
    expect(consent.match(/name="redirect_uri"\s+value="([^"]*)"/)?.[1]).toBe('https://app.example.com:8443/cb');
  });
});
