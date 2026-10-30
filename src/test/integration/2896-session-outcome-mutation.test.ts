/**
 * #2896 — `recordSessionOutcome` (GraphQL) and `POST /sessions/:id/outcome` (REST) share ONE implementation.
 *
 * The CLI is a GraphQL client (cor:api:240:02), so a session's outcome had no way in except the REST route. The mutation
 * takes the route's validation, its OAuth surface refusal and its write gate (`requireSessionWriteAccess`,
 * cor:dmo:070:05, strict owner cor:acl:010:02), and the route keeps answering exactly what it answered.
 *
 * Two halves: the mutation's own pins (red before the mutation exists), and a characterization of every REST answer
 * (status AND body) so the refactor cannot move the route. The parity test then runs the same inputs through both and
 * compares what is stored.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { signJwt } from '../../auth/jwt.js';
import { APP_KEY_PREFIX, hashAppKey, mintUserApiKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';

const M = resolvers.Mutation as any;

let server: Server;
let baseUrl: string;
let org: { id: string; urn: string };
let owner: { id: string };
let stranger: { id: string };
let appA: { id: string };
let appB: { id: string };
let appAKey: string;
let appBKey: string;
let ownerJwt: string;
let strangerJwt: string;
let ownerSession: string; // attributed to `owner`, App A
let userlessSession: string; // App A, no user
let mcpOnlyKey: string;

const ctxOf = (extra: Partial<Context>): Context => ({ db, roles: [], ...extra }) as Context;
const asOwner = () => ctxOf({ userId: owner.id, roles: ['READER'] });
const asStranger = () => ctxOf({ userId: stranger.id, roles: ['READER'] });
const asAppA = () => ctxOf({ appId: appA.id, organizationId: org.id });
const asAppB = () => ctxOf({ appId: appB.id, organizationId: org.id });

const code = async (p: Promise<unknown>): Promise<{ code: string; extensions: Record<string, unknown>; message: string }> => {
  try {
    await p;
  } catch (e: any) {
    return { code: String(e?.extensions?.code ?? e?.message), extensions: e?.extensions ?? {}, message: String(e?.message) };
  }
  return { code: 'NO_ERROR', extensions: {}, message: '' };
};

const row = (id: string) => db.session.findUniqueOrThrow({ where: { id }, select: { outcome: true, outcomeRef: true, outcomeMeta: true, updatedAt: true } });
const untouched = (r: { outcome: number | null; outcomeRef: string | null; outcomeMeta: unknown }) => [r.outcome, r.outcomeRef, r.outcomeMeta];

async function rest(id: string, token: string | undefined, body: Record<string, unknown> = { outcome: 0.8 }) {
  const res = await fetch(`${baseUrl}/sessions/${id}/outcome`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json() };
}

const mkSession = (appId: string, userId: string | null) => db.session.create({ data: { id: generateId(), appId, userId, type: 'DEVELOPER', startedAt: new Date() }, select: { id: true } }).then((s) => s.id);

beforeAll(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'so-org', urn: `so-${t}.com` } });
  [owner, stranger] = await Promise.all(
    ['o', 's'].map((k, i) => db.user.create({ data: { id: generateId(), handle: `so-${k}-${t}`, githubUsername: `so-${k}-${t}`, githubId: 289_600 + i, roles: ['CONTRIBUTOR'] }, select: { id: true } })),
  );
  appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` }, select: { id: true } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'B', urn: `${org.urn}:b` }, select: { id: true } });
  const mkKey = async (appId: string) => {
    const raw = APP_KEY_PREFIX + randomBytes(32).toString('hex');
    await db.appKey.create({ data: { appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
    return raw;
  };
  [appAKey, appBKey] = [await mkKey(appA.id), await mkKey(appB.id)];
  ownerJwt = await signJwt({ sub: owner.id, roles: ['CONTRIBUTOR'] });
  strangerJwt = await signJwt({ sub: stranger.id, roles: ['CONTRIBUTOR'] });
  mcpOnlyKey = (await mintUserApiKey(db, { userId: owner.id, label: 'mcp', createdBy: owner.id, issuedVia: 'test', oauthScopes: ['mcp'] })).rawKey;
  ownerSession = await mkSession(appA.id, owner.id);
  userlessSession = await mkSession(appA.id, null);
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('recordSessionOutcome — the mutation', () => {
  it('writes outcome, outcomeRef and outcomeMeta for the session’s owner and returns the Session', async () => {
    const id = await mkSession(appA.id, owner.id);
    const s = await M.recordSessionOutcome({}, { sessionId: id, outcome: 0.75, outcomeRef: 'crm-17', outcomeMeta: { stars: 4, tags: ['a'] } }, asOwner());
    expect(s).toMatchObject({ id, outcome: 0.75, outcomeRef: 'crm-17', outcomeMeta: { stars: 4, tags: ['a'] } });
    expect(await row(id)).toMatchObject({ outcome: 0.75, outcomeRef: 'crm-17', outcomeMeta: { stars: 4, tags: ['a'] } });
  });

  it('accepts the bounds 0 and 1, and refuses anything outside [0, 1] as BAD_USER_INPUT before any write', async () => {
    const id = await mkSession(appA.id, owner.id);
    for (const ok of [0, 1]) {
      await M.recordSessionOutcome({}, { sessionId: id, outcome: ok }, asOwner());
      expect((await row(id)).outcome).toBe(ok);
    }
    const before = await row(id);
    for (const bad of [-0.01, 1.01, Number.NaN, Infinity, '0.5' as never]) {
      expect((await code(M.recordSessionOutcome({}, { sessionId: id, outcome: bad }, asOwner()))).code, String(bad)).toBe('BAD_USER_INPUT');
    }
    expect(await row(id)).toEqual(before);
  });

  it('refuses a non-owner user with FORBIDDEN, and writes nothing', async () => {
    const id = await mkSession(appA.id, owner.id);
    const e = await code(M.recordSessionOutcome({}, { sessionId: id, outcome: 0.5, outcomeRef: 'x' }, asStranger()));
    expect(e.code).toBe('FORBIDDEN');
    expect(untouched(await row(id))).toEqual([null, null, null]);
  });

  it('refuses an App key on ANOTHER App’s session and on a session a person is behind', async () => {
    const mine = await mkSession(appA.id, null);
    expect((await code(M.recordSessionOutcome({}, { sessionId: mine, outcome: 0.5 }, asAppB()))).code).toBe('FORBIDDEN');
    expect((await code(M.recordSessionOutcome({}, { sessionId: ownerSession, outcome: 0.5 }, asAppA()))).code).toBe('FORBIDDEN');
    expect(untouched(await row(mine))).toEqual([null, null, null]);
    expect(untouched(await row(ownerSession))).toEqual([null, null, null]);
    // The pure App key on its own App's user-less session is the admitted third-system case.
    await M.recordSessionOutcome({}, { sessionId: mine, outcome: 0.4 }, asAppA());
    expect((await row(mine)).outcome).toBe(0.4);
  });

  it('refuses an OAuth MCP-only credential with FORBIDDEN and the matchable reason, before the gate or any write', async () => {
    const id = await mkSession(appA.id, owner.id);
    const e = await code(M.recordSessionOutcome({}, { sessionId: id, outcome: 0.5 }, ctxOf({ userId: owner.id, roles: ['READER'], oauthScopes: ['mcp'] } as Partial<Context>)));
    expect(e.code).toBe('FORBIDDEN');
    expect(e.extensions).toMatchObject({ reason: 'OAUTH_SCOPE_INSUFFICIENT', requiredScope: 'account', grantedScopes: ['mcp'] });
    expect(e.message).toBe('This OAuth credential is limited to the MCP surface.');
    expect(untouched(await row(id))).toEqual([null, null, null]);
  });

  it('answers a missing credential UNAUTHENTICATED, and a missing or deleted session BAD_USER_INPUT like updateSession', async () => {
    expect((await code(M.recordSessionOutcome({}, { sessionId: ownerSession, outcome: 0.5 }, ctxOf({})))).code).toBe('UNAUTHENTICATED');
    expect((await code(M.recordSessionOutcome({}, { sessionId: 'no-such-session', outcome: 0.5 }, asOwner()))).code).toBe('BAD_USER_INPUT');
    const gone = await mkSession(appA.id, owner.id);
    await db.session.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    expect((await code(M.recordSessionOutcome({}, { sessionId: gone, outcome: 0.5 }, asOwner()))).code).toBe('BAD_USER_INPUT');
    expect(untouched(await row(gone))).toEqual([null, null, null]);
  });

  it('is an outcome report, not driving: a lapsed session’s heartbeat does not move (#1543)', async () => {
    const id = await mkSession(appA.id, owner.id);
    const old = new Date('2026-01-01T00:00:00Z');
    await db.$executeRaw`UPDATE sessions SET updated_at = ${old}, started_at = ${old} WHERE id = ${id}`;
    await M.recordSessionOutcome({}, { sessionId: id, outcome: 0.5 }, asOwner());
    expect((await row(id)).updatedAt.getTime()).toBe(old.getTime());
  });
});

describe('POST /sessions/:id/outcome — every answer stays byte-identical', () => {
  it('the answers, status and body', async () => {
    expect(await rest(ownerSession, ownerJwt, { outcome: 2 })).toEqual({ status: 400, body: { error: 'outcome must be a number between 0 and 1' } });
    expect(await rest(ownerSession, ownerJwt, { outcome: '0.5' })).toEqual({ status: 400, body: { error: 'outcome must be a number between 0 and 1' } });
    expect(await rest(ownerSession, undefined)).toEqual({ status: 401, body: { error: 'A credential is required' } });
    expect(await rest('no-such-session', ownerJwt)).toEqual({ status: 404, body: { error: 'Session not found' } });
    expect(await rest(ownerSession, strangerJwt)).toEqual({ status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });
    expect(await rest(ownerSession, appBKey)).toEqual({ status: 403, body: { error: 'Forbidden', code: 'FORBIDDEN' } });
    expect(await rest(ownerSession, mcpOnlyKey)).toEqual({
      status: 403,
      body: { error: 'This OAuth credential is limited to the MCP surface.', code: 'FORBIDDEN', reason: 'OAUTH_SCOPE_INSUFFICIENT', requiredScope: 'account', grantedScopes: ['mcp'] },
    });
    expect(untouched(await row(ownerSession))).toEqual([null, null, null]);
    expect(await rest(ownerSession, ownerJwt, { outcome: 0.25, outcomeRef: 'r', outcomeMeta: { k: 1 } })).toEqual({ status: 200, body: { ok: true } });
    expect(await rest(userlessSession, appAKey, { outcome: 1 })).toEqual({ status: 200, body: { ok: true } });
    expect(await row(ownerSession)).toMatchObject({ outcome: 0.25, outcomeRef: 'r', outcomeMeta: { k: 1 } });
  });
});

describe('parity — the same inputs through the route and the mutation store the same thing', () => {
  it('for ok, for each refusal, and for the stored fields', async () => {
    const inputs = [
      { outcome: 0.6, outcomeRef: 'ref', outcomeMeta: { a: [1, { b: null }] } },
      { outcome: 0 },
      { outcome: 1, outcomeRef: null, outcomeMeta: null },
    ];
    for (const input of inputs) {
      const viaRest = await mkSession(appA.id, owner.id);
      const viaGql = await mkSession(appA.id, owner.id);
      expect((await rest(viaRest, ownerJwt, input)).status).toBe(200);
      await M.recordSessionOutcome({}, { sessionId: viaGql, ...input }, asOwner());
      const [a, b] = [await row(viaRest), await row(viaGql)];
      expect(untouched(b)).toEqual(untouched(a));
    }
    // The refusals agree on WHICH refusal, mapped to each surface's shape.
    const target = await mkSession(appA.id, owner.id);
    const pairs: [Promise<{ status: number }>, Promise<{ code: string }>, number, string][] = [
      [rest(target, ownerJwt, { outcome: 9 }), code(M.recordSessionOutcome({}, { sessionId: target, outcome: 9 }, asOwner())), 400, 'BAD_USER_INPUT'],
      [rest(target, strangerJwt), code(M.recordSessionOutcome({}, { sessionId: target, outcome: 0.8 }, asStranger())), 403, 'FORBIDDEN'],
      [rest('nope', ownerJwt), code(M.recordSessionOutcome({}, { sessionId: 'nope', outcome: 0.8 }, asOwner())), 404, 'BAD_USER_INPUT'],
      [rest(target, undefined), code(M.recordSessionOutcome({}, { sessionId: target, outcome: 0.8 }, ctxOf({}))), 401, 'UNAUTHENTICATED'],
    ];
    for (const [r, g, status, gqlCode] of pairs) {
      expect((await r).status).toBe(status);
      expect((await g).code).toBe(gqlCode);
    }
  });
});
