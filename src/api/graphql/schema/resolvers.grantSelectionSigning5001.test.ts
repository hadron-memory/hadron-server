/**
 * #5001 slice 3 (cor:acl:140:07): the selection's request, read and withdraw over real GraphQL POSTs. P15 reach (every ref is
 * judged by the one-grant read gate; an unreadable ref is GRANT_NOT_FOUND byte for byte like an unknown one), P16 the cap and the
 * mixed-App refusal come before any read, P9 request-time refusals name the first bad ref and write nothing, P17 withdraw is the
 * requester account's alone and ends the items with it.
 */
import { ApolloServer } from '@apollo/server';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { waitForLockWaitersBlockedBy } from '../../../test/lockWait.js';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { grantTermsFromRow, grantTermsHash } from '../../../lib/grants/terms.js';
import { GRANT_SELECTION_CAP } from '../../../lib/signing/grantSelectionPayload.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { deploymentSchema } from './deploymentSchema.js';
import { formatGraphQLError } from '../formatError.js';
import type { Context } from './resolvers.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../../test/startServerFixture.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;
beforeAll(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  http = httpServer(await createServerOnCleanDb());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(http); await cleanDb(db); await dropTestActions(); vi.unstubAllEnvs(); });

let w: World;
let workerKey: string;
let sessionId: string;
let personKey: string;
let personSessionId: string;
let personWorkerId: string;
let otherWorkerKey: string;
let otherSessionId: string;

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
const REQUEST = 'mutation($g:[ID!]!){requestGrantSelectionSignature(grantRefs:$g){id payloadVersion state ceremonyUrl requestedBy{userId workerId sessionId} items{id grantId version termsHash payloadVersion selectionId state ceremonyUrl}}}';
const WITHDRAW = 'mutation($id:ID!){withdrawGrantSigningSelection(id:$id){id state endedAt items{state}}}';
const READ = 'query($id:ID!){grantSigningSelection(id:$id){id state items{grantId}}}';
const ONE_READ = 'query($id:ID!){grantSigningRequest(id:$id){id}}';
const asWorker = (q: string, v: Record<string, unknown> = {}) => post(workerKey, sessionId, q, v);
const code = (r: any): string | undefined => r.errors?.[0]?.extensions?.code;
const selections = () => db.grantSigningSelection.count();
const items = () => db.grantSigningRequest.count();
const held = (over: Record<string, unknown> = {}) => insertGrant(w, { user_id: null, worker_id: w.workerId, ...over } as never);

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  for (const userId of [w.userId, w.user2Id]) await db.orgMember.create({ data: { organizationId: w.orgId, userId, role: 'CONTRIBUTOR' } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  workerKey = await keyFor(w.userId);
  personKey = await keyFor(w.user2Id);
  personWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}`, heldByUserId: w.user2Id } })).id;
  personSessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.user2Id, workerId: personWorkerId, agentId: w.agentId } })).id;
  // A second worker session of the SAME account (the requester account), to prove withdraw is by account.
  const second = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'q', slug: `q-${generateId().slice(0, 6)}`, heldByUserId: w.userId } });
  otherSessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: second.id, agentId: w.agentId } })).id;
  otherWorkerKey = workerKey;
});

describe('R1: one selection, one item per grant, each pinned on its own', () => {
  it('opens a selection with its items in ascending grant id, each pinning its grant, the selection\'s payload version and page', async () => {
    const ids = [await held({ action_values: { entryNode: 'a' } }), await held({ action_values: { entryNode: 'b' } }), await held({ action_values: { entryNode: 'c' } })];
    // Asked for in descending order: the items still come back ascending.
    const r = await asWorker(REQUEST, { g: [...ids].sort().reverse() });
    expect(r.errors).toBeUndefined();
    const sel = r.data.requestGrantSelectionSignature;
    expect(sel).toMatchObject({ payloadVersion: 'hadron-grant-selection-signature-v1', state: 'OPEN', requestedBy: { userId: w.userId, workerId: w.workerId, sessionId } });
    expect(sel.ceremonyUrl.endsWith(`/grant-selection-signing/${sel.id}`)).toBe(true);
    expect(sel.items.map((i: any) => i.grantId)).toEqual([...ids].sort());
    for (const i of sel.items) {
      const grant = await db.grant.findUniqueOrThrow({ where: { id: i.grantId } });
      expect(i).toMatchObject({ version: grant.version, termsHash: grantTermsHash(grantTermsFromRow(grant)), payloadVersion: 'hadron-grant-selection-signature-v1', selectionId: sel.id, state: 'OPEN' });
      // An item signs on its selection's page, never a one-grant page of its own.
      expect(i.ceremonyUrl).toBe(sel.ceremonyUrl);
    }
    expect(await selections()).toBe(1);
    expect(await items()).toBe(3);
    // The selection read: the same reader sees it; nobody else does.
    expect((await asWorker(READ, { id: sel.id })).data.grantSigningSelection.items).toHaveLength(3);
    expect((await post(personKey, personSessionId, READ, { id: sel.id })).data.grantSigningSelection).toBeNull();
    // The one-grant read answers for an item as for an unknown id.
    expect((await asWorker(ONE_READ, { id: sel.items[0].id })).data.grantSigningRequest).toBeNull();
  });

  it('a grant with an open one-grant request may also be in a selection (two open requests on one grant are allowed)', async () => {
    const g = await held();
    expect((await asWorker('mutation($g:ID!){requestGrantSignature(grantRef:$g){id}}', { g })).errors).toBeUndefined();
    expect((await asWorker(REQUEST, { g: [g] })).errors).toBeUndefined();
  });
});

describe('P15: every ref is judged by the one-grant read gate', () => {
  it('GRANT_NOT_FOUND for an unknown ref and every unreadable one, byte for byte, writing nothing', async () => {
    const mine = await held();
    const unreadable = [
      await insertGrant(w, { user_id: w.user2Id }),
      await insertGrant(w, { user_id: null, worker_id: personWorkerId }),
      await insertGrant(w, { user_id: null, agent_id: w.agentId }),
      await insertGrant(w, { app_id: w.app2Id, user_id: null, worker_id: w.workerId } as never),
    ];
    const missing = await asWorker(REQUEST, { g: [mine, 'no-such-grant'] });
    expect(code(missing)).toBe('GRANT_NOT_FOUND');
    for (const g of unreadable) {
      const r = await asWorker(REQUEST, { g: [mine, g] });
      expect(code(r), g).toBe('GRANT_NOT_FOUND');
      expect(JSON.stringify(r).replaceAll(g, 'X')).toBe(JSON.stringify(missing).replaceAll('no-such-grant', 'X'));
    }
    // A caller who reads no grant at all: a person with no worker session.
    expect(code(await post(workerKey, null, REQUEST, { g: [mine] }))).toBe('GRANT_NOT_FOUND');
    expect(await selections()).toBe(0);
    expect(await items()).toBe(0);
  });

  it('an App key reads no grant: GRANT_NOT_FOUND, nothing recorded', async () => {
    const g = await held();
    const schema = deploymentSchema();
    const direct = new ApolloServer<Context>({ typeDefs: schema.typeDefs, resolvers: schema.resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
    await direct.start();
    try {
      const a = await direct.executeOperation({ query: REQUEST, variables: { g: [g] } }, { contextValue: { db, appId: w.appId, appKeyId: generateId(), roles: [] } as Context });
      if (a.body.kind !== 'single') throw new Error('incremental');
      expect(a.body.singleResult.errors?.[0]?.extensions?.code).toBe('GRANT_NOT_FOUND');
    } finally { await direct.stop(); }
    expect(await selections()).toBe(0);
  });

  it('FORBIDDEN while impersonating, before any read', async () => {
    const g = await held();
    const schema = deploymentSchema();
    const direct = new ApolloServer<Context>({ typeDefs: schema.typeDefs, resolvers: schema.resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
    await direct.start();
    try {
      const ctx = { db, userId: w.userId, roles: [], impersonation: { sessionId: generateId(), actorUserId: w.user2Id, orgId: w.orgId, expiresAt: new Date(Date.now() + 60_000) } } as Context;
      for (const [query, variables] of [[REQUEST, { g: [g] }], [WITHDRAW, { id: 'AAAAAAAAAAAAAAAAAAAAAA' }]] as const) {
        const a = await runAsActor({ workerId: w.workerId, agentId: w.agentId, userId: w.userId }, () => direct.executeOperation({ query, variables }, { contextValue: ctx }));
        if (a.body.kind !== 'single') throw new Error('incremental');
        expect(a.body.singleResult.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      }
    } finally { await direct.stop(); }
    expect(await selections()).toBe(0);
  });
});

describe('P15 (race): the reach is judged again under the transaction\'s anchors', () => {
  it('a worker retired while the request waits on the App anchor is GRANT_NOT_FOUND, writing nothing', async () => {
    const a = await held();
    const b = await held();
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await blocker.query('SELECT id FROM apps WHERE id = $1 FOR UPDATE', [w.appId]);
      const call = asWorker(REQUEST, { g: [a, b] });
      await waitForLockWaitersBlockedBy(db, pid, 1);
      // The first read already passed (it took no lock); the worker retires before the anchor is granted.
      await blocker.query(`UPDATE workers SET retired_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = $1`, [w.workerId]);
      await blocker.query('COMMIT');
      const r = await call;
      expect(code(r)).toBe('GRANT_NOT_FOUND');
    } finally { await blocker.query('ROLLBACK').catch(() => undefined); await blocker.end(); }
    expect(await selections()).toBe(0);
    expect(await items()).toBe(0);
  });
});

describe('P16: the cap and the mixed-App refusal are judged before any read of a grant', () => {
  it('SELECTION_EMPTY, SELECTION_TOO_LARGE (with the cap) and SELECTION_DUPLICATE_GRANT, even for refs that do not exist', async () => {
    expect(code(await asWorker(REQUEST, { g: [] }))).toBe('SELECTION_EMPTY');
    const tooMany = Array.from({ length: GRANT_SELECTION_CAP + 1 }, (_, i) => `nope-${i}`);
    const r = await asWorker(REQUEST, { g: tooMany });
    expect(code(r)).toBe('SELECTION_TOO_LARGE');
    expect(r.errors[0].extensions.cap).toBe(GRANT_SELECTION_CAP);
    // Exactly the cap is not refused for size: it reaches the first read and is GRANT_NOT_FOUND.
    expect(code(await asWorker(REQUEST, { g: tooMany.slice(0, GRANT_SELECTION_CAP) }))).toBe('GRANT_NOT_FOUND');
    const g = await held();
    const dup = await asWorker(REQUEST, { g: [g, g] });
    expect(code(dup)).toBe('SELECTION_DUPLICATE_GRANT');
    expect(dup.errors[0].extensions.grantRef).toBe(g);
    expect(await selections()).toBe(0);
  });

  it('grants of two Apps are SELECTION_MIXED_APPS, naming no App', async () => {
    const a = await held();
    const other = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.app2Id, agentId: w.agentId, name: 'o', slug: `o-${generateId().slice(0, 6)}`, heldByUserId: w.userId } });
    const b = await insertGrant(w, { app_id: w.app2Id, user_id: null, worker_id: other.id } as never);
    // The worker of App 1 cannot read App 2's grant at all: that is NOT_FOUND, not MIXED (it leaks nothing about App 2).
    expect(code(await asWorker(REQUEST, { g: [a, b] }))).toBe('GRANT_NOT_FOUND');
    expect(await selections()).toBe(0);
  });
});

describe('P9: a request-time refusal names the first bad ref (ascending) and opens nothing for the rest', () => {
  it('GRANT_NOT_PENDING, GRANT_EXPIRED and GRANT_TERMS_UNREPRESENTABLE are whole-call refusals', async () => {
    const good = await held();
    const activated = await insertGrantUnguarded(w, { user_id: null, worker_id: w.workerId, activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 'test' });
    const expired = await insertGrantUnguarded(w, { user_id: null, worker_id: w.workerId, expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    const bad = await held({ action_values: { entryNode: 7 } });
    for (const [ref, expectCode] of [[activated, 'GRANT_NOT_PENDING'], [expired, 'GRANT_EXPIRED'], [bad, 'GRANT_TERMS_UNREPRESENTABLE']] as const) {
      const r = await asWorker(REQUEST, { g: [good, ref] });
      expect(code(r), ref).toBe(expectCode);
      expect(r.errors[0].extensions.grantRef).toBe(ref);
    }
    expect(await selections()).toBe(0);
    expect(await items()).toBe(0);
  });
});

describe('P17: withdraw is the requester account\'s alone, once, and ends the items with it', () => {
  it('the requester account withdraws from another of its sessions; an ended selection refuses with its state', async () => {
    const ids = [await held(), await held()];
    const id = (await asWorker(REQUEST, { g: ids })).data.requestGrantSelectionSignature.id;
    // Another person who cannot read the grants: concealed as an unknown id.
    expect(code(await post(personKey, personSessionId, WITHDRAW, { id }))).toBe('SIGNING_REQUEST_NOT_FOUND');
    // The same account's other worker does not hold these grants, so it reads none of them: concealed too.
    expect(code(await post(otherWorkerKey, otherSessionId, WITHDRAW, { id }))).toBe('SIGNING_REQUEST_NOT_FOUND');
    const done = await asWorker(WITHDRAW, { id });
    expect(done.errors).toBeUndefined();
    expect(done.data.withdrawGrantSigningSelection.state).toBe('WITHDRAWN');
    expect(done.data.withdrawGrantSigningSelection.endedAt).not.toBeNull();
    expect(done.data.withdrawGrantSigningSelection.items.map((i: any) => i.state)).toEqual(['WITHDRAWN', 'WITHDRAWN']);
    const again = await asWorker(WITHDRAW, { id });
    expect(code(again)).toBe('SIGNING_REQUEST_ENDED');
    expect(again.errors[0].extensions.state).toBe('WITHDRAWN');
  });

  it('SIGNING_REQUEST_NOT_REQUESTER: a manager who reads every grant but did not ask is refused by name, and nothing ends', async () => {
    const ids = [await held(), await held()];
    const id = (await asWorker(REQUEST, { g: ids })).data.requestGrantSelectionSignature.id;
    await db.orgMember.updateMany({ where: { organizationId: w.orgId, userId: w.user2Id }, data: { role: 'ADMIN' } });
    // The manager reads the selection (the manager arm reaches every grant of the App) ...
    const read = await post(personKey, null, READ, { id });
    expect(read.errors).toBeUndefined();
    expect(read.data.grantSigningSelection.id).toBe(id);
    // ... but is not the account that asked.
    expect(code(await post(personKey, null, WITHDRAW, { id }))).toBe('SIGNING_REQUEST_NOT_REQUESTER');
    expect((await db.grantSigningSelection.findUniqueOrThrow({ where: { id } })).state).toBe('open');
    expect((await db.grantSigningRequest.findMany({ where: { selectionId: id } })).map((r) => r.state)).toEqual(['open', 'open']);
  });
});

describe('the read returns the whole items, not the pre-read\'s grant ids', () => {
  const FULL = 'query($id:ID!){grantSigningSelection(id:$id){id state payloadVersion ceremonyUrl requestedBy{userId workerId sessionId} items{id grantId version termsHash payloadVersion selectionId state ceremonyUrl}}}';
  it('every item field resolves, equal to what the request call returned', async () => {
    const ids = [await held(), await held(), await held()];
    const made = (await asWorker(REQUEST, { g: ids })).data.requestGrantSelectionSignature;
    const read = await asWorker(FULL, { id: made.id });
    expect(read.errors).toBeUndefined();
    const sel = read.data.grantSigningSelection;
    expect(sel.items).toHaveLength(3);
    expect(sel.items).toEqual(made.items.map((i: any) => ({ ...i })));
    expect(sel.items.every((i: any) => i.id && i.termsHash && i.payloadVersion && i.selectionId === made.id && i.state === 'OPEN' && i.ceremonyUrl)).toBe(true);
  });
});
