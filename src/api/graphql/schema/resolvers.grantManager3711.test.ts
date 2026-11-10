/**
 * #3711 (Grants S2b; cor:acl:140:05 Create/List/Revoke, :03 first end, rulings 0253, 0255 items 5 and 7, V56/V57): a PERSON who
 * manages the App creates, lists (every state) and revokes grants; a requester withdraws its own PENDING grant; a worker lists
 * what its role agent holds. Pins go over real GraphQL POSTs; the races hold a row lock on a second connection and prove the
 * decision is judged on the LOCKED current row. Each pin is named for the acceptance item it carries.
 */
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { endHeldGrants } from '../../../lib/grants/departure.js';
import { grantManageMutations } from './resolvers.grantManage.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';

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
/** manager: org ADMIN (user2). member: contributor (user1, drives the worker). outsider: no membership. */
let managerId: string; let memberId: string; let outsiderId: string;
let managerKey: string; let memberKey: string; let outsiderKey: string;
let workerSession: string;
let otherWorkerId: string; let otherAppWorkerId: string;

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
/** Wait until some statement in THIS database is blocked on a lock, so a held-lock pin never passes vacuously on a slow runner. */
async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the call never blocked on a lock');
}
const code = (r: any): string | undefined => r.errors?.[0]?.extensions?.code;
const GRANT = 'id appId holderKind holderId issuerUserId requestedByUserId requestedByWorkerId revokedAt revokedByUserId holderDepartedAt allows activatedAt';
const CREATE = `mutation($i:CreateGrantInput!){createGrant(input:$i){${GRANT}}}`;
const REVOKE = `mutation($r:ID!,$ins:ActInstructionInput){revokeGrant(ref:$r,instruction:$ins){${GRANT}}}`;
const WITHDRAW = `mutation($r:ID!){withdrawGrant(ref:$r){${GRANT}}}`;
const LIST = `query($a:String!){appGrants(appRef:$a){total items{${GRANT}}}}`;
const entry = () => ({ entryNode: generateId() });
const mgrInput = (over: Record<string, unknown> = {}) => ({
  appRef: w.appId, action: 'schedule.create', values: entry(), holderKind: 'WORKER', holderRef: otherWorkerId, reason: 'nightly digest', ...over,
});
const grantRows = async () => db.$queryRawUnsafe<any[]>('SELECT * FROM grants ORDER BY created_at');
const events = async (grantId: string) => db.$queryRawUnsafe<any[]>("SELECT * FROM grant_events WHERE grant_id = $1 AND action = 'REVOKE'", grantId);

/** A pending worker-held grant requested by `by`; an ACTIVE one issued by `issuer` (the unguarded insert is the test-only way to a live row). */
async function pending(over: Record<string, any> = {}): Promise<string> {
  return insertGrant(w, { user_id: null, worker_id: otherWorkerId, action: 'schedule.create', action_values: entry(), requested_by_user_id: memberId, ...over });
}
async function active(over: Record<string, any> = {}): Promise<string> {
  return insertGrantUnguarded(w, {
    user_id: null, worker_id: otherWorkerId, action: 'schedule.create', action_values: entry(), requested_by_user_id: memberId,
    issuer_user_id: managerId, verification_kind: 'passkey', verified_by: managerId, activated_at: raw(DB_NOW), ...over,
  });
}

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  await upsertPlatformActions(db);
  memberId = w.userId; managerId = w.user2Id;
  outsiderId = (await db.user.create({ data: { handle: `out-${generateId().slice(0, 6)}` } })).id;
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: memberId, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: managerId, role: 'ADMIN' } });
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: memberId } });
  workerSession = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: memberId, workerId: w.workerId, agentId: w.agentId } })).id;
  [managerKey, memberKey, outsiderKey] = await Promise.all([keyFor(managerId), keyFor(memberId), keyFor(outsiderId)]);
  otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}` } })).id;
  otherAppWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.app2Id, agentId: w.agentId, name: 'o', slug: `o-${generateId().slice(0, 6)}` } })).id;
});

describe('acceptance 1: whoever manages the App creates a PENDING grant', () => {
  it('a manager creates for a worker of the App: pending, requested by the person, no worker or session recorded', async () => {
    const r = await post(managerKey, null, CREATE, { i: mgrInput() });
    expect(r.errors).toBeUndefined();
    expect(r.data.createGrant).toMatchObject({
      appId: w.appId, holderKind: 'WORKER', holderId: otherWorkerId, requestedByUserId: managerId, requestedByWorkerId: null,
      issuerUserId: null, activatedAt: null, revokedAt: null, allows: false,
    });
    const row = (await grantRows())[0];
    expect(row).toMatchObject({ requested_by_user_id: managerId, requested_by_worker_id: null, requested_by_session_id: null, activated_at: null });
  });

  it('a manager creates for an agent installed in the App', async () => {
    const r = await post(managerKey, null, CREATE, { i: mgrInput({ holderKind: 'AGENT', holderRef: w.agentId }) });
    expect(r.errors).toBeUndefined();
    expect(r.data.createGrant).toMatchObject({ holderKind: 'AGENT', holderId: w.agentId });
  });

  it('a holder outside the App, or an agent not installed, is the typed holder refusal and leaves no row', async () => {
    expect(code(await post(managerKey, null, CREATE, { i: mgrInput({ holderRef: otherAppWorkerId }) }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    await db.appAgent.deleteMany({ where: { appId: w.appId } });
    expect(code(await post(managerKey, null, CREATE, { i: mgrInput({ holderKind: 'AGENT', holderRef: w.agentId }) }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await grantRows()).toHaveLength(0);
  });

  it('a member who does not manage, an outsider and a missing App each get the SAME typed refusal, and no row', async () => {
    const a = await post(memberKey, null, CREATE, { i: mgrInput() });
    const b = await post(outsiderKey, null, CREATE, { i: mgrInput() });
    const c = await post(managerKey, null, CREATE, { i: mgrInput({ appRef: generateId() }) });
    for (const r of [a, b, c]) expect(code(r)).toBe('GRANT_NOT_MANAGER');
    expect(a.errors[0].message).toBe(b.errors[0].message);
    expect(a.errors[0].message).toBe(c.errors[0].message);
    expect(await grantRows()).toHaveLength(0);
  });

  it('the worker path is unchanged: a worker session with no appRef still creates for itself', async () => {
    const r = await post(memberKey, workerSession, CREATE, { i: { action: 'schedule.create', values: entry(), holderKind: 'WORKER', holderRef: w.workerId, reason: 'mine' } });
    expect(r.errors).toBeUndefined();
    expect(r.data.createGrant).toMatchObject({ requestedByUserId: memberId, requestedByWorkerId: w.workerId });
  });

  it('a manager worker session (a person-held worker) does not take the manager arm', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: memberId } }, data: { role: 'ADMIN' } });
    const r = await post(memberKey, workerSession, CREATE, { i: mgrInput() });
    expect(code(r)).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await grantRows()).toHaveLength(0);
  });
});

describe('acceptance 1/2: the manager lists every state; everyone else gets an empty page', () => {
  it('pending, active, revoked and holder-departed rows are all listed, with the audit facts', async () => {
    const p = await pending();
    const a = await active();
    const r = await active({ revoked_at: raw(DB_NOW), revoked_by: managerId });
    const d = await active({ holder_departed_at: raw(DB_NOW) });
    const res = await post(managerKey, null, LIST, { a: w.appId });
    expect(res.errors).toBeUndefined();
    expect(res.data.appGrants.total).toBe(4);
    const byId = new Map<string, any>(res.data.appGrants.items.map((g: any) => [g.id, g]));
    expect(byId.get(p)).toMatchObject({ allows: false, activatedAt: null });
    expect(byId.get(a)).toMatchObject({ allows: true, issuerUserId: managerId });
    expect(byId.get(r)).toMatchObject({ allows: false, revokedByUserId: managerId });
    expect(byId.get(r).revokedAt).not.toBeNull();
    expect(byId.get(d).holderDepartedAt).not.toBeNull();
  });

  it('a non-manager member, an outsider and a worker session each get an empty page, as for an unknown App', async () => {
    await pending();
    for (const [key, session] of [[memberKey, null], [outsiderKey, null], [memberKey, workerSession]] as const) {
      const res = await post(key, session, LIST, { a: w.appId });
      expect(res.errors).toBeUndefined();
      expect(res.data.appGrants).toEqual({ items: [], total: 0 });
    }
    const missing = await post(managerKey, null, LIST, { a: generateId() });
    expect(missing.data.appGrants).toEqual({ items: [], total: 0 });
  });

  it('another App\'s grants are never in the list', async () => {
    const other = await insertGrant({ ...w, appId: w.app2Id }, { user_id: null, worker_id: otherAppWorkerId, action: 'schedule.create', action_values: entry() });
    const res = await post(managerKey, null, LIST, { a: w.appId });
    expect(res.data.appGrants.items.map((g: any) => g.id)).not.toContain(other);
  });

  it('V56: the revoker and departure facts are the manager\'s; a person\'s myGrants and a worker\'s read of the same grant do not carry them, in ONE request', async () => {
    const id = await active({ user_id: managerId, worker_id: null, revoked_at: raw(DB_NOW), revoked_by: managerId });
    const res = await post(managerKey, null, `query($a:String!){m:appGrants(appRef:$a){items{id revokedByUserId}} mine:myGrants{items{id revokedByUserId}}}`, { a: w.appId });
    expect(res.errors).toBeUndefined();
    expect(res.data.m.items.find((g: any) => g.id === id).revokedByUserId).toBe(managerId);
    expect(res.data.mine.items.find((g: any) => g.id === id).revokedByUserId).toBeNull();
    const own = await active({ revoked_at: raw(DB_NOW), revoked_by: managerId, worker_id: w.workerId });
    const asWorker = await post(memberKey, workerSession, `{grants{items{id revokedByUserId holderDepartedAt}}}`);
    expect(asWorker.data.grants.items.find((g: any) => g.id === own)).toMatchObject({ revokedByUserId: null, holderDepartedAt: null });
  });
});

describe('role-agent reach (ruling 0255 item 7, cor:acl:140:05 List)', () => {
  it('a worker lists the grants its role agent holds in its own App, every state', async () => {
    const live = await active({ worker_id: null, agent_id: w.agentId });
    const pend = await pending({ worker_id: null, agent_id: w.agentId, requested_by_user_id: managerId });
    const res = await post(memberKey, workerSession, `{grants{total items{id}}}`);
    const ids = res.data.grants.items.map((g: any) => g.id);
    expect(ids).toEqual(expect.arrayContaining([live, pend]));
    const one = await post(memberKey, workerSession, 'query($r:ID!){grant(ref:$r){id}}', { r: live });
    expect(one.data.grant).toEqual({ id: live });
  });

  it('not from another App (0255 item 20b), not once the agent is uninstalled here, and not a grant held by another agent', async () => {
    const elsewhere = await insertGrantUnguarded({ ...w, appId: w.app2Id }, {
      user_id: null, agent_id: w.agentId, action: 'schedule.create', action_values: entry(), issuer_user_id: managerId, verification_kind: 'passkey', verified_by: managerId, activated_at: raw(DB_NOW),
    });
    const base2 = await db.agent.create({ data: { organizationId: w.orgId, name: 'b', urn: `b-${generateId().slice(0, 6)}.test:agent` } });
    const otherAgents = await insertGrant(w, { user_id: null, agent_id: base2.id, action: 'schedule.create', action_values: entry(), requested_by_user_id: managerId });
    const mine = await active({ worker_id: null, agent_id: w.agentId });
    await db.appAgent.deleteMany({ where: { appId: w.appId } });
    const res = await post(memberKey, workerSession, `{grants{items{id}}}`);
    const ids = res.data.grants.items.map((g: any) => g.id);
    expect(ids).not.toContain(elsewhere);
    expect(ids).not.toContain(otherAgents);
    expect(ids).not.toContain(mine);
  });
});

describe('acceptance 2/3/9: revoke', () => {
  it('a manager revokes an active grant: not live at once, stamped with the person, one REVOKE event', async () => {
    const id = await active();
    const r = await post(managerKey, null, REVOKE, { r: id });
    expect(r.errors).toBeUndefined();
    expect(r.data.revokeGrant).toMatchObject({ id, allows: false, revokedByUserId: managerId });
    expect(r.data.revokeGrant.revokedAt).not.toBeNull();
    const ev = await events(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_user_id: managerId, worker_id: null });
  });

  it('a manager also revokes a PENDING grant (a manager who is not the requester uses revoke)', async () => {
    const id = await pending();
    const r = await post(managerKey, null, REVOKE, { r: id });
    expect(r.errors).toBeUndefined();
    expect(r.data.revokeGrant.revokedAt).not.toBeNull();
  });

  it('the issuer revokes while still a live member of the App\'s Org, and not after leaving it', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: managerId } }, data: { role: 'CONTRIBUTOR' } });
    const id = await active({ issuer_user_id: managerId });
    expect((await post(managerKey, null, REVOKE, { r: id })).errors).toBeUndefined();
    const id2 = await active({ issuer_user_id: managerId });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: managerId } }, data: { deletedAt: new Date() } });
    const r = await post(managerKey, null, REVOKE, { r: id2 });
    expect(code(r)).toBe('GRANT_NOT_MANAGER');
    expect((await grantRows()).find((g) => g.id === id2).revoked_at).toBeNull();
  });

  it('the issuer arm needs a LIVE Org membership even for someone who still participates in the App (an AppMember who left the Org)', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: managerId } }, data: { role: 'CONTRIBUTOR' } });
    const id = await active({ issuer_user_id: managerId });
    await db.appMember.create({ data: { appId: w.appId, userId: managerId, role: 'member' } });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: managerId } }, data: { deletedAt: new Date() } });
    const r = await post(managerKey, null, REVOKE, { r: id });
    expect(code(r)).toBe('GRANT_NOT_MANAGER');
    expect((await grantRows())[0].revoked_at).toBeNull();
  });

  it('a revoked membership never authorizes (a manager whose Org membership was soft-deleted is refused)', async () => {
    const id = await active();
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: managerId } }, data: { deletedAt: new Date() } });
    expect(code(await post(managerKey, null, REVOKE, { r: id }))).toBe('GRANT_NOT_MANAGER');
    expect((await grantRows())[0].revoked_at).toBeNull();
  });

  it('a non-manager, an outsider and an unknown id each get the same typed refusal; the row is unchanged', async () => {
    const id = await active({ issuer_user_id: outsiderId });
    const a = await post(memberKey, null, REVOKE, { r: id });
    const b = await post(outsiderKey, null, REVOKE, { r: id });
    const c = await post(managerKey, null, REVOKE, { r: generateId() });
    for (const r of [a, b, c]) expect(code(r)).toBe('GRANT_NOT_MANAGER');
    expect(a.errors[0].message).toBe(c.errors[0].message);
    expect((await grantRows())[0].revoked_at).toBeNull();
  });

  it('a worker session with no instruction is refused, as for an unknown grant', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: memberId } }, data: { role: 'ADMIN' } });
    const id = await active();
    const r = await post(memberKey, workerSession, REVOKE, { r: id });
    expect(code(r)).toBe('GRANT_NOT_MANAGER');
    expect((await grantRows())[0].revoked_at).toBeNull();
  });

  it('a held worker revokes on a validated instruction from a holder who manages the App: the person is the revoker, the worker is in the event, and one instructed-act record is written', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: memberId } }, data: { role: 'ADMIN' } });
    const id = await active();
    const r = await post(memberKey, workerSession, REVOKE, { r: id, ins: { kind: 'LIVE_CHAT', ref: 'live-chat-1' } });
    expect(r.errors).toBeUndefined();
    expect(r.data.revokeGrant).toMatchObject({ id, allows: false, revokedByUserId: memberId });
    expect((await events(id))[0]).toMatchObject({ actor_user_id: memberId, worker_id: w.workerId });
    const acts = await db.agentTeamEvent.findMany({ where: { appId: w.appId, type: 'app.credential-act' } });
    expect(acts.map((e) => (e.payload as any).act)).toEqual(['grant.revoke']);
  });

  it('an instruction does not lift a holder who does not manage: refused, and nothing recorded', async () => {
    const id = await active();
    const r = await post(memberKey, workerSession, REVOKE, { r: id, ins: { kind: 'LIVE_CHAT', ref: 'live-chat-1' } });
    expect(code(r)).toBe('GRANT_NOT_MANAGER');
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await db.agentTeamEvent.count({ where: { type: 'app.credential-act' } })).toBe(0);
  });

  it('acceptance 9: the first end stands. Revoking again, or a grant whose holder departed, changes nothing and records no second event', async () => {
    const id = await active();
    const first = await post(managerKey, null, REVOKE, { r: id });
    const again = await post(managerKey, null, REVOKE, { r: id });
    expect(again.errors).toBeUndefined();
    expect(again.data.revokeGrant.revokedAt).toBe(first.data.revokeGrant.revokedAt);
    expect(await events(id)).toHaveLength(1);

    const gone = await active({ holder_departed_at: raw(DB_NOW) });
    const r = await post(managerKey, null, REVOKE, { r: gone });
    expect(r.errors).toBeUndefined();
    expect(r.data.revokeGrant).toMatchObject({ revokedAt: null, revokedByUserId: null });
    expect(r.data.revokeGrant.holderDepartedAt).not.toBeNull();
    expect(await events(gone)).toHaveLength(0);
    const row = (await grantRows()).find((g) => g.id === gone);
    expect(row.revoked_at).toBeNull();
  });

  it('acceptance 2/3: a revoker waiting behind a row lock judges the LOCKED row: a concurrent revoke ends first, so this one records nothing', async () => {
    const id = await active();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM grants WHERE id = ${id} FOR UPDATE`;
      locked();
      await held;
      await tx.$executeRaw`UPDATE grants SET revoked_at = clock_timestamp() AT TIME ZONE 'UTC', revoked_by = ${outsiderId} WHERE id = ${id}`;
    });
    await lockTaken;
    const waiting = post(managerKey, null, REVOKE, { r: id });
    await waitUntilBlocked();
    release();
    await holder;
    const r = await waiting;
    expect(r.errors).toBeUndefined();
    expect(r.data.revokeGrant.revokedByUserId).toBe(outsiderId);
    expect(await events(id)).toHaveLength(0);
  });
});

describe('acceptance 6-9 (V57): requester withdrawal of a PENDING grant', () => {
  it('a person requester withdraws: stamped with the requester, not live, one REVOKE event', async () => {
    const id = await pending({ requested_by_user_id: managerId });
    const r = await post(managerKey, null, WITHDRAW, { r: id });
    expect(r.errors).toBeUndefined();
    expect(r.data.withdrawGrant).toMatchObject({ id, allows: false, revokedByUserId: managerId });
    expect(r.data.withdrawGrant.revokedAt).not.toBeNull();
    expect(await events(id)).toHaveLength(1);
  });

  it('a worker requester withdraws through its session: the driving person is the user-valued revoker, the worker is in the event', async () => {
    const id = await pending({ worker_id: w.workerId, requested_by_user_id: memberId, requested_by_worker_id: w.workerId });
    const r = await post(memberKey, workerSession, WITHDRAW, { r: id });
    expect(r.errors).toBeUndefined();
    expect(r.data.withdrawGrant).toMatchObject({ id, revokedByUserId: null });
    const row = (await grantRows())[0];
    expect(row.revoked_by).toBe(memberId);
    expect((await events(id))[0]).toMatchObject({ actor_user_id: memberId, worker_id: w.workerId });
  });

  it('not the requester: another person, a manager who did not request it, another worker and an App key each get GRANT_NOT_REQUESTER and the row is unchanged', async () => {
    const id = await pending({ worker_id: w.workerId, requested_by_user_id: memberId, requested_by_worker_id: w.workerId });
    expect(code(await post(managerKey, null, WITHDRAW, { r: id }))).toBe('GRANT_NOT_REQUESTER');
    const otherSession = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: managerId, workerId: otherWorkerId, agentId: w.agentId } })).id;
    await db.worker.update({ where: { id: otherWorkerId }, data: { heldByUserId: managerId } });
    const holderWorkerGrant = await pending({ worker_id: otherWorkerId, requested_by_user_id: memberId, requested_by_worker_id: w.workerId });
    expect(code(await post(managerKey, otherSession, WITHDRAW, { r: holderWorkerGrant }))).toBe('GRANT_NOT_REQUESTER');
    const rows = await grantRows();
    expect(rows.every((g) => g.revoked_at === null)).toBe(true);
    expect(await events(id)).toHaveLength(0);
  });

  it('a grant the caller cannot read answers as a missing one (GRANT_NOT_FOUND), the same for an unknown id', async () => {
    const id = await pending({ requested_by_user_id: managerId });
    const a = await post(outsiderKey, null, WITHDRAW, { r: id });
    const b = await post(outsiderKey, null, WITHDRAW, { r: generateId() });
    expect(code(a)).toBe('GRANT_NOT_FOUND');
    expect(code(b)).toBe('GRANT_NOT_FOUND');
    expect(a.errors[0].message).toBe(b.errors[0].message);
    expect((await grantRows())[0].revoked_at).toBeNull();
  });

  it('acceptance 7: an activated grant is refused GRANT_NOT_PENDING and stays live', async () => {
    const id = await active({ requested_by_user_id: managerId });
    const r = await post(managerKey, null, WITHDRAW, { r: id });
    expect(code(r)).toBe('GRANT_NOT_PENDING');
    const row = (await grantRows())[0];
    expect(row.revoked_at).toBeNull();
  });

  it('acceptance 8: a withdrawal waiting behind the activation judges the LOCKED row and is refused GRANT_NOT_PENDING', async () => {
    const id = await pending({ requested_by_user_id: managerId });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const activation = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM grants WHERE id = ${id} FOR UPDATE`;
      locked();
      await held;
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET activated_at = clock_timestamp() AT TIME ZONE 'UTC', verification_kind = 'passkey', verified_by = ${memberId}, issuer_user_id = ${memberId} WHERE id = ${id}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await lockTaken;
    const waiting = post(managerKey, null, WITHDRAW, { r: id });
    await waitUntilBlocked();
    release();
    await activation;
    const r = await waiting;
    expect(code(r)).toBe('GRANT_NOT_PENDING');
    const row = (await grantRows())[0];
    expect(row.revoked_at).toBeNull();
    expect(row.activated_at).not.toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it('acceptance 9: withdrawing twice, or an already revoked or departed grant, changes nothing and records no second event', async () => {
    const id = await pending({ requested_by_user_id: managerId });
    const first = await post(managerKey, null, WITHDRAW, { r: id });
    const again = await post(managerKey, null, WITHDRAW, { r: id });
    expect(again.errors).toBeUndefined();
    expect(again.data.withdrawGrant.revokedAt).toBe(first.data.withdrawGrant.revokedAt);
    expect(await events(id)).toHaveLength(1);

    const departed = await pending({ requested_by_user_id: managerId });
    await db.worker.update({ where: { id: otherWorkerId }, data: { retiredAt: new Date() } }); // a departure needs the holder to have gone
    await db.$transaction((tx) => endHeldGrants(tx, 'worker', otherWorkerId));
    const r = await post(managerKey, null, WITHDRAW, { r: departed });
    expect(r.errors).toBeUndefined();
    expect((await grantRows()).find((g) => g.id === departed).revoked_at).toBeNull();
    expect(await events(departed)).toHaveLength(0);
  });
});

describe('the manager predicate is re-judged under the held anchor (a demotion that commits while the call waits)', () => {
  /** Hold the org anchor exclusively, soft-delete the manager's membership, and commit only after `start` has begun waiting. */
  async function demoteWhileCallWaits(start: () => Promise<any>): Promise<any> {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const taken = new Promise<void>((r) => { locked = r; });
    const demoter = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: w.orgId }], 'exclusive');
      locked();
      await held;
      await tx.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: managerId } }, data: { deletedAt: new Date() } });
    });
    await taken;
    const call = start();
    await waitUntilBlocked();
    release();
    await demoter;
    return call;
  }

  it('create: a manager removed while the call waits is refused, and no row is written', async () => {
    const r = await demoteWhileCallWaits(() => post(managerKey, null, CREATE, { i: mgrInput() }));
    expect(code(r)).toBe('GRANT_NOT_MANAGER');
    expect(await grantRows()).toHaveLength(0);
  });

  it('revoke: a manager removed while the call waits is refused, and the grant is untouched', async () => {
    const id = await active();
    const r = await demoteWhileCallWaits(() => post(managerKey, null, REVOKE, { r: id }));
    expect(code(r)).toBe('GRANT_NOT_MANAGER');
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });
});

describe('Belinda (blind, 91002379): the worker arm of withdrawGrant is fenced like the revoke door', () => {
  async function holdAndRun(lock: string, change: (tx: any) => Promise<unknown>, start: () => Promise<any>): Promise<any> {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const taken = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(lock);
      locked();
      await held;
      await change(tx);
    });
    await taken;
    const call = start();
    await waitUntilBlocked();
    release();
    await holder;
    return call;
  }
  const mine = () => pending({ worker_id: w.workerId, requested_by_user_id: memberId, requested_by_worker_id: w.workerId });

  it('P2-1: a session that ends while the withdrawal waits cannot complete it: refused, grant untouched, no event', async () => {
    const id = await mine();
    const r = await holdAndRun(`SELECT id FROM sessions WHERE id = '${workerSession}' FOR UPDATE`,
      (tx) => tx.$executeRaw`UPDATE sessions SET ended_at = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = ${workerSession}`,
      () => post(memberKey, workerSession, WITHDRAW, { r: id }));
    expect(code(r)).toBe('GRANT_NOT_FOUND');
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it('P2-1: a worker retired while the withdrawal waits cannot complete it either', async () => {
    const id = await mine();
    const r = await holdAndRun(`SELECT id FROM workers WHERE id = '${w.workerId}' FOR UPDATE`,
      (tx) => tx.$executeRaw`UPDATE workers SET retired_at = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = ${w.workerId}`,
      () => post(memberKey, workerSession, WITHDRAW, { r: id }));
    expect(code(r)).toBe('GRANT_NOT_FOUND');
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });
});

describe('Belinda: the holder kinds a manager may NOT name, the list page, and the instructed-act record', () => {
  it('a USER or an APP holder is the typed holder refusal on the manager arm, and no row is written', async () => {
    expect(code(await post(managerKey, null, CREATE, { i: mgrInput({ holderKind: 'USER', holderRef: memberId }) }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(code(await post(managerKey, null, CREATE, { i: mgrInput({ holderKind: 'APP', holderRef: w.app2Id }) }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await grantRows()).toHaveLength(0);
  });

  it('appGrants pages: limit 0 counts only, limit and offset slice newest first, a huge limit is clamped', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) { ids.push(await pending()); await new Promise((r) => setTimeout(r, 5)); }
    const q = `query($a:String!,$l:Int,$o:Int){appGrants(appRef:$a,limit:$l,offset:$o){total items{id}}}`;
    expect((await post(managerKey, null, q, { a: w.appId, l: 0 })).data.appGrants).toEqual({ total: 3, items: [] });
    const first = (await post(managerKey, null, q, { a: w.appId, l: 2, o: 0 })).data.appGrants;
    const rest = (await post(managerKey, null, q, { a: w.appId, l: 2, o: 2 })).data.appGrants;
    expect(first.total).toBe(3);
    expect([...first.items, ...rest.items].map((g: any) => g.id)).toEqual([...ids].reverse());
    expect((await post(managerKey, null, q, { a: w.appId, l: 100000 })).data.appGrants.items).toHaveLength(3);
  });

  it('a worker session of a person who DOES manage the App still gets an empty page from appGrants', async () => {
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: memberId } }, data: { role: 'ADMIN' } });
    await pending();
    const res = await post(memberKey, workerSession, LIST, { a: w.appId });
    expect(res.data.appGrants).toEqual({ items: [], total: 0 });
  });

  it('a plain person revoke writes no instructed-act record (only a held worker on an instruction does)', async () => {
    const id = await active();
    expect((await post(managerKey, null, REVOKE, { r: id })).errors).toBeUndefined();
    expect(await db.agentTeamEvent.count({ where: { type: 'app.credential-act' } })).toBe(0);
  });
});

describe('Riana, Beckett, Dorian (91002379): the second fix batch', () => {
  it('Riana P2-1: a headless run carrying the manager is refused revokeGrant like create and the list, with no stamp and no event', async () => {
    const id = await active();
    const runCtx = { db, userId: managerId, appId: w.appId, organizationId: w.orgId, clientId: 'run:some-run', roles: [] } as never;
    await expect(grantManageMutations.revokeGrant(null, { ref: id }, runCtx)).rejects.toMatchObject({ extensions: { code: 'GRANT_NOT_MANAGER' } });
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it('Dorian F1 / Riana P2-2: a requester who no longer manages the App withdraws an already-ended signed grant and is NOT shown the signer list', async () => {
    // Needs a signed grant: the shared fixture lives in the audience test file; here the response projection is pinned at the field.
    const id = await active({ requested_by_user_id: managerId, revoked_at: raw(DB_NOW), revoked_by: managerId });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: w.orgId, userId: managerId } }, data: { role: 'CONTRIBUTOR' } });
    const r = await post(managerKey, null, `mutation($r:ID!){withdrawGrant(ref:$r){id revokedByUserId signatureStatus{state signatures{passkeyLabel}}}}`, { r: id });
    expect(r.errors).toBeUndefined();
    expect(r.data.withdrawGrant.revokedByUserId).toBeNull();
    expect(r.data.withdrawGrant.signatureStatus.signatures).toEqual([]);
  });

  it('Beckett: a non-manager revoke on an uninstalled App answers GRANT_NOT_MANAGER, as a missing grant does', async () => {
    const id = await active();
    await db.app.update({ where: { id: w.appId }, data: { uninstalledAt: new Date() } });
    expect(code(await post(memberKey, null, REVOKE, { r: id }))).toBe('GRANT_NOT_MANAGER');
    expect(code(await post(managerKey, null, REVOKE, { r: id }))).toBe('GRANT_NOT_MANAGER');
    expect((await grantRows())[0].revoked_at).toBeNull();
  });

  it('Beckett: a manager naming an agent that does not exist gets the holder refusal, not GRANT_NOT_MANAGER', async () => {
    const r = await post(managerKey, null, CREATE, { i: mgrInput({ holderKind: 'AGENT', holderRef: generateId() }) });
    expect(code(r)).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await grantRows()).toHaveLength(0);
  });

  it('Riana P3: the driving person of a worker requester cannot withdraw it AS the person (only the worker session may)', async () => {
    const id = await pending({ worker_id: w.workerId, requested_by_user_id: memberId, requested_by_worker_id: w.workerId });
    expect(code(await post(memberKey, null, WITHDRAW, { r: id }))).toBe('GRANT_NOT_REQUESTER');
    expect((await grantRows())[0].revoked_at).toBeNull();
  });

  it('Riana P3: a worker session naming another App in appRef is refused on createGrant', async () => {
    const r = await post(memberKey, workerSession, CREATE, { i: { appRef: w.app2Id, action: 'schedule.create', values: entry(), holderKind: 'WORKER', holderRef: w.workerId, reason: 'mine' } });
    expect(code(r)).toBe('GRANT_REQUESTER_NOT_WORKER');
    expect(await grantRows()).toHaveLength(0);
  });
});
