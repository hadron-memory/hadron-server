/**
 * #4471 — a busy store during request authentication answers typed and retryable, over the real `/graphql` handler.
 *
 * The API-key arms of `resolveAuthContextInner` read the store before any resolver runs, so a pool wait there
 * (P2024, or the P2028 'Unable to start a transaction' class) rejected the context builder and surfaced as an
 * untyped INTERNAL_SERVER_ERROR — 176 failures in Brooks's #4460 QA stayed untyped exactly this way (#4380).
 * The red pins below force those driver errors into `resolveUserApiKey`/`resolveAppKey` and require the typed
 * `AUTH_STORE_BUSY` refusal instead; the preservation pins hold every neighbouring answer byte-identical:
 * the JWT path keeps answering the ordinary internal error (cor:aut:010:05 S5 — a check that could not complete
 * is never a refusal), a verdict that needs no store stays a verdict mid-outage, and genuine key refusals on a
 * healthy store are unchanged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { signJwt } from '../../auth/jwt.js';
import { createSignIn } from '../../auth/signIn.js';
import { USER_API_KEY_PREFIX, hashUserApiKey, resolveAuthContext } from '../../middleware/auth.js';
import { AuthStoreBusyError, AUTH_STORE_BUSY_CODE } from '../../lib/auth/storeBusy.js';
import { Prisma } from '../../generated/prisma/index.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../test/startServerFixture.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;

beforeAll(async () => {
  http = httpServer(await createServerOnCleanDb());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(http); });
afterEach(() => vi.restoreAllMocks());

const Q = '{ authenticationStatus }';
const REFUSED_BODY = '{"data":{"authenticationStatus":"REFUSED"}}\n';

async function ask(authorization?: string): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) },
    body: JSON.stringify({ query: Q }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a non-JSON body fails the assertions with its text */ }
  return { status: res.status, text, json };
}

/** A real Prisma known-request error, so the classifier's instanceof + code test is exercised, not approximated. */
const known = (message: string, code: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });

const P2024 = 'Timed out fetching a new connection from the connection pool.';
const P2028_UNABLE_TO_START = 'Unable to start a transaction: the pool was full.';

let userId: string;
let userKey: string;
let appKey: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'ASB 4471', urn: 'asb4471.example' } });
  const user = await db.user.create({ data: { handle: 'asb4471-user', roles: ['READER'] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'READER' } });
  userKey = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId: user.id, oauthScopes: [], keyHash: hashUserApiKey(userKey), keyPreview: userKey.slice(-4) } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'ASB App', urn: 'asb4471.example:app' } });
  appKey = `hdr_app_${randomBytes(32).toString('hex')}`;
  await db.appKey.create({ data: { appId: app.id, keyHash: createHash('sha256').update(appKey).digest('hex'), keyPreview: appKey.slice(0, 12) } });
});

describe('#4471 red — a pool wait in the credential lookup answers typed and retryable, not INTERNAL_SERVER_ERROR', () => {
  it('P2024 forced in resolveUserApiKey ⇒ HTTP 503, AUTH_STORE_BUSY, retryable, POOL_WAIT, no driver text', async () => {
    vi.spyOn(db.userApiKey, 'findUnique').mockRejectedValue(known(P2024, 'P2024'));
    const r = await ask(`Bearer ${userKey}`);
    expect(r.status).toBe(503);
    expect(r.json.errors).toHaveLength(1);
    expect(r.json.errors[0].message).toBe(
      'Authentication could not complete: the store was busy. Nothing was written; the same request is safe to retry.',
    );
    expect(r.json.errors[0].extensions).toMatchObject({ code: AUTH_STORE_BUSY_CODE, retryable: true, reason: 'POOL_WAIT' });
    // No driver text, host or connection detail on the wire (the detail rides on .cause, server-side only).
    expect(r.text).not.toContain('Timed out');
    expect(r.text).not.toContain('connection pool');
    expect(r.text).not.toContain('P2024');
  });

  it("P2028 'unable to start' forced in resolveUserApiKey ⇒ the same typed refusal (the issue names both arms)", async () => {
    vi.spyOn(db.userApiKey, 'findUnique').mockRejectedValue(known(P2028_UNABLE_TO_START, 'P2028'));
    const r = await ask(`Bearer ${userKey}`);
    expect(r.status).toBe(503);
    expect(r.json.errors[0].extensions).toMatchObject({ code: AUTH_STORE_BUSY_CODE, retryable: true, reason: 'POOL_WAIT' });
    expect(r.text).not.toContain('Unable to start');
    expect(r.text).not.toContain('P2028');
  });

  it('P2024 forced in resolveAppKey ⇒ the SAME typed code: the code must not vary with the credential presented', async () => {
    vi.spyOn(db.appKey, 'findUnique').mockRejectedValue(known(P2024, 'P2024'));
    const r = await ask(`Bearer ${appKey}`);
    expect(r.status).toBe(503);
    expect(r.json.errors[0].extensions).toMatchObject({ code: AUTH_STORE_BUSY_CODE, retryable: true, reason: 'POOL_WAIT' });
  });
});

describe('#4471 preservation — every neighbouring answer is byte-identical', () => {
  it('the JWT path keeps its #3532 answer: a check that could not complete is the internal error, never REFUSED (S5)', async () => {
    const signIn = await db.$transaction((tx) => createSignIn(tx, { userId, method: 'email', passkeyId: null }));
    const jwt = await signJwt({ sub: userId, roles: [], email: 'u@example.com', sid: signIn.id });
    vi.spyOn(db.user, 'findFirst').mockRejectedValue(known(P2024, 'P2024'));
    const r = await ask(`Bearer ${jwt}`);
    // resolveJwt swallows the fault into an incomplete check; authenticationStatus then answers the ordinary
    // internal error. This pin holds that answer byte-identical — no AUTH_STORE_BUSY on the JWT path.
    expect(r.status).toBe(200);
    expect(r.json.data).toBe(null);
    expect(r.json.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
    expect(r.json.errors[0].message).toBe('Internal server error.');
    expect(r.text).not.toContain('REFUSED');
    expect(r.text).not.toContain(AUTH_STORE_BUSY_CODE);
  });

  it('a verdict that needs no store stays a verdict mid-outage: garbage JWT and length-prechecked user key ⇒ exactly REFUSED_BODY', async () => {
    vi.spyOn(db.userApiKey, 'findUnique').mockRejectedValue(known(P2024, 'P2024'));
    expect((await ask('Bearer not.a.jwt-at-all')).text).toBe(REFUSED_BODY);
    // USER_API_KEY_PREFIX + the wrong length never touches the DB (the precheck), so the outage cannot change it.
    expect((await ask(`Bearer ${USER_API_KEY_PREFIX}${'a'.repeat(8)}`)).text).toBe(REFUSED_BODY);
  });

  it('genuine key refusals on a healthy store are unchanged: revoked and unknown keys ⇒ exactly REFUSED_BODY', async () => {
    const unknown = await ask(`Bearer ${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`);
    expect(unknown.text).toBe(REFUSED_BODY);
    const rawRevoked = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
    await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(rawRevoked), keyPreview: rawRevoked.slice(-4), revokedAt: new Date() } });
    const revoked = await ask(`Bearer ${rawRevoked}`);
    expect(revoked.text).toBe(REFUSED_BODY);
  });

  it('the REST boundary keeps the fault envelope: GET /graphql/schema under a forced P2024 is the unchanged #1789 answer', async () => {
    vi.spyOn(db.userApiKey, 'findUnique').mockRejectedValue(known(P2024, 'P2024'));
    const res = await fetch(`${base}/graphql/schema`, { headers: { authorization: `Bearer ${userKey}` } });
    const body: any = await res.json();
    // Out of #4471's scope (stated on the PR): the typed conversion is delivered by formatError on /graphql;
    // the REST routes keep cor:api:260:01's generic fault envelope, which already conceals the driver text.
    expect(res.status).toBe(500);
    expect(body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.error).toBe('Internal server error.');
    expect(typeof body.requestId).toBe('string');
  });
});

describe('#4471 unit — the typed refusal itself', () => {
  it('preserves the original driver error on .cause and names the arm', () => {
    const original = known(P2024, 'P2024');
    const err = new AuthStoreBusyError(original);
    expect(err.extensions).toMatchObject({ code: AUTH_STORE_BUSY_CODE, retryable: true, reason: 'POOL_WAIT' });
    expect(err.cause).toBe(original);
    const startWait = new AuthStoreBusyError(known(P2028_UNABLE_TO_START, 'P2028'));
    expect(startWait.extensions.reason).toBe('POOL_WAIT');
  });

  it('a NON-busy driver error from the credential lookup rethrows unconverted (identical reference)', async () => {
    vi.spyOn(db.userApiKey, 'findUnique').mockRejectedValue(known('The table does not exist.', 'P2021'));
    const req = { headers: { authorization: `Bearer ${userKey}` } } as never;
    await expect(resolveAuthContext(req, db)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2021');
      return true;
    });
  });

  it('a plain Error (not a driver error) rethrows unconverted too — the catch is narrow, busy-only', async () => {
    const plain = new Error('jwt store exploded');
    vi.spyOn(db.userApiKey, 'findUnique').mockRejectedValue(plain);
    const req = { headers: { authorization: `Bearer ${userKey}` } } as never;
    await expect(resolveAuthContext(req, db)).rejects.toBe(plain);
  });

  it('AuthStoreBusyError is a GraphQLError the formatError list can match by instance', () => {
    expect(new AuthStoreBusyError(known(P2024, 'P2024'))).toBeInstanceOf(GraphQLError);
  });

  it("formatGraphQLError unwraps Apollo's context-failure wrap and merges the typed extensions (direct pin on the mapping entry)", async () => {
    // The wire pins above pass through Apollo's current pass-through of a context-throw GraphQLError,
    // so they cannot see the formatError entry; this pins the entry's own guarantee (#4455's reason for
    // mapping an already-coded GraphQLError): even wrapped — the wrapper wearing INTERNAL_SERVER_ERROR,
    // the refusal on .originalError — the boundary answers the domain message and the typed extensions,
    // never the wrapper's code.
    const { formatGraphQLError } = await import('./formatError.js');
    const original = new AuthStoreBusyError(known(P2024, 'P2024'));
    const wrapper = new GraphQLError('Context creation failed!', {
      originalError: original,
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
    const formatted = formatGraphQLError({ message: wrapper.message, extensions: { code: 'INTERNAL_SERVER_ERROR' } }, wrapper);
    expect(formatted.message).toBe(original.message);
    expect(formatted.extensions).toMatchObject({ code: AUTH_STORE_BUSY_CODE, retryable: true, reason: 'POOL_WAIT' });
  });
});
