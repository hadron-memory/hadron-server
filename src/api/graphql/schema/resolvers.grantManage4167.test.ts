/**
 * #4167 (cor:acl:140:05 Revoke, hrn:node:hadronmemory.com:specs:cor:acl:140:05; Holger's ruling of 2026-11-14):
 * whoever manages the App may revoke its grants ALSO while the App is uninstalled (not deleted) — the person
 * acts as themselves, the same locks and re-judgements run, one REVOKE event. Everything else about the door
 * keeps its installed-App answer: a non-manager (the grant's issuer included — that arm is NOT widened) gets
 * the byte-identical GRANT_NOT_MANAGER, a deleted App refuses as an unknown App does, `withdrawGrant` keeps
 * its refusal, and no run or impersonation is admitted. Pins go over real GraphQL POSTs, one per gate item.
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
import { grantManageMutations } from './resolvers.grantManage.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedReadableNodes, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';

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
// Teardown: destroy keep-alive sockets, then close — BOUNDED, because this server's close callback is
// observed to hang even with zero connections on this runner (a teardown flake, not a code defect;
// the fork is torn down right after regardless, and the DB cleanup below still runs).
afterAll(async () => {
  http.closeIdleConnections?.();
  http.closeAllConnections?.();
  await Promise.race([new Promise<void>((r) => http.close(() => r)), new Promise<void>((r) => setTimeout(r, 2000))]);
  await cleanDb(db);
  await dropTestActions();
  vi.unstubAllEnvs();
});

let w: World;
let pubNode: string; // #4067: a node the requester can read
/** manager: org ADMIN (user2). member: contributor (user1). The manager manages the App; the member does not. */
let managerId: string; let memberId: string;
let managerKey: string; let memberKey: string;
let otherWorkerId: string;

async function keyFor(userId: string): Promise<string> {
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  return k;
}
async function post(key: string, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}
const code = (r: any): string | undefined => r.errors?.[0]?.extensions?.code;
const msg = (r: any): string | undefined => r.errors?.[0]?.message;
const GRANT = 'id revokedAt revokedByUserId allows';
const REVOKE = `mutation($r:ID!){revokeGrant(ref:$r){${GRANT}}}`;
const WITHDRAW = `mutation($r:ID!){withdrawGrant(ref:$r){${GRANT}}}`;
const entry = () => ({ entryNode: pubNode });
const grantRows = async () => db.$queryRawUnsafe<any[]>('SELECT * FROM grants ORDER BY created_at');
const events = async (grantId: string) => db.$queryRawUnsafe<any[]>("SELECT * FROM grant_events WHERE grant_id = $1 AND action = 'REVOKE'", grantId);
const uninstall = () => db.app.update({ where: { id: w.appId }, data: { uninstalledAt: new Date() } });
const reinstall = () => db.app.update({ where: { id: w.appId }, data: { uninstalledAt: null } });

/** A pending worker-held grant the member asked for (the withdraw door's own row). */
async function pending(): Promise<string> {
  return insertGrant(w, { user_id: null, worker_id: otherWorkerId, action: 'schedule.create', action_values: entry(), requested_by_user_id: memberId });
}
/** An ACTIVE grant issued by `issuer` (the unguarded insert is the test-only way to a live row). */
async function active(issuer: string): Promise<string> {
  return insertGrantUnguarded(w, {
    user_id: null, worker_id: otherWorkerId, action: 'schedule.create', action_values: entry(), requested_by_user_id: memberId,
    issuer_user_id: issuer, verification_kind: 'passkey', verified_by: issuer, activated_at: raw(DB_NOW),
  });
}

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  [pubNode] = await seedReadableNodes(w.orgId);
  await upsertPlatformActions(db);
  memberId = w.userId; managerId = w.user2Id;
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: memberId, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: managerId, role: 'ADMIN' } });
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
  [managerKey, memberKey] = await Promise.all([keyFor(managerId), keyFor(memberId)]);
  otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}` } })).id;
});

describe('#4167: whoever manages the App revokes also while it is uninstalled (cor:acl:140:05)', () => {
  it('RED (the ruling): a manager revokes an ACTIVE grant of an uninstalled App — stamped, ONE REVOKE event naming the person, no worker or session', async () => {
    const id = await active(managerId);
    await uninstall();
    const r = await post(managerKey, REVOKE, { r: id });
    expect(r.errors).toBeUndefined();
    expect(r.data.revokeGrant.allows).toBe(false);
    expect(r.data.revokeGrant.revokedAt).not.toBeNull();
    expect(r.data.revokeGrant.revokedByUserId).toBe(managerId);
    const row = (await grantRows())[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).toBe(managerId);
    const ev = await events(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_user_id: managerId, worker_id: null, session_id: null });
  });

  it('RED (S10): the end survives a reinstall — still revoked, still exactly one event, and a second revoke changes nothing', async () => {
    const id = await active(managerId);
    await uninstall();
    expect((await post(managerKey, REVOKE, { r: id })).errors).toBeUndefined();
    await reinstall();
    const again = await post(managerKey, REVOKE, { r: id });
    expect(again.errors).toBeUndefined();
    expect(again.data.revokeGrant.allows).toBe(false);
    expect(again.data.revokeGrant.revokedAt).not.toBeNull();
    expect(await events(id)).toHaveLength(1);
  });

  it('a non-manager gets the BYTE-IDENTICAL GRANT_NOT_MANAGER the installed App gives — code and message — and nothing is stamped', async () => {
    const installedId = await active(managerId);
    const uninstalledId = await active(managerId);
    const installed = await post(memberKey, REVOKE, { r: installedId });
    await uninstall();
    const uninstalled = await post(memberKey, REVOKE, { r: uninstalledId });
    expect(code(installed)).toBe('GRANT_NOT_MANAGER');
    expect(code(uninstalled)).toBe('GRANT_NOT_MANAGER');
    expect(msg(uninstalled)).toBe(msg(installed));
    expect((await grantRows()).every((row) => row.revoked_at === null)).toBe(true);
    expect(await events(installedId)).toHaveLength(0);
    expect(await events(uninstalledId)).toHaveLength(0);
  });

  it('the issuer arm is NOT widened: the grant\'s issuer who does not manage revokes fine while installed but is refused while uninstalled', async () => {
    const installedId = await active(memberId); // member is the issuer, still a live Org member
    expect((await post(memberKey, REVOKE, { r: installedId })).errors).toBeUndefined(); // the arm itself works
    const uninstalledId = await active(memberId);
    await uninstall();
    const refused = await post(memberKey, REVOKE, { r: uninstalledId });
    expect(code(refused)).toBe('GRANT_NOT_MANAGER');
    expect((await grantRows().then((rows) => rows.find((row) => row.id === uninstalledId))).revoked_at).toBeNull();
    expect(await events(uninstalledId)).toHaveLength(0);
  });

  it('a DELETED App refuses exactly as an unknown grant does — same code and message — and nothing is stamped', async () => {
    const id = await active(managerId);
    const unknown = await post(managerKey, REVOKE, { r: generateId() });
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    const deleted = await post(managerKey, REVOKE, { r: id });
    expect(code(unknown)).toBe('GRANT_NOT_MANAGER');
    expect(code(deleted)).toBe('GRANT_NOT_MANAGER');
    expect(msg(deleted)).toBe(msg(unknown));
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it('withdrawGrant keeps its refusal on an uninstalled App: the requester\'s own PENDING grant answers GRANT_NOT_FOUND and stays pending', async () => {
    const id = await pending();
    await uninstall();
    expect(code(await post(memberKey, WITHDRAW, { r: id }))).toBe('GRANT_NOT_FOUND');
    const row = (await grantRows())[0];
    expect(row.revoked_at).toBeNull();
    expect(row.activated_at).toBeNull();
  });

  it('no run bypass: a headless run carrying the manager is refused as a non-manager while uninstalled, with no stamp and no event', async () => {
    const id = await active(managerId);
    await uninstall();
    const runCtx = { db, userId: managerId, appId: w.appId, organizationId: w.orgId, clientId: 'run:some-run', roles: [] } as never;
    await expect(grantManageMutations.revokeGrant(null, { ref: id }, runCtx)).rejects.toMatchObject({ extensions: { code: 'GRANT_NOT_MANAGER' } });
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it('no impersonation bypass: an impersonated session of the manager is refused as a non-manager while uninstalled', async () => {
    const id = await active(managerId);
    await uninstall();
    const impCtx = { db, userId: managerId, appId: w.appId, organizationId: w.orgId, impersonation: { orgId: w.orgId }, roles: [] } as never;
    await expect(grantManageMutations.revokeGrant(null, { ref: id }, impCtx)).rejects.toMatchObject({ extensions: { code: 'GRANT_NOT_MANAGER' } });
    expect((await grantRows())[0].revoked_at).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });
});
