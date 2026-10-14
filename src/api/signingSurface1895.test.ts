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

it.each(['false', 'true'])('#1895 real HTTP schema/execution and nonexistent REST at signing=%s', async value => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', value);
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
  const query = '{ signingRequest(id:"opaque") { id } }';
  const response = await fetch(`${base}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query }) });
  const result = await response.json() as any;
  if (value === 'false') {
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
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['hadron_request_signature', 'hadron_get_signing_request', 'hadron_withdraw_signing_request']) {
      expect(names.includes(name)).toBe(value === 'true');
      if (value === 'false') {
        const missing = await client.callTool({ name, arguments: {} }).catch(e => e);
        const control = await client.callTool({ name: 'hadron_absent_control', arguments: {} }).catch(e => e);
        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing).replaceAll(name, '<tool>'))
          .toBe(JSON.stringify(control).replaceAll('hadron_absent_control', '<tool>'));
      }
    }
  } finally { await client.close(); }
  // No REST ceremony/request routes have merged. They use Express's ordinary
  // missing-route behavior; there is no feature-specific refusal middleware.
  for (const path of ['/signing/requests/opaque', '/passkeys/register', '/nonexistent-control']) {
    const r = await fetch(`${base}${path}`, { headers });
    expect(r.status).toBe(404);
    expect(await r.text()).toContain(`Cannot GET ${path}`);
  }
});
