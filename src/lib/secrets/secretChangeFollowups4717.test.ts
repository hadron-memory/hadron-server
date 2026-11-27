/**
 * #4717 (follow-ups of #4177, App secrets S4): the audit trail of a protected create and a protection-only update, the
 * duplicate-name refusal at staging, an idempotent schema for the change-request objects, rate admission on withdraw,
 * no request for a no-op clear, and the stated cap precedence. hrn:node:hadronmemory.com:specs:cor:sec:010:05,
 * hrn:node:hadronmemory.com:specs:cor:sec:070:01, hrn:node:hadronmemory.com:specs:cor:sec:070:02.
 * Real database and real software-passkey assertions, no production or provider calls.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { openSecretProof, proveSecretChange, completeSecretChange } from './changeCeremony.js';
import { type ChangeRequest, MAX_OPEN_SECRET_CHANGES, MAX_OPEN_SECRET_CHANGES_PER_REQUESTER } from './changeRequests.js';
import { upsertPlatformActions } from '../grants/actions.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const RP = 'localhost', ORIGIN = 'http://localhost:4000';
let userId: string, appId: string, secretId: string;
const key = softPasskey();
const ctx = (): Context => ({ db, userId, roles: [] } as unknown as Context);
const error = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected refusal'); }, (e) => e);
async function proof(id: string, nonce = 'browser-nonce-4717') {
  const open = await openSecretProof(db, { requestId: id, browserNonceHash: hash(nonce) });
  return proveSecretChange(db, { requestId: id, ceremonyId: open.ceremonyId, browserNonceHash: hash(nonce), credentialId: key.credentialId,
    assertion: key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(open.challenge, 'base64url'), origin: ORIGIN, rpId: RP }) });
}
async function complete(id: string, p: any) {
  return completeSecretChange(db, { requestId: id, ceremonyId: p.ceremonyId, browserNonceHash: hash(p.nonce), credentialId: key.credentialId,
    assertion: key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(p.challenge, 'base64url'), origin: ORIGIN, rpId: RP }) });
}
async function staged(p: Promise<unknown>): Promise<string> {
  const e = await error(p);
  expect(e.extensions?.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
  return e.extensions.requestId as string;
}
const ceremony = async (id: string) => complete(id, await proof(id));
const eventKinds = async (secretName: string) =>
  (await db.secretEvent.findMany({ where: { ownerId: appId, secretName }, orderBy: [{ at: 'asc' }, { seq: 'asc' }], select: { kind: true } })).map((e) => e.kind);
const row = async (id: string) => (await db.$queryRaw<ChangeRequest[]>`SELECT * FROM secret_change_requests WHERE id=${id}`)[0];
const member = async () => {
  const id = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  await db.appMember.create({ data: { appId, userId: id, role: 'reader' } });
  return id;
};

// #4626 item 14: stubbed, not written, so afterEach restores the worker process's environment for the next file.
beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32)); vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP); vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S4 follow-ups', urn: `${generateId().toLowerCase()}:s4f` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctx())).id;
  await insertSoftPasskey(db, userId, key, { rpId: RP });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('#4717 item 1: a protected create records its protection', () => {
  it('records the STORE and exactly one PROTECT event', async () => {
    const id = await staged(resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'born-protected', kind: 'generic', value: 'v', protected: true }, ctx()));
    await ceremony(id);
    expect(await eventKinds('born-protected')).toEqual(['STORE', 'PROTECT']);
  });
});

describe('#4717 item 2: a protection-only update records no METADATA event', () => {
  it('turning protection on through updateSecret records PROTECT alone', async () => {
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: true }, ctx()));
    await ceremony(id);
    expect(await eventKinds('canary')).toEqual(['STORE', 'PROTECT']);
  });
  it('turning protection off through updateSecret records UNPROTECT alone', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false }, ctx()));
    await ceremony(id);
    expect(await eventKinds('canary')).toEqual(['STORE', 'UNPROTECT']);
  });
  it('a protection change that also changes metadata still records METADATA, then the protection event', async () => {
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: true, metadata: { note: 'changed' } }, ctx()));
    await ceremony(id);
    expect(await eventKinds('canary')).toEqual(['STORE', 'METADATA', 'PROTECT']);
  });
  it('a metadata update of a protected secret still records METADATA', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, metadata: { note: 'changed' } }, ctx()));
    await ceremony(id);
    expect(await eventKinds('canary')).toEqual(['STORE', 'METADATA']);
  });
});

describe('#4717 item 3: a protected create of a taken name refuses at staging', () => {
  it('refuses with the duplicate-name refusal and stages nothing', async () => {
    const before = await db.secretChangeRequest.count();
    const e = await error(resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'dup', protected: true }, ctx()));
    expect(e.extensions?.code).toBe('BAD_USER_INPUT');
    expect(e.message).toBe('A secret named "canary" already exists at this scope.');
    expect(await db.secretChangeRequest.count()).toBe(before);
  });
  it('the completion check still stands: a name taken after staging ends the request stale', async () => {
    const id = await staged(resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'racing', kind: 'generic', value: 'staged', protected: true }, ctx()));
    const p = await proof(id);
    await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'racing', kind: 'generic', value: 'ordinary' }, ctx());
    await expect(complete(id, p)).rejects.toMatchObject({ extensions: { code: 'SECRET_CHANGE_REQUEST_STALE' } });
    expect((await row(id)).state).toBe('stale');
  });
});

describe('#4717 item 4: the change-request objects apply by either path, in either order, twice', () => {
  const read = (p: string) => readFileSync(new URL(`../../../prisma/${p}`, import.meta.url), 'utf8');
  const MIGRATION = 'migrations/20261127090000_secret_delete_after_use/migration.sql';
  it('the migration and post-push share one source for these objects', () => {
    const invariants = read('secret-change-requests-invariants.sql');
    expect(read(MIGRATION)).toContain(invariants);
    expect(read('post-push.sql')).toContain('\\ir secret-change-requests-invariants.sql');
    expect(read('post-push.sql')).not.toContain('CREATE TABLE IF NOT EXISTS secret_change_requests');
  });
  it('the migration and the shared file apply twice each, in both orders, over a post-push database', async () => {
    // The test database was built by post-push.sql, so every order starts from "post-push applied".
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      for (const file of [MIGRATION, MIGRATION, 'secret-change-requests-invariants.sql', MIGRATION, 'secret-change-requests-invariants.sql']) {
        await client.query(read(file));
      }
      const { rows } = await client.query(`SELECT
        (SELECT count(*) FROM pg_trigger WHERE tgname IN ('secret_change_requests_guard','secret_changes_secret_deleted','secret_changes_app_deleted','secret_change_revision') AND NOT tgisinternal)::int AS triggers,
        (SELECT count(*) FROM pg_indexes WHERE indexname IN ('secret_change_requests_secret_open','secret_change_requests_expiry'))::int AS indexes,
        (SELECT count(*) FROM pg_constraint WHERE conname='chk_secret_change_shape')::int AS checks`);
      expect(rows[0]).toEqual({ triggers: 4, indexes: 2, checks: 1 });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});

describe('#4717 item 5: withdraw is rate-admitted', () => {
  it('an admitted withdraw under an enforcing policy ends the request and clears its staged value', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged' }, ctx()));
    await db.rateLimitPolicy.update({ where: { fieldClass: 'WRITES' }, data: { principalLimit: 1000, enforcementMode: 'ENFORCING' } });
    expect(await resolvers.Mutation.withdrawSecretChangeRequest({}, { id }, ctx())).toBe(true);
    expect((await row(id)).state).toBe('withdrawn');
    expect((await row(id)).staged_value_encrypted).toBeNull();
  });
  it('a rate-refused withdraw leaves the request open with its staged value', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged' }, ctx()));
    await db.rateLimitPolicy.update({ where: { fieldClass: 'WRITES' }, data: { principalLimit: 1, enforcementMode: 'ENFORCING' } });
    const e = await error(resolvers.Mutation.withdrawSecretChangeRequest({}, { id }, ctx()));
    expect(e.extensions?.code).toBe('RATE_LIMITED');
    expect((await row(id)).state).toBe('open');
    expect((await row(id)).staged_value_encrypted).toBeTruthy();
  });
});

describe('#4717 item 8: clearing protection on an unprotected secret is a no-op', () => {
  it('stages nothing, spends no slot and records no event for whoever manages the App', async () => {
    const before = await db.secretChangeRequest.count();
    const result = await resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: false }, ctx());
    expect(result).toMatchObject({ id: secretId, protected: false });
    expect(await db.secretChangeRequest.count()).toBe(before);
    expect(await eventKinds('canary')).toEqual(['STORE']);
  });
  it('a member who cannot turn protection off gets the same refusal whether or not the secret is protected', async () => {
    const reader = { ...ctx(), userId: await member() };
    const unprotected = await error(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: false }, reader));
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const protectedOne = await error(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: false }, reader));
    expect(unprotected.extensions).toEqual(protectedOne.extensions);
    expect(unprotected.message).toBe(protectedOne.message);
    expect(unprotected.extensions.code).toBe('FORBIDDEN');
    expect(await db.secretChangeRequest.count()).toBe(0);
  });
});

describe('#4717 item 9: the aggregate cap is judged before the per-requester cap', () => {
  it('each cap alone answers its own code', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const others = [await member(), await member()].map((u) => ({ ...ctx(), userId: u }));
    // Requester cap alone: the caller holds 2 of 2, the secret 2 of 5.
    for (const caller of [ctx(), ctx()]) await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged' }, caller));
    expect((await error(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'third' }, ctx()))).extensions?.code).toBe('SECRET_CHANGE_REQUESTER_LIMIT');
    // Aggregate cap alone: the secret holds 5 of 5, this caller 1 of 2.
    for (const caller of [others[0], others[0], others[1]]) await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged' }, caller));
    expect((await error(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'sixth' }, others[1]))).extensions?.code).toBe('SECRET_CHANGE_REQUEST_LIMIT');
  });
  it('a caller at both limits gets SECRET_CHANGE_REQUEST_LIMIT', async () => {
    expect(MAX_OPEN_SECRET_CHANGES).toBe(5); expect(MAX_OPEN_SECRET_CHANGES_PER_REQUESTER).toBe(2);
    await db.secret.update({ where: { id: secretId }, data: { protected: true } });
    const others = [await member(), await member()].map((u) => ({ ...ctx(), userId: u }));
    for (const caller of [ctx(), ctx(), others[0], others[0], others[1]]) {
      await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged' }, caller));
    }
    const e = await error(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'sixth' }, ctx()));
    expect(e.extensions?.code).toBe('SECRET_CHANGE_REQUEST_LIMIT');
  });
});
