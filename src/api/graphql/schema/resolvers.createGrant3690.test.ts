/**
 * #3690 PR 2 (Grants S2a create; cor:acl:140:05 Create, :03 pending, :01, :02; rulings 0099, 0253, 0255 items 6 and 20): `createGrant`
 * by a BOUND WORKER SESSION, in that worker's own App, for itself or its role agent. The row is born PENDING and nothing on the
 * surface can make it live. Every refusal is typed and judged before the write; no refused call leaves a row. Pins go over real
 * GraphQL POSTs; the locking carries from the section 10 review of #3792 (Ralion 6748113389) are pinned below the surface.
 */
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../../generated/prisma/index.js';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { isGrantLive } from '../../../lib/grants/live.js';
import { dropTestActions, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;
beforeAll(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  http = httpServer(await createServer());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); await cleanDb(db); await dropTestActions(); vi.unstubAllEnvs(); });

let w: World;
let rawKey: string;
let sessionId: string;
let otherWorkerId: string;
let otherAppWorkerId: string;
let personKey: string;

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
const CREATE = `mutation($i:CreateGrantInput!){createGrant(input:$i){id appId action values holderKind holderId issuerUserId
  requestedByUserId requestedByWorkerId requestedBySessionId reason activatedAt revokedAt allows}}`;
const asWorker = (input: Record<string, unknown>) => post(rawKey, sessionId, CREATE, { i: input });
const rowCount = async () => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT count(*) AS n FROM grants'))[0].n);
const entry = () => ({ entryNode: generateId() });
const selfInput = (over: Record<string, unknown> = {}) => ({
  action: 'schedule.create', values: entry(), holderKind: 'WORKER', holderRef: w.workerId, reason: 'nightly digest', ...over,
});
const code = (r: any): string | undefined => r.errors?.[0]?.extensions?.code;

/**
 * #3829 F (George on #3814): a race is real only when the second operation is observed WAITING on the first, not after a fixed
 * sleep (which passes just as well when the second starts after the first commits). Runs `block` in its own transaction, starts
 * `start` once it holds, waits until some statement is blocked by that transaction's backend, then commits it. The blocker is
 * released in `finally`, so a failed assertion never strands a transaction.
 */
async function whileBlocking<T>(block: (tx: Prisma.TransactionClient) => Promise<void>, start: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let holding!: (pid: number) => void;
  const holdingP = new Promise<number>((r) => { holding = r; });
  const blocker = db.$transaction(async (tx) => {
    await block(tx);
    holding((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid);
    await held;
  }, { timeout: 30_000 });
  try {
    const pid = await Promise.race([holdingP, blocker.then(() => { throw new Error('the blocker ended before it held'); })]);
    const pending = start();
    pending.catch(() => undefined);
    let waited = false;
    for (let i = 0; i < 400 && !waited; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const [{ n }] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`, pid);
      waited = Number(n) > 0;
    }
    expect(waited, 'the operation under test waited on the blocker').toBe(true);
    release();
    await blocker;
    return await pending;
  } finally {
    release();
    await blocker.catch(() => undefined);
  }
}

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  await upsertPlatformActions(db);
  const org = await db.organization.findUniqueOrThrow({ where: { id: w.orgId } });
  for (const userId of [w.userId, w.user2Id]) await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  rawKey = await keyFor(w.userId);
  otherAppWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.app2Id, agentId: w.agentId, name: 'o', slug: `o-${generateId().slice(0, 6)}` } })).id;
  otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}` } })).id;
  personKey = await keyFor(w.user2Id);
});

describe('a bound worker creates a PENDING grant for itself or its role agent', () => {
  it('for itself: pending, requester stamped from the validated session, nothing live, and the worker reads it back', async () => {
    const r = await asWorker(selfInput());
    expect(r.errors).toBeUndefined();
    const g = r.data.createGrant;
    expect(g).toMatchObject({
      appId: w.appId, action: 'schedule.create', holderKind: 'WORKER', holderId: w.workerId, issuerUserId: null,
      requestedByUserId: w.userId, requestedByWorkerId: w.workerId, requestedBySessionId: sessionId,
      reason: 'nightly digest', activatedAt: null, revokedAt: null, allows: false,
    });
    const row = (await db.$queryRawUnsafe<any[]>('SELECT * FROM grants WHERE id = $1', g.id))[0];
    expect(row).toMatchObject({ activated_at: null, verification_kind: null, verified_by: null, signature_id: null, use_count: 0, version: 1, holder_departed_at: null });
    expect(isGrantLive({
      activatedAt: row.activated_at, revokedAt: row.revoked_at, holderDepartedAt: row.holder_departed_at, appDeletedAt: null,
      startsAt: row.starts_at, expiresAt: row.expires_at, maxUses: row.max_uses, useCount: row.use_count,
    }, new Date())).toBe(false);
    const read = await post(rawKey, sessionId, 'query($r:ID!){grant(ref:$r){id allows}}', { r: g.id });
    expect(read.data.grant).toEqual({ id: g.id, allows: false });
  });

  it('for its role agent, which is installed in the App: held by the agent in this App', async () => {
    const r = await asWorker(selfInput({ holderKind: 'AGENT', holderRef: w.agentId }));
    expect(r.errors).toBeUndefined();
    expect(r.data.createGrant).toMatchObject({ holderKind: 'AGENT', holderId: w.agentId, appId: w.appId, allows: false });
    const row = (await db.$queryRawUnsafe<any[]>('SELECT agent_id, worker_id, app_id FROM grants WHERE id = $1', r.data.createGrant.id))[0];
    expect(row).toMatchObject({ agent_id: w.agentId, worker_id: null, app_id: w.appId });
  });

  it('time and count terms are stored as given', async () => {
    const startsAt = '2030-01-01T00:00:00.000Z';
    const expiresAt = '2030-02-01T00:00:00.000Z';
    const r = await asWorker(selfInput({ startsAt, expiresAt, maxUses: 3 }));
    expect(r.errors).toBeUndefined();
    const row = (await db.$queryRawUnsafe<any[]>('SELECT starts_at, expires_at, max_uses FROM grants WHERE id = $1', r.data.createGrant.id))[0];
    expect(new Date(row.starts_at).toISOString()).toBe(startsAt);
    expect(new Date(row.expires_at).toISOString()).toBe(expiresAt);
    expect(row.max_uses).toBe(3);
  });

  it('a list value for a declared parameter is accepted (the action\'s own terms decide what a value is)', async () => {
    const r = await asWorker(selfInput({ values: { entryNode: [generateId(), generateId()] } }));
    expect(r.errors).toBeUndefined();
  });
});

describe('a worker cannot make a row live by any route (ruling 0099)', () => {
  it('no input field or alias reaches activation, revocation, use counts or the issuer', async () => {
    for (const field of ['activatedAt', 'verifiedBy', 'verificationKind', 'signatureId', 'revokedAt', 'revokedBy', 'issuerUserId', 'useCount', 'version', 'holderDepartedAt', 'state']) {
      const r = await asWorker(selfInput({ [field]: field === 'useCount' || field === 'version' ? 1 : 'x' }));
      expect(['BAD_USER_INPUT', 'GRAPHQL_VALIDATION_FAILED'], field).toContain(code(r));
    }
    expect(await rowCount()).toBe(0);
  });

  it('the grant surface has no mutation that activates (createGrant is the only grant writer here)', async () => {
    const r = await post(rawKey, sessionId, '{ __type(name:"Mutation"){ fields{ name } } }');
    const names = (r.data.__type.fields as Array<{ name: string }>).map((f) => f.name);
    expect(names).toContain('createGrant');
    for (const banned of ['activateGrant', 'approveGrant', 'signGrant', 'reviseGrant', 'updateGrant']) expect(names).not.toContain(banned);
  });
});

describe('typed refusals, each judged before any write: no refused call leaves a row', () => {
  it('a holder other than itself or its role agent (item 6: this refusal is the rule)', async () => {
    const attempts = [
      { holderKind: 'WORKER', holderRef: otherWorkerId },      // another worker in the App
      { holderKind: 'WORKER', holderRef: otherAppWorkerId },   // a worker of another App
      { holderKind: 'USER', holderRef: w.userId },             // a person
      { holderKind: 'USER', holderRef: w.user2Id },
      { holderKind: 'APP', holderRef: w.app2Id },              // an App
      { holderKind: 'AGENT', holderRef: generateId() },        // an agent that is not its role agent
      { holderKind: 'WORKER', holderRef: generateId() },       // an id with no row
    ];
    for (const a of attempts) {
      const r = await asWorker(selfInput(a));
      expect(code(r), JSON.stringify(a)).toBe('GRANT_HOLDER_NOT_ALLOWED');
    }
    expect(await rowCount()).toBe(0);
  });

  it('every wrong holder answers alike (same code and text), so the refusal names nothing about the id', async () => {
    const answers = await Promise.all([otherWorkerId, otherAppWorkerId, generateId()].map((id) => asWorker(selfInput({ holderRef: id }))));
    const shapes = answers.map((r) => JSON.stringify({ m: r.errors[0].message, c: r.errors[0].extensions }));
    expect(new Set(shapes).size).toBe(1);
  });

  it('a role agent that is not installed in the App cannot hold a grant here (item 20: never issued to an agent that is not installed)', async () => {
    await db.appAgent.deleteMany({ where: { appId: w.appId, agentId: w.agentId } });
    const r = await asWorker(selfInput({ holderKind: 'AGENT', holderRef: w.agentId }));
    expect(code(r)).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await rowCount()).toBe(0);
  });

  it('a caller with no bound worker session is refused: a person with no session, an App-less raw key with no session, and a session id that names nothing', async () => {
    for (const [key, session] of [[personKey, null], [rawKey, null], [rawKey, 'not-a-session']] as const) {
      const r = await post(key, session, CREATE, { i: selfInput() });
      expect(r.data?.createGrant ?? null, `${key.slice(-4)} ${session}`).toBeNull();
      expect(r.errors).toBeDefined();
    }
    const codes = [(await post(personKey, null, CREATE, { i: selfInput() })), (await post(rawKey, null, CREATE, { i: selfInput() }))].map(code);
    expect(codes).toEqual(['GRANT_REQUESTER_NOT_WORKER', 'GRANT_REQUESTER_NOT_WORKER']);
    expect(await rowCount()).toBe(0);
  });

  it('a retired worker, and a worker whose App is deleted, create nothing', async () => {
    await db.worker.update({ where: { id: w.workerId }, data: { retiredAt: new Date() } });
    expect(code(await asWorker(selfInput()))).toBe('GRANT_REQUESTER_NOT_WORKER');
    await db.worker.update({ where: { id: w.workerId }, data: { retiredAt: null } });
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    expect(code(await asWorker(selfInput()))).toBe('GRANT_REQUESTER_NOT_WORKER');
    expect(await rowCount()).toBe(0);
  });

  it('an unknown or unseeded action (no free-text stand-in)', async () => {
    for (const action of ['does.not.exist', '', 'SCHEDULE.CREATE']) {
      expect(code(await asWorker(selfInput({ action }))), action).toBe('GRANT_ACTION_UNKNOWN');
    }
    expect(await rowCount()).toBe(0);
  });

  it('a value that does not match the action\'s declared parameters, or an undeclared key: the structural secret boundary', async () => {
    const bad: unknown[] = [
      {},                                              // a declared parameter missing
      { entryNode: generateId(), apiKey: 'sk-secret' }, // an undeclared key (where a secret would ride)
      { apiKey: 'sk-secret' },                         // only an undeclared key
      { entryNode: 5 }, { entryNode: true }, { entryNode: null }, { entryNode: { id: 'x' } }, { entryNode: [] }, { entryNode: [[ 'a' ]] },
      { entryNode: '' }, { entryNode: [generateId(), '*'] },
      { entryNode: '*' },                              // the parameter refuses a wildcard (cor:acl:140:02)
      { entryNode: 'hrn:node:reviewer.test:kb:entry' }, // a node-ref is a stored node id, never a URN (#3814 Gene F1)
      { entryNode: 'line one\nline two' }, { entryNode: 'has space' }, { entryNode: 'a:b' }, { entryNode: [generateId(), 'hrn:node:x:y:z'] },
      'a string', ['a'], 7,
    ];
    for (const values of bad) {
      expect(code(await asWorker(selfInput({ values }))), JSON.stringify(values)).toBe('GRANT_VALUES_INVALID');
    }
    expect(await rowCount()).toBe(0);
  });

  it('terms the record cannot hold: an empty reason, a bad count, an end before the start', async () => {
    const bad = [
      { reason: '' }, { reason: '   ' }, { maxUses: 0 }, { maxUses: -1 },
      { startsAt: '2030-02-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' },
      { startsAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' },
    ];
    for (const b of bad) expect(code(await asWorker(selfInput(b))), JSON.stringify(b)).toBe('GRANT_TERMS_INVALID');
    expect(await rowCount()).toBe(0);
  });

  it('a refusal never echoes a submitted value in its text or extensions', async () => {
    const secret = `sk-${randomBytes(8).toString('hex')}`;
    const r = await asWorker(selfInput({ values: { entryNode: generateId(), token: secret } }));
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe('the locking carries from the section 10 review of #3792', () => {
  it('carry 1: the creator itself refuses a worker holder of another App (the insert guard checks only that the holder exists)', async () => {
    const { createPendingGrant } = await import('../../../lib/grants/create.js');
    const requester = { userId: w.userId, workerId: w.workerId, sessionId };
    await expect(db.$transaction((tx) => createPendingGrant(tx, {
      appId: w.appId, requester, holder: { kind: 'worker', id: otherAppWorkerId },
      action: 'schedule.create', values: entry(), reason: 'x',
    }))).rejects.toMatchObject({ code: 'GRANT_HOLDER_NOT_ALLOWED' });
    expect(await rowCount()).toBe(0);
  });

  // The creator is also called below the resolver, so its own requester and holder judgments are pinned directly (the resolver
  // pre-validates, which would otherwise hide a removed guard). The worker-holder same-App/retired re-check is the carry-1 pin
  // above for a foreign holder; for holder === requester it is subsumed by the requester's own App/retired check (equivalent).
  const direct = async (over: { userId?: string; workerId?: string; anchored?: string | null; holder: { kind: 'worker' | 'agent'; id: string } }) => {
    const { createPendingGrant } = await import('../../../lib/grants/create.js');
    return db.$transaction((tx) => createPendingGrant(tx, {
      appId: w.appId, requester: { userId: over.userId ?? w.userId, workerId: over.workerId ?? w.workerId, sessionId },
      holder: over.holder, heldAgentAnchor: over.holder.kind === 'agent' ? ('anchored' in over ? over.anchored : over.holder.id) : null, action: 'schedule.create', values: entry(), reason: 'x',
    }));
  };

  it('the creator itself refuses a deleted requester, a retired worker and another App\'s worker as requester', async () => {
    await expect(direct({ userId: generateId(), holder: { kind: 'worker', id: w.workerId } })).rejects.toMatchObject({ code: 'GRANT_REQUESTER_NOT_WORKER' });
    await expect(direct({ workerId: otherAppWorkerId, holder: { kind: 'worker', id: otherAppWorkerId } })).rejects.toMatchObject({ code: 'GRANT_REQUESTER_NOT_WORKER' });
    await db.worker.update({ where: { id: w.workerId }, data: { retiredAt: new Date() } });
    await expect(direct({ holder: { kind: 'worker', id: w.workerId } })).rejects.toMatchObject({ code: 'GRANT_REQUESTER_NOT_WORKER' });
    expect(await rowCount()).toBe(0);
  });

  it('the creator itself refuses an installed agent that is not the requester\'s role agent', async () => {
    const org = await db.organization.findUniqueOrThrow({ where: { id: w.orgId } });
    const other = await db.agent.create({ data: { organizationId: org.id, name: 'other-agent', urn: `${org.urn}:other-agent` } });
    await db.appAgent.create({ data: { appId: w.appId, agentId: other.id } });
    await expect(direct({ holder: { kind: 'agent', id: other.id } })).rejects.toMatchObject({ code: 'GRANT_HOLDER_NOT_ALLOWED' });
    expect(await rowCount()).toBe(0);
  });

  it('role-agent drift: an agent holder is accepted only if the caller holds exactly that agent\'s anchor and it is still the worker\'s role agent (#3814 Gene F2)', async () => {
    const org = await db.organization.findUniqueOrThrow({ where: { id: w.orgId } });
    const b = await db.agent.create({ data: { organizationId: org.id, name: 'drift-b', urn: `${org.urn}:drift-b` } });
    await db.appAgent.create({ data: { appId: w.appId, agentId: b.id } });
    // the worker's role changed A to B after the caller anchored A: B is current but unanchored, A is anchored but not current
    await db.worker.update({ where: { id: w.workerId }, data: { agentId: b.id } });
    await expect(direct({ holder: { kind: 'agent', id: b.id }, anchored: w.agentId })).rejects.toMatchObject({ code: 'GRANT_HOLDER_NOT_ALLOWED' });
    await expect(direct({ holder: { kind: 'agent', id: b.id }, anchored: null })).rejects.toMatchObject({ code: 'GRANT_HOLDER_NOT_ALLOWED' });
    await expect(direct({ holder: { kind: 'agent', id: w.agentId }, anchored: w.agentId })).rejects.toMatchObject({ code: 'GRANT_HOLDER_NOT_ALLOWED' });
    expect(await rowCount()).toBe(0);
    // anchored and current: accepted
    await expect(direct({ holder: { kind: 'agent', id: b.id }, anchored: b.id })).resolves.toEqual(expect.any(String));
  });

  it('a holder that retires while the create waits for it: the create judges the committed state and writes nothing', async () => {
    const r = await whileBlocking(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${w.workerId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE workers SET retired_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = ${w.workerId}`;
    }, () => asWorker(selfInput()));
    expect(r.data?.createGrant ?? null).toBeNull();
    expect(code(r)).toBe('GRANT_REQUESTER_NOT_WORKER');
    expect(await rowCount()).toBe(0);
  });

  it('carry 2: a merge of the requesting person that waited behind a committed create still moves the new grant to the survivor', async () => {
    // A create holds the person\'s authority anchor shared, writes, and commits while the merge waits at its anchor with a
    // snapshot taken before that commit (findings:serializable-advisory-wait-keeps-old-snapshot). The merge must notice.
    const gid = generateId();
    await whileBlocking(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'user', id: w.userId }], 'shared');
      await tx.$executeRawUnsafe(
        `INSERT INTO grants (id, app_id, worker_id, action, action_values, reason, requested_by_user_id, requested_by_worker_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'schedule.create', '{"entryNode":"n"}'::jsonb, 'r', $4, $3, now(), now())`, gid, w.appId, w.workerId, w.userId);
    }, () => mergeUsers(db, { sourceUserId: w.userId, targetUserId: w.user2Id }));
    const row = (await db.$queryRawUnsafe<Array<{ requested_by_user_id: string }>>('SELECT requested_by_user_id FROM grants WHERE id = $1', gid))[0];
    expect(row.requested_by_user_id).toBe(w.user2Id);
  });
});

describe('#3829: the post-wait judgments, each pinned where it alone catches the case (Ralion P3-1, -2, -3, -5, -6 on #3814)', () => {
  const appAnchorRevoker = (change: (tx: Prisma.TransactionClient) => Promise<unknown>) => async (tx: Prisma.TransactionClient) => {
    // A revoker takes the App anchor exclusively and changes the caller\'s standing; the create (anchor shared) waits for it.
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: w.appId }], 'exclusive');
    await change(tx);
  };

  it('A: the person leaves the Org while the create waits: only the in-transaction re-check sees it, and nothing is written', async () => {
    const r = await whileBlocking(
      appAnchorRevoker((tx) => tx.orgMember.updateMany({ where: { organizationId: w.orgId, userId: w.userId }, data: { deletedAt: new Date() } })),
      () => asWorker(selfInput()),
    );
    expect(r.data?.createGrant ?? null).toBeNull();
    expect(code(r)).toBe('GRANT_REQUESTER_NOT_WORKER');
    expect(await rowCount()).toBe(0);
  });

  it('C: the App is deleted while the create waits: the post-wait FORBIDDEN answers as GRANT_REQUESTER_NOT_WORKER, nothing written', async () => {
    const r = await whileBlocking(
      appAnchorRevoker((tx) => tx.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } })),
      () => asWorker(selfInput()),
    );
    expect(r.data?.createGrant ?? null).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(code(r)).toBe('GRANT_REQUESTER_NOT_WORKER');
    expect(r.errors[0].message).toBe('A grant can be requested only from a bound worker session in its own App.');
    expect(await rowCount()).toBe(0);
  });

  it('D: the role changes A to B while the create waits: the resolver passes only the anchor it took, so neither agent is accepted', async () => {
    const org = await db.organization.findUniqueOrThrow({ where: { id: w.orgId } });
    const b = await db.agent.create({ data: { organizationId: org.id, name: 'race-b', urn: `${org.urn}:race-b` } });
    await db.appAgent.create({ data: { appId: w.appId, agentId: b.id } });
    const toB = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${w.workerId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE workers SET agent_id = ${b.id} WHERE id = ${w.workerId}`;
    };
    // B: current after the wait, but the resolver saw A before it, so it took no anchor for B and must not claim one.
    const forB = await whileBlocking(toB, () => asWorker(selfInput({ holderKind: 'AGENT', holderRef: b.id })));
    expect(code(forB)).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await rowCount()).toBe(0);
    // A: anchored before the wait, but no longer the role agent once the change commits.
    await db.worker.update({ where: { id: w.workerId }, data: { agentId: w.agentId } });
    const forA = await whileBlocking(toB, () => asWorker(selfInput({ holderKind: 'AGENT', holderRef: w.agentId })));
    expect(code(forA)).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await rowCount()).toBe(0);
    // control: with no race, B (now the role agent, so anchored by the resolver) is accepted
    expect((await asWorker(selfInput({ holderKind: 'AGENT', holderRef: b.id }))).errors).toBeUndefined();
  });

  it('B: the creator itself refuses a TOMBSTONED requester (a real person row with deleted_at set, not a missing id)', async () => {
    const { createPendingGrant } = await import('../../../lib/grants/create.js');
    await db.user.update({ where: { id: w.userId }, data: { deletedAt: new Date() } });
    expect(await db.user.count({ where: { id: w.userId } })).toBe(1);
    await expect(db.$transaction((tx) => createPendingGrant(tx, {
      appId: w.appId, requester: { userId: w.userId, workerId: w.workerId, sessionId },
      holder: { kind: 'worker', id: w.workerId }, action: 'schedule.create', values: entry(), reason: 'x',
    }))).rejects.toMatchObject({ code: 'GRANT_REQUESTER_NOT_WORKER' });
    expect(await rowCount()).toBe(0);
  });

  it('E: a parameter of a type the creator has no rule for is refused, even for an id-shaped value (fail closed)', async () => {
    const action = 'test.s1a.untyped3829';
    await db.$executeRawUnsafe(
      `INSERT INTO actions (name, source, parameters, enforcement, issuer_rule, summary_template, created_at, updated_at)
       VALUES ($1, 'PLATFORM', '[{"name":"note","type":"string"}]'::jsonb, 'RECORDED_ONLY', 'TEST_ONLY', 'test', now(), now())`, action);
    const r = await asWorker(selfInput({ action, values: { note: generateId() } }));
    expect(code(r)).toBe('GRANT_VALUES_INVALID');
    expect(await rowCount()).toBe(0);
  });
});

describe('the switch: grant creation rides PASSKEY_SIGNING_ENABLED with the rest of signing', () => {
  it('with signing off the mutation does not exist (absent, not an off-state error)', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    const off = httpServer(await createServer());
    await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(off.address() as AddressInfo).port}/graphql`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}`, 'x-hadron-session': sessionId },
        body: JSON.stringify({ query: CREATE, variables: { i: selfInput() } }),
      });
      const body: any = await res.json();
      expect(code(body)).toBe('GRAPHQL_VALIDATION_FAILED');
      expect(await rowCount()).toBe(0);
    } finally {
      await new Promise<void>((r) => off.close(() => r()));
      vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    }
  });
});
