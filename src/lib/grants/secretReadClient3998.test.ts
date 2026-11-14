/**
 * #3998 S3 / #3991 R1, R2: the secret_read_clients table holds only the association and one stored end. Pins the
 * database guards in prisma/secret-read-clients-invariants.sql (no window, budget, mark or counter exists to alter).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from './grantFixtures3668.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

async function appSecret(appId: string, name = 'tok'): Promise<string> {
  const id = `sec_${name}_${Math.random().toString(36).slice(2, 10)}`;
  await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, updated_at, protected)
    VALUES (${id}, 'app', ${appId}, ${name}, 'generic', now(), false)`;
  return id;
}
async function client(over: { appId?: string; secretId?: string; grantId?: string } = {}): Promise<string> {
  const grantId = over.grantId ?? await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '1 minute'`) });
  const secretId = over.secretId ?? await appSecret(w.appId);
  const id = `c_${Math.random().toString(36).slice(2, 12)}`;
  await db.$executeRaw`INSERT INTO secret_read_clients (id, grant_id, app_id, secret_id, secret_name, issuer_user_id, self_issued)
    VALUES (${id}, ${grantId}, ${over.appId ?? w.appId}, ${secretId}, 'tok', ${w.userId}, false)`;
  return id;
}
const endOf = async (id: string) => (await db.$queryRaw<Array<{ end_reason: string | null; ended_at: Date | null }>>`
  SELECT end_reason, ended_at FROM secret_read_clients WHERE id = ${id}`)[0];

describe('#3998 secret_read_clients', () => {
  it('issues against an App secret of its own App', async () => {
    const id = await client();
    expect(await endOf(id)).toEqual({ end_reason: null, ended_at: null });
  });

  it('refuses a secret of another App, an org secret and an unknown id', async () => {
    await expect(client({ secretId: await appSecret(w.app2Id) })).rejects.toThrow();
    await expect(client({ secretId: 'no-such-secret' })).rejects.toThrow();
    const orgSecret = `sec_org_${Math.random().toString(36).slice(2, 8)}`;
    await db.$executeRaw`INSERT INTO secrets (id, owner_type, owner_id, name, kind, value_encrypted, updated_at)
      VALUES (${orgSecret}, 'org', ${w.orgId}, 'o', 'generic', 'x', now())`;
    await expect(client({ secretId: orgSecret })).rejects.toThrow();
  });

  it('is one client per grant', async () => {
    const grantId = await insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '1 minute'`) });
    await client({ grantId });
    await expect(client({ grantId })).rejects.toThrow();
  });

  it('is immutable but for its one end, and ends once', async () => {
    const id = await client();
    await expect(db.$executeRaw`UPDATE secret_read_clients SET secret_name = 'x' WHERE id = ${id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE secret_read_clients SET self_issued = true WHERE id = ${id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE secret_read_clients SET secret_id = ${await appSecret(w.appId, 'b')} WHERE id = ${id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE secret_read_clients SET end_reason = 'SPENT', ended_at = now() WHERE id = ${id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE secret_read_clients SET end_reason = 'PROTECTED' WHERE id = ${id}`).rejects.toThrow();
    await db.$executeRaw`UPDATE secret_read_clients SET end_reason = 'PROTECTED', ended_at = now() WHERE id = ${id}`;
    await expect(db.$executeRaw`UPDATE secret_read_clients SET end_reason = 'SECRET_DELETED' WHERE id = ${id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE secret_read_clients SET ended_at = NULL, end_reason = NULL WHERE id = ${id}`).rejects.toThrow();
    expect((await endOf(id)).end_reason).toBe('PROTECTED');
  });

  it("a secret's deletion ends its client with SECRET_DELETED, and a same-name secret is a different id", async () => {
    const secretId = await appSecret(w.appId, 'tok');
    const id = await client({ secretId });
    await db.$executeRaw`DELETE FROM secrets WHERE id = ${secretId}`;
    expect((await endOf(id)).end_reason).toBe('SECRET_DELETED');
    const again = await appSecret(w.appId, 'tok');
    expect(again).not.toBe(secretId);
    expect((await endOf(id)).end_reason).toBe('SECRET_DELETED');
  });

  it('keeps an end it already has when the secret is deleted later', async () => {
    const secretId = await appSecret(w.appId);
    const id = await client({ secretId });
    await db.$executeRaw`UPDATE secret_read_clients SET end_reason = 'PROTECTED', ended_at = now() WHERE id = ${id}`;
    await db.$executeRaw`DELETE FROM secrets WHERE id = ${secretId}`;
    expect((await endOf(id)).end_reason).toBe('PROTECTED');
  });

  it('carries no window, budget, mark or counter column', async () => {
    const cols = (await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'secret_read_clients'`).map((c) => c.column_name);
    expect(cols.sort()).toEqual(['app_id', 'created_at', 'end_reason', 'ended_at', 'grant_id', 'id', 'issuer_user_id',
      'secret_id', 'secret_name', 'self_issued']);
  });

  it('keeps the migration and post-push in step with the invariants file', () => {
    const inv = readFileSync(new URL('../../../prisma/secret-read-clients-invariants.sql', import.meta.url), 'utf8');
    const mig = readFileSync(new URL('../../../prisma/migrations/20261114140000_secret_read_clients/migration.sql', import.meta.url), 'utf8');
    expect(mig.endsWith(inv)).toBe(true);
    expect(readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir secret-read-clients-invariants.sql');
  });
});
