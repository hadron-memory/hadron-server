/** #3998 R4 / Q21 / Q26: who may issue a read client for an App secret. Real DB; the gate is called as the issuing transaction calls it. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { requireSecretReadClientIssuer, SECRET_READ_CLIENT_SUPERSEDED } from './readClientIssuer.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
type IssuerCaller = Context;

let ownerId: string; let memberId: string; let writer2Id: string; let outsiderId: string; let adminId: string;
let appId: string; let workerId: string; let sessionId: string; let orgAppId: string; let secretId: string;
const mk = async () => (await db.user.create({ data: { email: `${generateId()}@i.test` } })).id;
const caller = (userId: string, over: Record<string, unknown> = {}): IssuerCaller => ({ db, userId, roles: [], ...over } as unknown as IssuerCaller);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { extensions?: { code?: string } }) => e.extensions?.code ?? 'ERR');
const version = async (by: { user?: string; worker?: string }, n: number) => {
  await db.$executeRaw`INSERT INTO secret_app_keys (app_id, key_version, wrapped_key) VALUES (${appId}, 1, 'k') ON CONFLICT DO NOTHING`;
  await db.$executeRaw`
  INSERT INTO secret_versions (id, secret_id, version_no, value_encrypted, app_id, key_version, size_bytes, written_by_user_id, written_by_worker_id)
  VALUES (${generateId()}, ${secretId}, ${n}, 'x', ${appId}, 1, 1, ${by.user ?? null}, ${by.worker ?? null})`;
};

beforeEach(async () => {
  await cleanDb(db);
  [ownerId, memberId, writer2Id, outsiderId, adminId] = [await mk(), await mk(), await mk(), await mk(), await mk()];
  appId = (await db.app.create({ data: { name: 'i', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:i` } })).id;
  for (const u of [memberId, writer2Id]) await db.appMember.create({ data: { appId, userId: u, role: 'reader' } });
  const org = await db.organization.create({ data: { name: 'o', urn: `${generateId().toLowerCase()}.test` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
  orgAppId = (await db.app.create({ data: { name: 'oa', organizationId: org.id, urn: `${org.urn}:oa` } })).id;
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'a', urn: `${org.urn}:agent` } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'w', slug: `w-${generateId().slice(0, 6)}` } })).id;
  sessionId = (await db.session.create({ data: { id: generateId(), appId, workerId, agentId: agent.id } as never })).id;
  secretId = generateId();
  await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${secretId}, 'app', ${appId}, 'tok', 'generic', now())`;
});
const gate = (c: IssuerCaller, id = secretId) => requireSecretReadClientIssuer(c, id);

describe('#3998 secret read client issuer', () => {
  it('lets the App owner issue as a manager', async () => {
    await version({ user: memberId }, 1);
    await expect(gate(caller(ownerId))).resolves.toMatchObject({ asWriter: false, appId, secretId });
  });
  it('lets the current version writer issue as writer', async () => {
    await version({ user: memberId }, 1);
    await expect(gate(caller(memberId))).resolves.toMatchObject({ asWriter: true });
  });
  it('refuses a former writer with SUPERSEDED once someone else wrote a newer version (Q21)', async () => {
    await version({ user: memberId }, 1); await version({ user: writer2Id }, 2);
    expect(await code(gate(caller(memberId)))).toBe(SECRET_READ_CLIENT_SUPERSEDED);
    expect(await code(gate(caller(writer2Id)))).toBe('OK');
  });
  it('refuses a writer whose newest version a worker wrote: manager only', async () => {
    await version({ user: memberId, worker: workerId }, 1);
    expect(await code(gate(caller(memberId)))).not.toBe('OK');
    expect(await code(gate(caller(ownerId)))).toBe('OK');
  });
  it('refuses a writer who left the App, and an outsider, uniformly', async () => {
    await version({ user: memberId }, 1);
    await db.appMember.deleteMany({ where: { appId, userId: memberId } });
    const a = await code(gate(caller(memberId))); const b = await code(gate(caller(outsiderId)));
    expect(a).not.toBe('OK'); expect(a).toBe(b);
  });
  it('has no platform arm: a platform ADMIN who does not manage the App is refused (Q26)', async () => {
    const sid = generateId();
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${sid}, 'app', ${orgAppId}, 'tok', 'generic', now())`;
    expect(await code(gate(caller(outsiderId, { roles: ['ADMIN'] }), sid))).not.toBe('OK');
  });
  it('lets a live org ADMIN of an org-owned App issue', async () => {
    const sid = generateId();
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at) VALUES (${sid}, 'app', ${orgAppId}, 'tok', 'generic', now())`;
    await expect(gate(caller(adminId), sid)).resolves.toMatchObject({ asWriter: false });
  });
  it('refuses a worker session, impersonation, an App key and a run principal even for a manager', async () => {
    await version({ user: memberId }, 1);
    for (const over of [{ sessionId }, { impersonation: { by: 'x' } }, { userId: undefined }, { clientId: 'run:r1' }]) {
      expect(await code(gate(caller(ownerId, over)))).not.toBe('OK');
    }
  });
  it('refuses a deleted App, an uninstalled App, an org secret and a missing secret', async () => {
    await version({ user: memberId }, 1);
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } });
    expect(await code(gate(caller(ownerId)))).not.toBe('OK');
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: null, deletedAt: new Date() } });
    expect(await code(gate(caller(ownerId)))).not.toBe('OK');
    expect(await code(gate(caller(ownerId), 'missing'))).not.toBe('OK');
  });
});
