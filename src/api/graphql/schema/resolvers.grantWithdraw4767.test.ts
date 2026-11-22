/**
 * #4767 (Grants R6; cor:acl:140:03 item 5, ruling 0255 item 21 — a call is the agent's when a session is bound to it):
 * the WORKER-SESSION arm of `withdrawGrant`. A worker session whose worker's role agent is A withdraws a PENDING grant a
 * RUN of A asked for (`requested_by_run_id`): S2b's worker-id match is NOT loosened — the new arm matches on the row's
 * holder agent plus its run column, and a worker-made request still belongs to the worker that made it. The withdrawal
 * records the person driving the session, exactly as S2b's worker arm does.
 *
 * Pins go over real GraphQL POSTs. Concealment: a grant the caller cannot read (another agent's, this agent's in another
 * App, an unknown id) answers GRANT_NOT_FOUND, one answer; a person on a readable run-made grant answers
 * GRANT_NOT_REQUESTER (they never made the request).
 */
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedReadableNodes, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { grantManageMutations, runMadeRequestOfRoleAgent } from './resolvers.grantManage.js';
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
let pubNode: string;
/** manager: org ADMIN (user2). member: contributor (user1, drives the worker whose role agent is w.agentId). */
let managerId: string; let memberId: string; let outsiderId: string;
let managerKey: string; let memberKey: string; let outsiderKey: string;
let workerSession: string;

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
const code = (r: any): string | undefined => r.errors?.[0]?.extensions?.code;
const WITHDRAW = 'mutation($r:ID!){withdrawGrant(ref:$r){id allows revokedAt revokedByUserId state}}';
const entry = () => ({ entryNode: pubNode });
const grantRows = async () => db.$queryRawUnsafe<any[]>('SELECT * FROM grants ORDER BY created_at');
const events = async (grantId: string) => db.$queryRawUnsafe<any[]>("SELECT * FROM grant_events WHERE grant_id = $1 AND action IN ('REVOKE', 'WITHDRAW')", grantId);

/** A run-made PENDING grant held by w.agentId in w.appId, asked for by a RUNNING run of that agent. */
async function runPending(over: Record<string, any> = {}): Promise<string> {
  const app = await db.app.findUniqueOrThrow({ where: { id: w.appId } });
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: app.organizationId as string, appId: w.appId, agentId: w.agentId, triggerKind: 'MANUAL', entryNodeUrn: 'x::m::flow:entry', status: 'RUNNING' } as never });
  return insertGrant(w, { user_id: null, worker_id: null, agent_id: w.agentId, requested_by_run_id: run.id, action: 'schedule.create', action_values: entry(), ...over });
}

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  [pubNode] = await seedReadableNodes(w.orgId);
  await upsertPlatformActions(db);
  memberId = w.userId; managerId = w.user2Id;
  outsiderId = (await db.user.create({ data: { handle: `out-${generateId().slice(0, 6)}` } })).id;
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: memberId, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: managerId, role: 'ADMIN' } });
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: memberId } });
  workerSession = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: memberId, workerId: w.workerId, agentId: w.agentId } })).id;
  [managerKey, memberKey, outsiderKey] = await Promise.all([keyFor(managerId), keyFor(memberId), keyFor(outsiderId)]);
});

describe('worker-session withdrawal of a run-made grant (#4767)', () => {
  it('W1: a worker session whose role agent is the holder withdraws it: stamped, the driving person is the revoker, the worker and session are in the event', async () => {
    const id = await runPending();
    const r = await post(memberKey, workerSession, WITHDRAW, { r: id });
    expect(r.errors).toBeUndefined();
    expect(r.data.withdrawGrant).toMatchObject({ id, allows: false, state: 'WITHDRAWN' }); // #4173
    expect(r.data.withdrawGrant.revokedAt).not.toBeNull();
    expect(r.data.withdrawGrant.revokedByUserId).toBeNull(); // the requester read: no manager audit facts
    const row = (await grantRows())[0];
    expect(row.revoked_by).toBe(memberId); // a session has its driving person: S2b's ender, unchanged
    expect(row.withdrawn_at).toEqual(row.revoked_at);
    expect(await events(id)).toHaveLength(1);
    expect(await events(id)).toMatchObject([{ action: 'WITHDRAW', actor_user_id: memberId, worker_id: w.workerId, session_id: workerSession, run_id: null }]);
  });

  it('W2: one answer for every grant the caller cannot read: unknown id, another agent\'s run-made grant, this agent\'s in another App, a session bound to another agent (manager-driven or not); a person who cannot read it too', async () => {
    const mine = await runPending(); // kept untouched
    const other = await db.agent.create({ data: { organizationId: w.orgId, name: 'b', urn: `${w.orgUrn}:b-${generateId().slice(0, 6)}` } });
    const foreignApp = await db.app.findUniqueOrThrow({ where: { id: w.app2Id } });
    const run2 = await db.appRun.create({ data: { id: generateId(), organizationId: foreignApp.organizationId as string, appId: w.app2Id, agentId: w.agentId, triggerKind: 'MANUAL', entryNodeUrn: 'x::m::flow:entry', status: 'RUNNING' } as never });
    const elsewhere = await insertGrant(w, { app_id: w.app2Id, user_id: null, worker_id: null, agent_id: w.agentId, requested_by_run_id: run2.id, action: 'schedule.create', action_values: entry() });
    const foreign = await insertGrant(w, { user_id: null, worker_id: null, agent_id: other.id, requested_by_run_id: generateId(), action: 'schedule.create', action_values: entry() });
    const otherWorker = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: other.id, name: 'q', slug: `q-${generateId().slice(0, 6)}` } })).id;
    await db.worker.update({ where: { id: otherWorker }, data: { heldByUserId: managerId } });
    const otherSession = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: managerId, workerId: otherWorker, agentId: other.id } })).id;
    // A NON-manager's session on a worker of another agent (Beatrix P3-5): the role agent differs from the holder, and the
    // caller is a plain member, so neither the manager read nor the worker-id arm can carry it.
    const otherWorker2 = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: other.id, name: 'q2', slug: `q2-${generateId().slice(0, 6)}` } })).id;
    await db.worker.update({ where: { id: otherWorker2 }, data: { heldByUserId: memberId } });
    const otherSession2 = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: memberId, workerId: otherWorker2, agentId: other.id } })).id;
    const answers = new Set<string>();
    // The last two cases are PERSONS (no session): an unknown id, and a member who cannot read `mine` (not manager, holder,
    // requester or issuer — Beatrix P3-3: a person who cannot read it, not a second unknown id).
    for (const [id, sess, key] of [
      [generateId(), workerSession, memberKey], [foreign, workerSession, memberKey], [elsewhere, workerSession, memberKey],
      [mine, otherSession, managerKey], [mine, otherSession2, memberKey], [generateId(), null, memberKey], [mine, null, memberKey],
    ] as Array<[string, string | null, string]>) {
      const r = await post(key, sess, WITHDRAW, { r: id });
      answers.add(`${code(r)}|${r.errors?.[0]?.message}`);
    }
    expect(answers.size).toBe(1);
    expect([...answers][0]).toMatch(/^GRANT_NOT_FOUND\|/);
    const rows = await grantRows();
    expect(rows.every((g) => g.revoked_at === null)).toBe(true);
    expect(await events(mine)).toHaveLength(0);
  });

  it('W3: S2b is not loosened: a worker-made request held by the same agent still belongs to the worker that made it', async () => {
    const otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}` } })).id;
    const id = await insertGrant(w, { user_id: null, worker_id: null, agent_id: w.agentId, requested_by_worker_id: otherWorkerId, action: 'schedule.create', action_values: entry() });
    // Readable through the role-agent arm (the row is in scope), so the refusal is the requester match, not concealment.
    expect(code(await post(memberKey, workerSession, WITHDRAW, { r: id }))).toBe('GRANT_NOT_REQUESTER');
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it('W4: a person — even one who manages the App — never made the request: GRANT_NOT_REQUESTER on a readable run-made grant', async () => {
    const id = await runPending();
    expect(code(await post(managerKey, null, WITHDRAW, { r: id }))).toBe('GRANT_NOT_REQUESTER');
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it('W5: an activated run-made grant is refused GRANT_NOT_PENDING and stays live', async () => {
    const id = await insertGrantUnguarded(w, {
      user_id: null, worker_id: null, agent_id: w.agentId, requested_by_run_id: generateId(),
      action: 'schedule.create', action_values: entry(), issuer_user_id: managerId, verification_kind: 'passkey', verified_by: managerId, activated_at: raw(DB_NOW),
    });
    expect(code(await post(memberKey, workerSession, WITHDRAW, { r: id }))).toBe('GRANT_NOT_PENDING');
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it('W6: GraphQL withdrawGrant keeps refusing a run principal (#4767: the run tool is the one run door): GRANT_NOT_FOUND, nothing written (Beatrix P3-4)', async () => {
    const id = await runPending();
    // The Riana P2-1 convention (resolvers.grantManager3711.test.ts): a hand-built run-principal context, resolver-level.
    const runCtx = { db, userId: memberId, appId: w.appId, organizationId: w.orgId, clientId: `run:${generateId()}`, roles: [] } as never;
    await expect(grantManageMutations.withdrawGrant(null, { ref: id }, runCtx)).rejects.toMatchObject({ extensions: { code: 'GRANT_NOT_FOUND' } });
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it('W7: the run-made arm fails closed on an unread role agent — null never matches, not even a holder-less run-made row (Beatrix P2-1, Antonio P3-2)', () => {
    // The state is unreachable through the door (workers.agent_id is NOT NULL; the read runs under the worker row's FOR
    // SHARE before the judgement; a gone worker row is refused by the reader gate first), so the arm is pinned directly:
    // the first line is the mutant the guard exists to kill (drop `roleAgentId !== null` and it answers true).
    expect(runMadeRequestOfRoleAgent({ requestedByRunId: 'r', agentId: null }, null)).toBe(false);
    expect(runMadeRequestOfRoleAgent({ requestedByRunId: 'r', agentId: 'a' }, null)).toBe(false);
    expect(runMadeRequestOfRoleAgent({ requestedByRunId: null, agentId: 'a' }, 'a')).toBe(false);
    expect(runMadeRequestOfRoleAgent({ requestedByRunId: null, agentId: null }, 'a')).toBe(false);
    expect(runMadeRequestOfRoleAgent({ requestedByRunId: 'r', agentId: 'a' }, 'a')).toBe(true);
  });
});
