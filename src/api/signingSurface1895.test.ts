import { afterEach, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { signJwt } from '../auth/jwt.js';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
});

it.each([['false', 'true'], ['malformed', 'true'], ['true', undefined], ['true', 'true']])('#1895/#1900 real HTTP schema and capability signing=%s registration=%s', async (value, registration) => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', value);
  vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', registration);
  const signingOn = value === 'true';
  const registrationOn = signingOn && registration === 'true';
  await cleanDb(db);
  const user = await db.user.create({ data: { handle: 'switch-reader', roles: [] } });
  server = httpServer(await createServer());
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${await signJwt({ sub: user.id, roles: [] })}`, 'content-type': 'application/json' };
  const schemaResponse = await fetch(`${base}/graphql/schema`, { headers });
  expect(schemaResponse.status).toBe(200);
  const sdl = await schemaResponse.text();
  expect(sdl.includes('signatureStatus:')).toBe(value === 'true');
  expect(sdl.includes('SigningRequest')).toBe(value === 'true');
  expect(/\bsigning: Boolean!/.test(sdl)).toBe(signingOn);
  expect(/\bpasskeyRegistration: Boolean!/.test(sdl)).toBe(registrationOn);
  const infoQuery = `{serverInfo{version baseUrl ${signingOn ? 'signing' : ''} ${registrationOn ? 'passkeyRegistration' : ''}}}`;
  const infoResponse = await fetch(`${base}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query: infoQuery }) });
  expect(infoResponse.status).toBe(200);
  const info = (await infoResponse.json() as any).data.serverInfo;
  expect(info.signing).toBe(signingOn ? true : undefined);
  expect(info.passkeyRegistration).toBe(registrationOn ? true : undefined);
  if (!signingOn) expect(Object.keys(info)).toEqual(['version', 'baseUrl']);
  const query = '{ signingRequest(id:"opaque") { id } }';
  const response = await fetch(`${base}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query }) });
  const result = await response.json() as any;
  if (!signingOn) {
    expect(response.status).toBe(400);
    expect(result.errors[0].message).toBe('Cannot query field "signingRequest" on type "Query".');
    for (const query of ['mutation { requestNodeSignature(nodeRef:"opaque") { id } }', 'mutation { withdrawSigningRequest(id:"opaque") { id } }']) {
      const r = await fetch(`${base}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query }) });
      expect(r.status).toBe(400);
      expect((await r.json() as any).errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    }
  } else {
    expect(response.status).toBe(200);
    expect(result).toEqual({ data: { signingRequest: null } });
  }
  const client = new Client({ name: 'signing-switch-probe', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    const capability = await client.callTool({ name: 'hadron_server_info', arguments: {} });
    const capabilityText = (capability.content as Array<{text: string}>).map(c => c.text).join('\n');
    const tokens = /^capabilities: (.*)$/m.exec(capabilityText)![1].split(', ');
    expect(tokens.includes('node-signing')).toBe(signingOn);
    expect(tokens.includes('passkey-registration')).toBe(registrationOn);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['hadron_request_signature', 'hadron_get_signing_request', 'hadron_withdraw_signing_request']) {
      expect(names.includes(name)).toBe(value === 'true');
      if (!signingOn) {
        const missing = await client.callTool({ name, arguments: {} }).catch(e => e);
        const control = await client.callTool({ name: 'hadron_absent_control', arguments: {} }).catch(e => e);
        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing).replaceAll(name, '<tool>'))
          .toBe(JSON.stringify(control).replaceAll('hadron_absent_control', '<tool>'));
      }
    }
  } finally { await client.close(); }
  // No REST signing-request routes have merged. Off surfaces use Express's ordinary
  // missing-route behavior; there is no feature-specific refusal middleware.
  for (const path of ['/signing/requests/opaque', '/nonexistent-control']) {
    const r = await fetch(`${base}${path}`, { headers });
    expect(r.status).toBe(404);
    expect(await r.text()).toContain(`Cannot GET ${path}`);
  }
  // #1631 PR2: the registration page exists exactly when the registration switch is on, and is an ordinary
  // missing route otherwise (no switch oracle).
  const page = await fetch(`${base}/passkeys/register`, { headers });
  expect(page.status).toBe(registrationOn ? 200 : 404);
  if (!registrationOn) expect(await page.text()).toContain('Cannot GET /passkeys/register');
});
