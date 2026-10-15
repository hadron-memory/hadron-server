/**
 * #1925 — GET /capabilities: the deployment switches that are on, readable
 * before sign-in (Holger, 2026-10-14). An off switch is left out, never false,
 * so the off state stays indistinguishable from a build without the feature
 * (#11049).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer as httpServer, request as httpRequest, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { signJwt } from '../auth/jwt.js';
import { CAPABILITIES_RATE_LIMIT_PER_MINUTE, mountCapabilitiesRoute } from './capabilities.js';
import { switchCapabilities } from '../lib/signing/surface.js';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined;
  vi.unstubAllEnvs();
});

async function listen(handler: RequestListener): Promise<string> {
  server = httpServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The response headers a caller can see, minus the per-response clock. */
function visibleHeaders(r: Response): Record<string, string> {
  const out: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (k !== 'date') out[k] = v;
  });
  return out;
}

const STATES: Array<[string | undefined, string | undefined, string[]]> = [
  [undefined, undefined, []],
  ['false', 'true', []],
  ['malformed', 'true', []],
  ['TRUE', 'true', []],
  ['true', undefined, ['node-signing']],
  ['true', 'false', ['node-signing']],
  ['true', 'true', ['node-signing', 'passkey-registration']],
];

describe('GET /capabilities on the real server', () => {
  it.each(STATES)('signing=%s registration=%s → %j, and MCP says the same', async (signing, registration, expected) => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', signing);
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', registration);
    await cleanDb(db);
    const base = await listen((await createServer()) as unknown as RequestListener);

    const before = await db.usageEvent.count();
    const r = await fetch(`${base}/capabilities`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(JSON.stringify({ capabilities: expected }));
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
    expect(r.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    // Readable from any origin, never with credentials (the global CORS allows the portal's, with credentials).
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
    expect(r.headers.get('set-cookie')).toBeNull();
    // No usage event, no session: the route touches nothing.
    expect(await db.usageEvent.count()).toBe(before);

    // One source: MCP's capabilities line carries exactly the same switch tokens.
    const user = await db.user.create({ data: { handle: 'caps-reader', roles: [] } });
    const headers = { authorization: `Bearer ${await signJwt({ sub: user.id, roles: [] })}` };
    const client = new Client({ name: 'caps-probe', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
      const info = await client.callTool({ name: 'hadron_server_info', arguments: {} });
      const text = (info.content as Array<{ text: string }>).map((c) => c.text).join('\n');
      const tokens = /^capabilities: (.*)$/m.exec(text)![1].split(', ');
      expect(tokens.filter((t) => t === 'node-signing' || t === 'passkey-registration')).toEqual(expected);
    } finally {
      await client.close();
    }
  });

  it('off is byte-identical whatever the reason it is off: unset, false, malformed', async () => {
    const seen: Array<{ body: string; headers: Record<string, string> }> = [];
    for (const value of [undefined, 'false', 'malformed']) {
      vi.stubEnv('PASSKEY_SIGNING_ENABLED', value);
      vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
      const base = await listen((await createServer()) as unknown as RequestListener);
      const r = await fetch(`${base}/capabilities`);
      seen.push({ body: await r.text(), headers: visibleHeaders(r) });
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
      server = undefined;
    }
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
  });

  it('GET and HEAD only; nothing from the request is read or echoed; the ETag answers 304', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    const base = await listen((await createServer()) as unknown as RequestListener);
    const plain = await fetch(`${base}/capabilities`);
    const body = await plain.text();
    const etag = plain.headers.get('etag')!;

    const probed = await fetch(`${base}/capabilities?capabilities=x&<script>=1`, { headers: { origin: 'https://evil.example', cookie: 'a=b' } });
    expect(await probed.text()).toBe(body);
    expect(probed.headers.get('access-control-allow-origin')).toBe('*');

    const head = await fetch(`${base}/capabilities`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('etag')).toBe(etag);

    // A plain conditional GET (fetch would add `cache-control: no-cache`, which rightly forbids a 304).
    const revalidated = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/capabilities`, { headers: { 'if-none-match': etag } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end();
    });
    expect(revalidated).toBe(304);

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`${base}/capabilities`, { method });
      expect(r.status).toBe(404);
    }
  });
});

describe('the rate limit', () => {
  it(`defaults to ${CAPABILITIES_RATE_LIMIT_PER_MINUTE} a minute per client IP`, () => {
    expect(CAPABILITIES_RATE_LIMIT_PER_MINUTE).toBe(60);
  });

  it('over the limit: a bare 429 with no detail, and the limiter adds no headers to the cacheable answer', async () => {
    const app = express();
    mountCapabilitiesRoute(app, { limitPerMinute: 2 });
    const base = await listen(app as unknown as RequestListener);
    const ok = await fetch(`${base}/capabilities`);
    expect(ok.status).toBe(200);
    expect([...ok.headers.keys()].filter((k) => k.toLowerCase().startsWith('ratelimit') || k.toLowerCase().startsWith('x-ratelimit'))).toEqual([]);
    await fetch(`${base}/capabilities`);
    const over = await fetch(`${base}/capabilities`);
    expect(over.status).toBe(429);
    expect(await over.text()).toBe('');
  });

  it('#1964: the 429 is readable cross-origin, says when to retry, and carries nothing per-client', async () => {
    const app = express();
    mountCapabilitiesRoute(app, { limitPerMinute: 1 });
    const base = await listen(app as unknown as RequestListener);
    expect((await fetch(`${base}/capabilities`)).status).toBe(200);
    const origins = [undefined, 'https://hostile.example', 'http://localhost:5173', 'null'];
    const seen: Array<Record<string, string>> = [];
    for (const origin of origins) {
      const over = await fetch(`${base}/capabilities`, origin ? { headers: { origin } } : {});
      expect(over.status).toBe(429);
      expect(await over.text()).toBe('');
      // Any origin may read it, never with credentials: the 200's posture, so a browser sees a rate limit, not a CORS failure.
      expect(over.headers.get('access-control-allow-origin')).toBe('*');
      expect(over.headers.get('access-control-allow-credentials')).toBeNull();
      // The fixed window, not this client's remaining time (Holger's 60-a-minute, #12291 item 5).
      expect(over.headers.get('retry-after')).toBe('60');
      // Still nothing cacheable or per-client: no cache headers, no counters, no cookie.
      expect(over.headers.get('cache-control')).toBeNull();
      expect(over.headers.get('etag')).toBeNull();
      expect(over.headers.get('set-cookie')).toBeNull();
      expect([...over.headers.keys()].filter((k) => k.startsWith('ratelimit') || k.startsWith('x-ratelimit'))).toEqual([]);
      seen.push(visibleHeaders(over));
    }
    // Byte-identical whatever the Origin: nothing about the request is echoed.
    for (const h of seen) expect(h).toEqual(seen[0]);
  });

  it('#1964: on the real server, the 429 to the portal\'s own origin is still `*` without credentials', async () => {
    const base = await listen((await createServer()) as unknown as RequestListener);
    const origin = process.env.FRONTEND_URL || 'http://localhost:5173';
    let over: Response | undefined;
    for (let i = 0; i <= CAPABILITIES_RATE_LIMIT_PER_MINUTE && !over; i++) {
      const r = await fetch(`${base}/capabilities`, { headers: { origin } });
      if (r.status === 429) over = r;
      else await r.arrayBuffer();
    }
    expect(over?.status).toBe(429);
    // The global CORS (the portal's origin, WITH credentials) is mounted after this route and never reaches it.
    expect(over!.headers.get('access-control-allow-origin')).toBe('*');
    expect(over!.headers.get('access-control-allow-credentials')).toBeNull();
    expect(over!.headers.get('retry-after')).toBe('60');
  });
});

describe('switchCapabilities, the one source', () => {
  it('maps the policy in order, registration never without signing', () => {
    expect(switchCapabilities({ signing: false, registration: false })).toEqual([]);
    expect(switchCapabilities({ signing: true, registration: false })).toEqual(['node-signing']);
    expect(switchCapabilities({ signing: true, registration: true })).toEqual(['node-signing', 'passkey-registration']);
  });
});
