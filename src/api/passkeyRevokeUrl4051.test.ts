import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSchema } from 'graphql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { signJwt } from '../auth/jwt.js';
import { appQueries } from './graphql/schema/resolvers.query.app.js';
import { deploymentSchema } from './graphql/schema/deploymentSchema.js';

// #4051: ServerInfo.passkeyRevokeUrl — the fixed revoke page's URL, registration-gated through capabilityFields
// (removed, never null, while off); value = the same response's baseUrl + CEREMONY_NEXT_PAGES.revoke.
// Specs: hrn:node:hadronmemory.com:specs:cor:api:020:01, hrn:node:hadronmemory.com:specs:cor:aut:040:08.

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

async function boot(signing: string | undefined, registration: string | undefined, baseUrl = 'https://hadron.example') {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', signing);
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', registration);
  vi.stubEnv('BASE_URL', baseUrl);
  await cleanDb(db);
  server = httpServer(await createServer());
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port };
}
const gql = (base: string, query: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ query }) });

const REVOKE = '{serverInfo{baseUrl passkeyRevokeUrl}}';

describe('#4051 passkeyRevokeUrl', () => {
  // pin 1
  it('on: returns baseUrl + /passkeys/revoke, no credential needed (pin 3: headerless)', async () => {
    const { base } = await boot('true', 'true');
    const r = await gql(base, REVOKE);
    expect(r.status).toBe(200);
    const info = (await r.json() as any).data.serverInfo;
    expect(info.baseUrl).toBe('https://hadron.example');
    expect(info.passkeyRevokeUrl).toBe('https://hadron.example/passkeys/revoke');
    expect(info.passkeyRevokeUrl).toBe(`${info.baseUrl}/passkeys/revoke`);
  });

  // pin 2: four-row matrix
  it.each([['false', 'true', false], ['true', undefined, false], ['true', 'false', false], ['true', 'true', true]])(
    'signing=%s registration=%s: field present=%s (removed, never null)', async (signing, registration, on) => {
      const { base } = await boot(signing, registration);
      const user = await db.user.create({ data: { handle: 'revoke-url-reader', roles: [] } });
      const headers = { authorization: `Bearer ${await signJwt({ sub: user.id, roles: [] })}` };
      const sdl = await (await fetch(`${base}/graphql/schema`, { headers })).text();
      expect(/\bpasskeyRevokeUrl: String!/.test(sdl)).toBe(on);
      const r = await gql(base, REVOKE, headers);
      if (on) {
        expect(r.status).toBe(200);
      } else {
        expect(r.status).toBe(400);
        const body = await r.json() as any;
        expect(body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
        expect(body.errors[0].message).toContain('passkeyRevokeUrl');
        const plain = await (await gql(base, '{serverInfo{version baseUrl}}', headers)).json() as any;
        expect(Object.keys(plain.data.serverInfo)).toEqual(['version', 'baseUrl']);
      }
      // the registration page is mounted exactly when the field is advertised
      expect((await fetch(`${base}/passkeys/revoke`)).status).toBe(on ? 200 : 404);
    });

  // pin 4
  it('the advertised URL reaches the revoke page; off it 404s', async () => {
    const { base } = await boot('true', 'true');
    const info = (await (await gql(base, REVOKE)).json() as any).data.serverInfo;
    const url = new URL(info.passkeyRevokeUrl);
    expect(url.pathname).toBe('/passkeys/revoke');
    const viaAdvertised = await fetch(`${base}${url.pathname}`);
    expect(viaAdvertised.status).toBe(200);
    expect(await viaAdvertised.text()).toBe(await (await fetch(`${base}/passkeys/revoke`)).text());
  });

  // pin 5: old consumers
  it('old consumers are unchanged: /capabilities, hadron_server_info, plain serverInfo', async () => {
    const { base } = await boot('true', 'true');
    const caps = await (await fetch(`${base}/capabilities`)).text();
    expect(caps).not.toContain('revoke');
    expect(caps).not.toContain('pages');
    const plain = await (await gql(base, '{serverInfo{version baseUrl}}')).json() as any;
    expect(Object.keys(plain.data.serverInfo)).toEqual(['version', 'baseUrl']);
    const user = await db.user.create({ data: { handle: 'revoke-mcp', roles: [] } });
    const headers = { authorization: `Bearer ${await signJwt({ sub: user.id, roles: [] })}` };
    const client = new Client({ name: 'revoke-url-probe', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
      const text = ((await client.callTool({ name: 'hadron_server_info', arguments: {} })).content as Array<{ text: string }>).map(c => c.text).join('\n');
      expect(text).not.toContain('revoke');
    } finally { await client.close(); }
  });

  // pin 6a: no request-derived origin
  it('a poisoned Host / X-Forwarded-Host never reaches the URL', async () => {
    const { port } = await boot('true', 'true');
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port, path: '/graphql', method: 'POST',
        headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', 'content-type': 'application/json' },
      }, res => { let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve(s)); });
      req.on('error', reject);
      req.end(JSON.stringify({ query: REVOKE }));
    });
    const info = JSON.parse(body).data.serverInfo;
    expect(info.passkeyRevokeUrl).toBe('https://hadron.example/passkeys/revoke');
    expect(body).not.toContain('evil.example');
  });

  // pin 6b: privacy, same for every caller
  it('byte-identical for two users and an anonymous caller, no query/fragment', async () => {
    const { base } = await boot('true', 'true');
    const a = await db.user.create({ data: { handle: 'revoke-a', roles: [] } });
    const b = await db.user.create({ data: { handle: 'revoke-b', roles: [] } });
    const answers: string[] = [];
    for (const u of [a, b, undefined]) {
      const headers: Record<string, string> = u ? { authorization: `Bearer ${await signJwt({ sub: u.id, roles: [] })}` } : {};
      answers.push(await (await gql(base, REVOKE, headers)).text());
    }
    expect(new Set(answers).size).toBe(1);
    const url = JSON.parse(answers[0]).data.serverInfo.passkeyRevokeUrl as string;
    expect(url).toMatch(/^[^?#]*\/passkeys\/revoke$/);
    for (const u of [a, b]) expect(answers[0]).not.toContain(u.id);
  });

  // pin 7: one origin rule
  it('BASE_URL="/" follows baseUrl (same origin), not getProjectBaseUrl', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
    vi.stubEnv('BASE_URL', '/');
    vi.stubEnv('PORT', '4123');
    const info = await (appQueries.serverInfo as any)({}, {}, {});
    expect(info.baseUrl).toBe('http://localhost:4123');
    expect(info.passkeyRevokeUrl).toBe('http://localhost:4123/passkeys/revoke');
  });

  it('off: the resolver value has no passkeyRevokeUrl key and the SDL drops it', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'false');
    const info = await (appQueries.serverInfo as any)({}, {}, {});
    expect('passkeyRevokeUrl' in info).toBe(false);
    expect('passkeyRevokeUrl' in (buildSchema(deploymentSchema().typeDefs).getType('ServerInfo') as any).getFields()).toBe(false);
  });
});
