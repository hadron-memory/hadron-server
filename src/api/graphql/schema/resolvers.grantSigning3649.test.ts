/**
 * #3649 slice B (cor:acl:140:07; the node-signing mirror cor:dmo:130:02/:03): grant signing requests over real GraphQL POSTs.
 * R1p create pins one grant's version and terms hash; R2p refusals before any write, each typed, one answer for unknown and
 * unreadable; R3p a bound worker may ASK, and no GraphQL call takes an assertion or completes; R4p withdraw is the requester
 * account's alone. Grant rows come from the S1a fixtures (no production grant writer exists; gate selection 2). Callers a
 * request cannot reach (impersonation, an App key) go through the resolver.
 */
import { ApolloServer } from '@apollo/server';
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { grantTermsFromRow, grantTermsHash } from '../../../lib/grants/terms.js';
import { resolvers, type Context } from './resolvers.js';
import { deploymentSchema } from './deploymentSchema.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;
let direct: ApolloServer<Context>;
beforeAll(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  const { createServer } = await import('../../../server.js');
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const schema = deploymentSchema();
  direct = new ApolloServer<Context>({ typeDefs: schema.typeDefs, resolvers: schema.resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
  await direct.start();
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); await direct.stop(); await cleanDb(db); await dropTestActions(); vi.unstubAllEnvs(); });

let w: World;
let workerKey: string;
let sessionId: string;
let otherAppSessionId: string;
let personKey: string;
let personSessionId: string;
let personWorkerId: string;

async function keyFor(userId: string): Promise<string> {
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  return k;
}
async function post(key: string, session: string | null, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(session ? { 'x-hadron-session': session } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}
const REQUEST = 'mutation($g:ID!){requestGrantSignature(grantRef:$g){id grantId version termsHash payloadVersion state requestedBy{userId appId workerId sessionId} createdAt expiresAt endedAt}}';
const WITHDRAW = 'mutation($id:ID!){withdrawGrantSigningRequest(id:$id){id state endedAt}}';
const READ = 'query($id:ID!){grantSigningRequest(id:$id){id grantId state}}';
const asWorker = (q: string, v: Record<string, unknown> = {}) => post(workerKey, sessionId, q, v);
const code = (r: any): string | undefined => r.errors?.[0]?.extensions?.code;
const requestCount = async () => db.grantSigningRequest.count();

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  for (const userId of [w.userId, w.user2Id]) await db.orgMember.create({ data: { organizationId: w.orgId, userId, role: 'CONTRIBUTOR' } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  workerKey = await keyFor(w.userId);
  const otherAppWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.app2Id, agentId: w.agentId, name: 'o', slug: `o-${generateId().slice(0, 6)}`, heldByUserId: w.userId } });
  otherAppSessionId = (await db.session.create({ data: { id: generateId(), appId: w.app2Id, userId: w.userId, workerId: otherAppWorker.id, agentId: w.agentId } })).id;
  // Another person driving another worker in the same App: may read the grants naming THAT worker, not this one's.
  personKey = await keyFor(w.user2Id);
  personWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}`, heldByUserId: w.user2Id } })).id;
  personSessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.user2Id, workerId: personWorkerId, agentId: w.agentId } })).id;
});

const held = (over: Record<string, unknown> = {}) => insertGrant(w, { user_id: null, worker_id: w.workerId, ...over } as never);

describe('R1p: a bound worker asks for one pending grant to be signed', () => {
  it('opens one request pinning the grant\'s version and terms hash, recording who asked', async () => {
    const g = await held({ action_values: { entryNode: 'n1' } });
    const r = await asWorker(REQUEST, { g });
    expect(r.errors).toBeUndefined();
    const grant = await db.grant.findUniqueOrThrow({ where: { id: g } });
    expect(r.data.requestGrantSignature).toMatchObject({
      grantId: g, version: grant.version, termsHash: grantTermsHash(grantTermsFromRow(grant)), payloadVersion: 'hadron-grant-signature-v1',
      state: 'OPEN', endedAt: null, requestedBy: { userId: w.userId, appId: null, workerId: w.workerId, sessionId },
    });
    expect(await requestCount()).toBe(1);
    // A pending grant the worker requested for someone else is readable to it, so it may ask for that one too.
    const requested = await insertGrant(w, { requested_by_worker_id: w.workerId });
    expect((await asWorker(REQUEST, { g: requested })).data.requestGrantSignature.grantId).toBe(requested);
    // The read: the same reader sees it; null for everyone else.
    const id = r.data.requestGrantSignature.id;
    expect((await asWorker(READ, { id })).data.grantSigningRequest).toMatchObject({ id, grantId: g, state: 'OPEN' });
    for (const [key, session] of [[personKey, personSessionId], [workerKey, otherAppSessionId], [workerKey, null]] as const) {
      expect((await post(key, session, READ, { id })).data.grantSigningRequest).toBeNull();
    }
    expect((await asWorker(READ, { id: 'AAAAAAAAAAAAAAAAAAAAAA' })).data.grantSigningRequest).toBeNull();
  });
});

describe('R2p: refusals before any write, typed, and one answer for unknown and unreadable', () => {
  it('GRANT_NOT_FOUND for a missing grant and for every grant the caller may not read, byte for byte', async () => {
    const unreadable = [
      await insertGrant(w, { user_id: w.user2Id }), // a person's
      await insertGrant(w, { user_id: null, worker_id: personWorkerId }), // another worker's
      await insertGrant(w, { user_id: null, agent_id: w.agentId }), // the role agent's (S2b reads it, not S2a)
      await insertGrant(w, { app_id: w.app2Id, user_id: null, worker_id: w.workerId } as never), // another App's
    ];
    const missing = await asWorker(REQUEST, { g: 'no-such-grant' });
    expect(code(missing)).toBe('GRANT_NOT_FOUND');
    for (const g of unreadable) {
      const r = await asWorker(REQUEST, { g });
      expect(code(r), g).toBe('GRANT_NOT_FOUND');
      expect(JSON.stringify(r).replaceAll(g, 'X')).toBe(JSON.stringify(missing).replaceAll('no-such-grant', 'X'));
    }
    // Callers who read no grants at all: a person with no worker session, and a worker of another App.
    const g = await held();
    for (const [key, session] of [[workerKey, null], [workerKey, otherAppSessionId], [personKey, null]] as const) {
      expect(code(await post(key, session, REQUEST, { g })), `${session}`).toBe('GRANT_NOT_FOUND');
    }
    expect(await requestCount()).toBe(0);
  });

  it('GRANT_NOT_PENDING (no state named), GRANT_EXPIRED and GRANT_TERMS_UNREPRESENTABLE, writing nothing', async () => {
    const activated = { activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 'test' };
    const notPending = [
      await insertGrantUnguarded(w, { user_id: null, worker_id: w.workerId, ...activated }),
      await insertGrantUnguarded(w, { user_id: null, worker_id: w.workerId, revoked_at: raw(DB_NOW), revoked_by: 'someone' }),
      await insertGrantUnguarded(w, { user_id: null, worker_id: w.workerId, holder_departed_at: raw(DB_NOW) }),
    ];
    const bodies = [];
    for (const g of notPending) {
      const r = await asWorker(REQUEST, { g });
      expect(code(r), g).toBe('GRANT_NOT_PENDING');
      expect(Object.keys(r.errors[0].extensions).sort()).toEqual(['code', 'grantRef']);
      bodies.push(JSON.stringify(r).replaceAll(g, 'X'));
    }
    expect(new Set(bodies).size).toBe(1); // activated, revoked and departed answer alike: no state label
    const expired = await insertGrantUnguarded(w, { user_id: null, worker_id: w.workerId, expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    expect(code(await asWorker(REQUEST, { g: expired }))).toBe('GRANT_EXPIRED');
    const bad = await held({ action_values: { entryNode: 7 } });
    const r = await asWorker(REQUEST, { g: bad });
    expect(code(r)).toBe('GRANT_TERMS_UNREPRESENTABLE');
    expect(r.errors[0].extensions.reason).toBe('BAD_VALUES');
    expect(await requestCount()).toBe(0);
  });

  it('FORBIDDEN while impersonating, before any read, even for a grant the person could read', async () => {
    const g = await held();
    const ctx = { db, userId: w.userId, roles: [], impersonation: { sessionId: generateId(), actorUserId: w.user2Id, orgId: w.orgId, expiresAt: new Date(Date.now() + 60_000) } } as Context;
    for (const [query, variables] of [[REQUEST, { g }], [WITHDRAW, { id: 'AAAAAAAAAAAAAAAAAAAAAA' }]] as const) {
      const a = await runAsActor({ workerId: w.workerId, agentId: w.agentId, userId: w.userId }, () =>
        direct.executeOperation({ query, variables }, { contextValue: ctx }));
      if (a.body.kind !== 'single') throw new Error('incremental');
      expect(a.body.singleResult.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    }
    expect(await requestCount()).toBe(0);
  });
});

describe('R3p: a worker may ask, never sign; an App key reads no grant and cannot ask', () => {
  it('no GraphQL field takes an assertion or completes a grant signing request', async () => {
    const { typeDefs } = deploymentSchema();
    const fields = [...typeDefs.matchAll(/^\s+(\w*[Gg]rant\w*Sign\w*|\w*[Ss]ign\w*Grant\w*)\s*\(/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(['grantSigningRequest', 'requestGrantSignature', 'withdrawGrantSigningRequest']);
    expect(typeDefs).not.toMatch(/complete\w*GrantSign|GrantSign\w*complete|declineGrant|activateGrant/i);
  });

  it('an App key gets GRANT_NOT_FOUND and records nothing', async () => {
    const g = await held();
    const a = await direct.executeOperation({ query: REQUEST, variables: { g } }, { contextValue: { db, appId: w.appId, appKeyId: generateId(), roles: [] } as Context });
    if (a.body.kind !== 'single') throw new Error('incremental');
    expect(a.body.singleResult.errors?.[0]?.extensions?.code).toBe('GRANT_NOT_FOUND');
    expect(await requestCount()).toBe(0);
  });
});

describe('R4p: withdraw is the requester account\'s alone, once', () => {
  it('the requester withdraws; an ended request refuses SIGNING_REQUEST_ENDED with its state', async () => {
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    const r = await asWorker(WITHDRAW, { id });
    expect(r.errors).toBeUndefined();
    expect(r.data.withdrawGrantSigningRequest.state).toBe('WITHDRAWN');
    expect(r.data.withdrawGrantSigningRequest.endedAt).not.toBeNull();
    const again = await asWorker(WITHDRAW, { id });
    expect(code(again)).toBe('SIGNING_REQUEST_ENDED');
    expect(again.errors[0].extensions.state).toBe('WITHDRAWN');
  });

  it('a request ended by its grant\'s revocation reads STALE and refuses withdrawal with that state', async () => {
    const g = await held();
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    await db.$executeRawUnsafe(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = 'someone' WHERE id = $1`, g);
    expect((await asWorker(READ, { id })).data.grantSigningRequest.state).toBe('STALE');
    const r = await asWorker(WITHDRAW, { id });
    expect(code(r)).toBe('SIGNING_REQUEST_ENDED');
    expect(r.errors[0].extensions.state).toBe('STALE');
  });

  it('another account that may read the grant is refused SIGNING_REQUEST_NOT_REQUESTER; one that may not read it, NOT_FOUND', async () => {
    // A pending grant held by the OTHER person's worker, requested by this worker: both may read it.
    const g = await insertGrant(w, { user_id: null, worker_id: personWorkerId, requested_by_worker_id: w.workerId });
    const id = (await asWorker(REQUEST, { g })).data.requestGrantSignature.id;
    expect(code(await post(personKey, personSessionId, WITHDRAW, { id }))).toBe('SIGNING_REQUEST_NOT_REQUESTER');
    const unknown = await post(personKey, null, WITHDRAW, { id });
    expect(code(unknown)).toBe('SIGNING_REQUEST_NOT_FOUND');
    expect(JSON.stringify(unknown).replaceAll(id, 'X'))
      .toBe(JSON.stringify(await post(personKey, null, WITHDRAW, { id: 'AAAAAAAAAAAAAAAAAAAAAA' })).replaceAll('AAAAAAAAAAAAAAAAAAAAAA', 'X'));
    expect((await asWorker(READ, { id })).data.grantSigningRequest.state).toBe('OPEN');
  });
});

describe('the switch: grant signing rides PASSKEY_SIGNING_ENABLED', () => {
  it('switched off, the grant signing types and fields are absent from the schema', () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    try {
      const { typeDefs } = deploymentSchema();
      expect(typeDefs).not.toMatch(/GrantSigningRequest|requestGrantSignature|withdrawGrantSigningRequest|grantSigningRequest/);
    } finally {
      vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    }
  });
});
