/**
 * #168 — GET /oauth/authorize shows a server-rendered sign-in prompt, not an
 * immediate provider redirect, ONLY for an MCP connector flow: no cookie,
 * `login_provider` omitted, and `resource` exactly `${origin}/mcp`
 * (Holger's scoped (b) ruling, 6378353067). Every other no-cookie request
 * keeps today's behavior. The discriminator is exact string equality, so each
 * near-miss is pinned to the unchanged 302.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { generateId } from '../../lib/id.js';

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
    const href = html.match(/<a [^>]*class="button"[^>]*href="([^"]+)"/)?.[1]
      ?? html.match(/<a [^>]*href="([^"]+)"[^>]*class="button"/)?.[1];
    expect(href, 'prompt must carry a sign-in link').toBeDefined();
    const target = new URL(href!.replace(/&amp;/g, '&'), 'http://placeholder.invalid');
    expect(target.origin).toBe('http://placeholder.invalid');
    expect(target.pathname).toBe('/auth/github');
    expect(target.searchParams.get('return_to')).toBe(`/oauth/authorize?${q}`);
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
