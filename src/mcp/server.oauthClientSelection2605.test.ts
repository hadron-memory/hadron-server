/**
 * #2605 (ruling 6, Holger 2026-11-20) — a client that sends no `X-Hadron-Client-Id` has its stored selection keyed
 * on its OAuth client.
 *
 * #1012 made selections durable per (user, client instance), but only for a client that sends the header, and no
 * client application or repository sends it. A connector user (Claude Desktop, claude.ai) authenticates through OAuth
 * and cannot add a header, so their active App and memory were still lost on every reconnect. The key an OAuth
 * exchange issues records its client (`UserApiKey.issuedVia = 'oauth:<client_id>'`), which gives the server a stable
 * per-client key it already holds.
 *
 * Over the REAL HTTP boundary, like server.clientKeyHeader.test.ts, because the point is that the key is derived from
 * the presented credential and reaches the restore.
 *
 * The store stays keyed on (user, client key): an OAuth client shared by many users can never carry one user's
 * selection to another, pinned below.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey } from '../middleware/auth.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../test/startServerFixture.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = await createServerOnCleanDb();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeServerIfStarted(server);
});

let appA: { id: string; urn: string };
let appB: { id: string; urn: string };
let userA: { id: string };
let userB: { id: string };

const mintKey = async (userId: string, issuedVia: string) =>
  (await mintUserApiKey(db, { userId, label: 'test', createdBy: userId, issuedVia })).rawKey;

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().slice(-8);
  const org = await db.organization.create({ data: { id: generateId(), name: 'oc-org', urn: `oc-${suffix}.com` } });
  appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App A', urn: `${org.urn}:app-a` } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App B', urn: `${org.urn}:app-b` } });
  // Two Apps each, so App scope is ambiguous without a selection and a restore is observable.
  const mkUser = async (n: number) => {
    const user = await db.user.create({ data: { id: generateId(), githubId: 26050 + n, githubUsername: `oc-${n}-${suffix}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: appA.id, userId: user.id, role: 'owner' } });
    await db.appMember.create({ data: { appId: appB.id, userId: user.id, role: 'owner' } });
    return user;
  };
  userA = await mkUser(1);
  userB = await mkUser(2);
});

const initializeBody = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
};
const callBody = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });

function mcpFetch(rawKey: string, body: unknown, opts: { sessionId?: string; clientId?: string } = {}) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${rawKey}`,
  };
  if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId;
  if (opts.clientId) headers['x-hadron-client-id'] = opts.clientId;
  return fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** A new MCP session for this credential, as a reconnect produces. */
async function connect(rawKey: string, clientId?: string): Promise<string> {
  const res = await mcpFetch(rawKey, initializeBody, { clientId });
  await res.text();
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  return sid!;
}

/** Call a tool and consume the body (the handler has finished its writes once the stream ends). */
async function call(rawKey: string, sessionId: string, name: string, args: Record<string, unknown> = {}, clientId?: string) {
  return (await mcpFetch(rawKey, callBody(name, args), { sessionId, clientId })).text();
}

/** Select an App on a new connection of this credential. */
async function select(rawKey: string, app: { urn: string }, clientId?: string) {
  const sid = await connect(rawKey, clientId);
  expect(await call(rawKey, sid, 'hadron_set_active_app', { app: app.urn }, clientId)).toContain('Active App set to');
}

/** The App scope a brand-new connection of this credential starts with. */
async function scopeOnReconnect(rawKey: string, clientId?: string) {
  const sid = await connect(rawKey, clientId);
  return call(rawKey, sid, 'hadron_list_memories', {}, clientId);
}

/** Select App A on one connection, then read the App scope on a brand-new one. */
async function selectThenReconnect(selectKey: string, readKey: string, opts: { selectClientId?: string; readClientId?: string } = {}) {
  await select(selectKey, appA, opts.selectClientId);
  return scopeOnReconnect(readKey, opts.readClientId);
}

describe('#2605 — a stored selection keyed on the OAuth client', () => {
  it('an OAuth-issued credential that sends no client id keeps its selection across a reconnect', async () => {
    const key = await mintKey(userA.id, 'oauth:dcr_desktop');
    const text = await selectThenReconnect(key, key);
    expect(text).toContain(appA.urn);
    expect(text).not.toContain('no active App');
  });

  it('a second credential from the SAME OAuth client shares it (a re-authorized connector is the same client)', async () => {
    const first = await mintKey(userA.id, 'oauth:dcr_desktop');
    const reissued = await mintKey(userA.id, 'oauth:dcr_desktop');
    expect(await selectThenReconnect(first, reissued)).toContain(appA.urn);
  });

  it('a DIFFERENT OAuth client that has its own selection keeps it', async () => {
    const desktop = await mintKey(userA.id, 'oauth:dcr_desktop');
    const cursor = await mintKey(userA.id, 'oauth:dcr_cursor');
    await select(cursor, appB);
    await select(desktop, appA);
    const text = await scopeOnReconnect(cursor);
    expect(text).toContain(appB.urn);
    expect(text).not.toContain(appA.urn);
  });

  it('ANOTHER user on the same OAuth client gets nothing of it', async () => {
    const a = await mintKey(userA.id, 'oauth:dcr_shared_vendor');
    const b = await mintKey(userB.id, 'oauth:dcr_shared_vendor');
    expect(await selectThenReconnect(a, b)).toContain('no active App');
  });

  it('an explicit X-Hadron-Client-Id outranks the OAuth client: two windows of one client keep separate selections', async () => {
    const key = await mintKey(userA.id, 'oauth:dcr_desktop');
    await select(key, appA, 'window-1');
    await select(key, appB, 'window-2');
    expect(await scopeOnReconnect(key, 'window-1')).toContain(appA.urn);
    expect(await scopeOnReconnect(key, 'window-2')).toContain(appB.urn);
  });

  it('a credential that is not OAuth-issued and sends no client id is still not persisted', async () => {
    const key = await mintKey(userA.id, 'portal');
    expect(await selectThenReconnect(key, key)).toContain('no active App');
  });
});

/**
 * #2605 (ruling 7, Holger 2026-11-20: "Fallback only for OAuth") — an OAuth caller whose client has no stored
 * selection of its own STARTS FROM the user's last explicit selection. "Starts from" is a copy made once: after it,
 * the client has its own selection, and nothing another client does moves it. A caller on a portal or legacy API key
 * neither reads nor feeds that per-user record: the agents that share one account through API keys must not all
 * follow one record (the 2026-08-16 "per client, not per user" ruling, which this narrows for OAuth callers only).
 */
describe('#2605 — the per-user fallback, OAuth callers only', () => {
  it('a NEW OAuth client starts from the last explicit selection the user made in another OAuth client', async () => {
    const desktop = await mintKey(userA.id, 'oauth:dcr_desktop');
    const phone = await mintKey(userA.id, 'oauth:dcr_phone');
    await select(desktop, appA);
    const text = await scopeOnReconnect(phone);
    expect(text).toContain(appA.urn);
    expect(text).not.toContain('no active App');
  });

  it('starting from it is a copy: a later selection elsewhere does not move a client that has already started', async () => {
    const desktop = await mintKey(userA.id, 'oauth:dcr_desktop');
    const phone = await mintKey(userA.id, 'oauth:dcr_phone');
    await select(desktop, appA);
    expect(await scopeOnReconnect(phone)).toContain(appA.urn);
    await select(desktop, appB);
    const text = await scopeOnReconnect(phone);
    expect(text).toContain(appA.urn);
    expect(text).not.toContain(appB.urn);
  });

  it('follows the LAST explicit selection, whichever OAuth client made it', async () => {
    const desktop = await mintKey(userA.id, 'oauth:dcr_desktop');
    const cursor = await mintKey(userA.id, 'oauth:dcr_cursor');
    const phone = await mintKey(userA.id, 'oauth:dcr_phone');
    await select(desktop, appA);
    await select(cursor, appB);
    expect(await scopeOnReconnect(phone)).toContain(appB.urn);
  });

  it('an API-key caller does not read the per-user record, with or without a client id', async () => {
    const desktop = await mintKey(userA.id, 'oauth:dcr_desktop');
    const agent = await mintKey(userA.id, 'portal');
    await select(desktop, appA);
    expect(await scopeOnReconnect(agent)).toContain('no active App');
    expect(await scopeOnReconnect(agent, 'agent-9')).toContain('no active App');
  });

  it('an API-key caller that sends a client id keeps its own selection and does not feed the per-user record', async () => {
    const agent = await mintKey(userA.id, 'portal');
    const phone = await mintKey(userA.id, 'oauth:dcr_phone');
    await select(agent, appB, 'agent-1');
    expect(await scopeOnReconnect(agent, 'agent-1')).toContain(appB.urn);
    expect(await scopeOnReconnect(phone)).toContain('no active App');
    // And another header-sending API-key client of the same user starts from nothing.
    expect(await scopeOnReconnect(agent, 'agent-2')).toContain('no active App');
  });

  it("another user's OAuth client never starts from this user's selection", async () => {
    const a = await mintKey(userA.id, 'oauth:dcr_desktop');
    const b = await mintKey(userB.id, 'oauth:dcr_phone');
    await select(a, appA);
    expect(await scopeOnReconnect(b)).toContain('no active App');
  });

  it('no client id header can address the per-user record', async () => {
    const { normalizeClientKey, USER_DEFAULT_CLIENT_KEY } = await import('../lib/mcpSessionState.js');
    expect(normalizeClientKey(USER_DEFAULT_CLIENT_KEY)).toBeNull();
    expect(normalizeClientKey(` ${USER_DEFAULT_CLIENT_KEY} `)).toBeNull();
  });
});

describe('#2605 — selectionClientKey', () => {
  it('prefers a usable header, falls back to the OAuth client, and is null with neither', async () => {
    const { selectionClientKey } = await import('../lib/mcpSessionState.js');
    expect(selectionClientKey('  window-1 ', { oauthClientId: 'dcr_x' })).toBe('window-1');
    expect(selectionClientKey(undefined, { oauthClientId: 'dcr_x' })).toBe('oauth:dcr_x');
    // An unusable header (blank, over-long, an array) is no header: the OAuth client still applies.
    expect(selectionClientKey('   ', { oauthClientId: 'dcr_x' })).toBe('oauth:dcr_x');
    expect(selectionClientKey('k'.repeat(201), { oauthClientId: 'dcr_x' })).toBe('oauth:dcr_x');
    expect(selectionClientKey(['a', 'b'], { oauthClientId: 'dcr_x' })).toBe('oauth:dcr_x');
    expect(selectionClientKey(undefined, {})).toBeNull();
  });

  it('does not persist under a client id too long to store whole, rather than truncate two clients onto one row', async () => {
    const { selectionClientKey } = await import('../lib/mcpSessionState.js');
    expect(selectionClientKey(undefined, { oauthClientId: 'https://client.example/'.padEnd(200, 'x') })).toBeNull();
  });
});
