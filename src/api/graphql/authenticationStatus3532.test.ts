/**
 * #3532 — `authenticationStatus` (cor:aut:010:05 S1–S6), over the real `/graphql` handler.
 *
 * The field answers about THIS request's own credential: AUTHENTICATED (a user or App resolved), REFUSED (a
 * credential was presented and did not authenticate, one answer for every cause), ANONYMOUS (none presented). A check
 * that could not complete is the ordinary internal error, never REFUSED.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { signJwt } from '../../auth/jwt.js';
import { createSignIn } from '../../auth/signIn.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;

beforeAll(async () => {
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); });
afterEach(() => vi.restoreAllMocks());

const Q = '{ authenticationStatus }';

async function ask(authorization?: string, query = Q): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a non-JSON body fails the byte assertions with its text */ }
  return { status: res.status, text, json };
}

const REFUSED_BODY = '{"data":{"authenticationStatus":"REFUSED"}}\n';

let userId: string;
let liveSignInId: string;
let tokens: Record<string, string>;
let userKey: string;
let appKey: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'AS 3532', urn: 'as3532.example' } });
  const user = await db.user.create({ data: { handle: 'as3532-user', roles: ['READER'] } });
  userId = user.id;
  const admin = await db.user.create({ data: { handle: 'as3532-admin', roles: ['ADMIN'] } });
  const target = await db.user.create({ data: { handle: 'as3532-target', roles: ['READER'] } });
  const doomed = await db.user.create({ data: { handle: 'as3532-doomed', roles: ['READER'] } });
  await db.orgMember.createMany({
    data: [
      { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
      { organizationId: org.id, userId: target.id, role: 'READER' },
    ],
  });
  const live = await db.$transaction((tx) => createSignIn(tx, { userId: user.id, method: 'email', passkeyId: null }));
  liveSignInId = live.id;
  const ended = await db.$transaction((tx) => createSignIn(tx, { userId: user.id, method: 'email', passkeyId: null }));
  await db.signIn.update({ where: { id: ended.id }, data: { endedAt: new Date(), endReason: 'test' } });
  const doomedSignIn = await db.$transaction((tx) => createSignIn(tx, { userId: doomed.id, method: 'email', passkeyId: null }));
  await db.user.update({ where: { id: doomed.id }, data: { deletedAt: new Date() } });

  const endedImp = await db.impersonationSession.create({
    data: { adminUserId: admin.id, targetUserId: target.id, organizationId: org.id, expiresAt: new Date(Date.now() + 60_000), endedAt: new Date() },
  });
  const demotedTargetImp = await db.impersonationSession.create({
    data: { adminUserId: admin.id, targetUserId: target.id, organizationId: org.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  // Role change after mint: the target is removed from the org, so the live session fails the peer-or-below check.
  await db.orgMember.updateMany({ where: { organizationId: org.id, userId: target.id }, data: { deletedAt: new Date() } });
  const liveImp = await db.impersonationSession.create({
    data: { adminUserId: admin.id, targetUserId: user.id, organizationId: org.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'READER' } });

  const wrongKey = new TextEncoder().encode('a-different-secret-that-is-long-enough-xx');
  const badSig = await new SignJWT({ sub: user.id, roles: [], sid: liveSignInId })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setIssuer('hadron-server').setAudience('hadron').setExpirationTime('7d').sign(wrongKey);

  const ghost = generateId();
  tokens = {
    unknownSubLegacy: await signJwt({ sub: ghost, roles: [], email: 'ghost@example.com' }),
    live: await signJwt({ sub: user.id, roles: [], email: 'u@example.com', sid: liveSignInId }),
    garbage: 'not.a.jwt-at-all',
    garbageOpaque: 'zzzz',
    badSignature: badSig,
    expired: await signJwt({ sub: user.id, roles: [], email: 'u@example.com', sid: liveSignInId }, { expiresIn: -60 }),
    endedSignIn: await signJwt({ sub: user.id, roles: [], email: 'u@example.com', sid: ended.id }),
    neverValidSid: await signJwt({ sub: user.id, roles: [], email: 'u@example.com', sid: generateId() }),
    deletedUser: await signJwt({ sub: doomed.id, roles: [], email: 'd@example.com', sid: doomedSignIn.id }),
    endedImpersonation: await signJwt({ sub: target.id, roles: [], imp: { sid: endedImp.id, act: admin.id, org: org.id } }),
    demotedTargetImpersonationTarget: await signJwt({ sub: target.id, roles: [], imp: { sid: demotedTargetImp.id, act: admin.id, org: org.id } }),
    liveImpersonation: await signJwt({ sub: user.id, roles: [], imp: { sid: liveImp.id, act: admin.id, org: org.id } }),
  };

  userKey = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId: user.id, oauthScopes: [], keyHash: hashUserApiKey(userKey), keyPreview: userKey.slice(-4) } });
  const revoked = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId: user.id, oauthScopes: [], keyHash: hashUserApiKey(revoked), keyPreview: revoked.slice(-4), revokedAt: new Date() } });
  tokens.revokedUserKey = revoked;

  const app = await db.app.create({ data: { organizationId: org.id, name: 'AS App', urn: 'as3532.example:app' } });
  appKey = `hdr_app_${randomBytes(32).toString('hex')}`;
  await db.appKey.create({ data: { appId: app.id, keyHash: createHash('sha256').update(appKey).digest('hex'), keyPreview: appKey.slice(0, 12) } });
  tokens.unknownAppKey = `hdr_app_${randomBytes(32).toString('hex')}`;
});

describe('#3532 pin 1/S3 — every invalid credential is the byte-identical REFUSED answer', () => {
  const causes = [
    'unknownSubLegacy', 'garbage', 'garbageOpaque', 'badSignature', 'expired', 'endedSignIn', 'neverValidSid', 'deletedUser',
    'endedImpersonation', 'demotedTargetImpersonationTarget', 'revokedUserKey', 'unknownAppKey',
  ] as const;
  for (const cause of causes) {
    it(`${cause} ⇒ HTTP 200 and exactly ${REFUSED_BODY}`, async () => {
      const r = await ask(`Bearer ${tokens[cause]}`);
      expect(r.status).toBe(200);
      expect(r.text).toBe(REFUSED_BODY);
    });
  }

  it('S3 — a Bearer with an empty token is REFUSED (ruling 0193), however the transport trims the header', async () => {
    for (const header of ['Bearer ', 'Bearer']) {
      const r = await ask(header);
      expect(r.status).toBe(200);
      expect(r.text).toBe(REFUSED_BODY);
    }
  });
});

describe('#3532 pin 2/S4 — an ended sign-in is not distinguishable from a never-valid token', () => {
  it('identical status and bytes', async () => {
    const ended = await ask(`Bearer ${tokens.endedSignIn}`);
    const never = await ask(`Bearer ${tokens.neverValidSid}`);
    const junk = await ask(`Bearer ${tokens.garbage}`);
    expect(ended.status).toBe(never.status);
    expect(ended.text).toBe(never.text);
    expect(ended.text).toBe(junk.text);
    expect(ended.text).toBe(REFUSED_BODY);
  });
});

describe('#3532 pin 3/S1/S2 — authenticated and anonymous', () => {
  it('S2 — no header, and a non-Bearer scheme (ruling 0192), are ANONYMOUS', async () => {
    expect((await ask()).text).toBe('{"data":{"authenticationStatus":"ANONYMOUS"}}\n');
    expect((await ask('Basic dXNlcjpwYXNz')).text).toBe('{"data":{"authenticationStatus":"ANONYMOUS"}}\n');
  });

  it('S1 — a live sign-in JWT, a live hdr_user_ key, a live hdr_app_ key and a live impersonation JWT are AUTHENTICATED', async () => {
    for (const token of [tokens.live, userKey, appKey, tokens.liveImpersonation]) {
      const r = await ask(`Bearer ${token}`);
      expect(r.status).toBe(200);
      expect(r.text).toBe('{"data":{"authenticationStatus":"AUTHENTICATED"}}\n');
    }
  });

  it('ruling 0194 — a valid credential naming a refused worker session is still AUTHENTICATED', async () => {
    const res = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userKey}`, 'x-hadron-session': generateId() },
      body: JSON.stringify({ query: Q }),
    });
    expect(await res.text()).toBe('{"data":{"authenticationStatus":"AUTHENTICATED"}}\n');
  });
});

describe('#3532 pin 4/S5 — an incomplete check is the ordinary internal error, never REFUSED', () => {
  it.each([
    ['sign-in lookup', () => vi.spyOn(db.signIn, 'findFirst')],
    ['user lookup', () => vi.spyOn(db.user, 'findFirst')],
  ])('a database failure during JWT verification (%s) ⇒ INTERNAL_SERVER_ERROR', async (_label, spy) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    spy().mockRejectedValue(new Error('connection reset'));
    const r = await ask(`Bearer ${tokens.live}`);
    expect(r.text).not.toContain('REFUSED');
    expect(r.json.data?.authenticationStatus ?? null).toBeNull();
    expect(r.json.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(r.json.errors?.[0]?.message).toBe('Internal server error.');
  });

  // #3537 BLIND P2-1: the key resolvers have no catch, so a database fault there propagates out of the context
  // builder; it must never read as REFUSED either.
  it.each([
    ['hdr_user_ key lookup', () => vi.spyOn(db.userApiKey, 'findUnique'), () => userKey],
    ['hdr_app_ key lookup', () => vi.spyOn(db.appKey, 'findUnique'), () => appKey],
  ])('a database failure during %s is an internal error, never REFUSED', async (_label, spy, token) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    spy().mockRejectedValue(new Error('connection reset'));
    const r = await ask(`Bearer ${token()}`);
    expect(r.text).not.toContain('REFUSED');
    expect(r.text).not.toContain('AUTHENTICATED');
    expect(JSON.stringify(r.json)).toContain('INTERNAL_SERVER_ERROR');
  });

  it('a missing JWT secret is also an incomplete check, not a refusal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const r = await ask(`Bearer ${tokens.live}`);
      expect(r.text).not.toContain('REFUSED');
      expect(r.json.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });

  it('the same request’s `me` and `authContext` stay null, exactly as before', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db.signIn, 'findFirst').mockRejectedValue(new Error('connection reset'));
    const r = await ask(`Bearer ${tokens.live}`, '{ me { id } authContext { principalType } }');
    expect(r.json).toEqual({ data: { me: null, authContext: null } });
  });
});

describe('#3537 BLIND P2-3 — a surface that never resolves a status', () => {
  it('the resolver answers the internal error rather than guessing (only /graphql sets it; MCP never runs this field)', async () => {
    const { resolvers } = await import('./schema/resolvers.js');
    const field = (resolvers.Query as any).authenticationStatus;
    await expect(field(null, {}, { db })).rejects.toThrow(/did not complete/);
    await expect(field(null, {}, { db, credentialStatus: 'unavailable' })).rejects.toThrow(/did not complete/);
    await expect(field(null, {}, { db, credentialStatus: 'refused' })).resolves.toBe('REFUSED');
  });
});

describe('#3532 pin 5/S6 — consumers unchanged', () => {
  it.each(['garbage', 'endedSignIn'] as const)('me and authContext are null for a refused %s credential', async (cause) => {
    const r = await ask(`Bearer ${tokens[cause]}`, '{ me { id } authContext { principalType } }');
    expect(r.json).toEqual({ data: { me: null, authContext: null } });
  });

  it('a refused credential still reads a PUBLIC memory anonymously and is told REFUSED', async () => {
    const org = await db.organization.findFirstOrThrow();
    await db.memory.create({
      data: { name: 'pub3532', urn: 'as3532.example:pub', organizationId: org.id, class: 'knowledge', visibility: 'PUBLIC' } as never,
    });
    const r = await ask(`Bearer ${tokens.endedSignIn}`, '{ authenticationStatus memory(ref: "as3532.example:pub") { name } }');
    expect(r.status).toBe(200);
    expect(r.json.data.authenticationStatus).toBe('REFUSED');
    expect(r.json.data.memory?.name).toBe('pub3532');
  });

  it('the field takes no argument, so it cannot test a token the caller does not hold', async () => {
    const r = await ask(undefined, `{ authenticationStatus(token: "${tokens.live}") }`);
    expect(r.json.errors?.[0]?.message).toMatch(/Unknown argument "token"/);
  });
});
