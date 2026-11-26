/**
 * #4626 (follow-ups to #3991 slice 4 — contract descriptions, pins and hygiene): the proof summary's metadata equality
 * (item 7), the forged non-value STORE refused at completion (item 8), removed-member completion for DELETE and
 * SET_PROTECTED with the request left open (item 9), the emitted App-secret URN shape (item 13, coverage only), the
 * updateSecret description's legacy webfetch-auth recovery pair (item 1), and item 17 — the slice's only behaviour
 * change — where a protection-flag-only change must not claim a metadata change.
 * hrn:node:hadronmemory.com:specs:cor:sec:070:02. Real database and real software-passkey assertions, no production or
 * provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { openSecretProof, proveSecretChange, completeSecretChange, SecretCeremonyRefused } from './changeCeremony.js';
import { type ChangeRequest } from './changeRequests.js';
import { upsertPlatformActions } from '../grants/actions.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const RP = 'localhost', ORIGIN = 'http://localhost:4000';
let userId: string, appId: string, secretId: string;
const key = softPasskey();
const ctx = (): Context => ({ db, userId, roles: [] } as unknown as Context);
const error = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected refusal'); }, (e) => e);
async function proof(id: string, k = key, nonce = 'browser-nonce-4626') {
  const open = await openSecretProof(db, { requestId: id, browserNonceHash: hash(nonce) });
  return proveSecretChange(db, { requestId: id, ceremonyId: open.ceremonyId, browserNonceHash: hash(nonce), credentialId: k.credentialId,
    assertion: k.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(open.challenge, 'base64url'), origin: ORIGIN, rpId: RP }) });
}
async function complete(id: string, p: any, k = key) {
  return completeSecretChange(db, { requestId: id, ceremonyId: p.ceremonyId, browserNonceHash: hash(p.nonce), credentialId: k.credentialId,
    assertion: k.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(p.challenge, 'base64url'), origin: ORIGIN, rpId: RP }) });
}
async function staged(p: Promise<unknown>): Promise<string> {
  const e = await error(p);
  expect(e.extensions?.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
  return e.extensions.requestId as string;
}
const row = async (id: string) => (await db.$queryRaw<ChangeRequest[]>`SELECT * FROM secret_change_requests WHERE id=${id}`)[0];
const member = async () => {
  const id = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  await db.appMember.create({ data: { appId, userId: id, role: 'reader' } });
  return id;
};

beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32)); vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP); vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S4 4626', urn: `${generateId().toLowerCase()}:s46` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctx())).id;
  await db.secret.update({ where: { id: secretId }, data: { protected: true } });
  await insertSoftPasskey(db, userId, key, { rpId: RP });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('#4626 item 7: the proof summary carries the staged inspectable metadata', () => {
  it('equals the staged metadata for a metadata-only edit', async () => {
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, metadata: { label: 'chosen' } }, ctx()));
    const p = await proof(id);
    expect(p.outcome).toBe('change');
    if (p.outcome === 'change') expect(p.summary.metadata).toEqual({ label: 'chosen' });
  });
  it('equals the staged metadata for a protected create, with the auth type derived from the value', async () => {
    const id = await staged(resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'born-4626', kind: 'webfetch-auth',
      metadata: { urlPrefix: 'https://api.example.test/v1' }, value: { type: 'bearer', token: 'synthetic' }, protected: true }, ctx()));
    const p = await proof(id);
    expect(p.outcome).toBe('change');
    if (p.outcome === 'change') expect(p.summary.metadata).toEqual({ urlPrefix: 'https://api.example.test/v1', type: 'bearer' });
  });
});

describe('#4626 item 8: a non-value STORE with no existing secret is refused at completion', () => {
  it('refuses the forged row at the no-secret guard, leaves the request open and creates no secret', async () => {
    // A row no resolver can stage: STORE with no value and no secret (neither by id nor by name). Only a direct
    // insert forges it; without the guard its completion would create a valueless App secret.
    const id = generateId();
    await db.secretChangeRequest.create({ data: { id, appId, secretId: null, secretName: 'forged-no-value', secretKind: 'generic',
      metadata: { note: 'forged' }, operation: 'STORE', requesterId: userId, state: 'open',
      snapshot: hash(`forged-${id}`), stagedValueEncrypted: null, keyVersion: null, sizeBytes: null,
      protectedResult: null, writeVersion: false, expiresAt: new Date(Date.now() + 60_000) } });
    const p = await proof(id);
    // What pins the no-secret guard at completion (changeCeremony.ts `else if(!secret)throw refuse()`) is the
    // FIXTURE, not the error's text: secret_id is null and the secret_name matches no row, so the stale gate tests
    // name existence (the snapshot hash is compared against secret state only when secret_id is set — the arbitrary
    // value here is never read), and write_version=false leaves the staged-value arm unreachable. Every refuse()
    // site throws the same one-sentence class, so the class and the message below pin only THAT a ceremony refusal
    // happened; every GraphQLError gate (stale, expired, cooling-off) carries extensions.code and extensions stays
    // undefined on SecretCeremonyRefused, which is the observable separating the two refusal families.
    const err = await error(complete(id, p));
    expect(err).toBeInstanceOf(SecretCeremonyRefused);
    expect(err.message).toBe('Secret ceremony refused.');
    expect(err.extensions).toBeUndefined();
    expect((await row(id)).state).toBe('open');
    expect(await db.secret.count({ where: { ownerType: 'app', ownerId: appId, name: 'forged-no-value' } })).toBe(0);
  });
});

describe('#4626 item 9: removed-member completion is refused for DELETE and SET_PROTECTED, the request left open', () => {
  it('refuses a removed member completing DELETE; the secret survives and the request stays open', async () => {
    const owner = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
    await db.app.update({ where: { id: appId }, data: { ownerUserId: owner } });
    await db.appMember.create({ data: { appId, userId, role: 'reader' } });
    // userId created the canary secret, so it may stage the delete while still a member.
    const id = await staged(resolvers.Mutation.deleteSecret({}, { ref: secretId }, ctx()));
    const p = await proof(id);
    await db.appMember.deleteMany({ where: { appId, userId } });
    await expect(complete(id, p)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect((await row(id)).state).toBe('open');
    expect(await db.secret.count({ where: { id: secretId } })).toBe(1);
  });
  it('refuses a removed member completing SET_PROTECTED; the flag is unchanged and the request stays open', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: false } });
    const readerId = await member();
    const readerKey = softPasskey();
    await insertSoftPasskey(db, readerId, readerKey, { rpId: RP });
    const readerCtx = { ...ctx(), userId: readerId };
    const id = await staged(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: true }, readerCtx));
    const p = await proof(id, readerKey);
    await db.appMember.deleteMany({ where: { appId, userId: readerId } });
    await expect(complete(id, p, readerKey)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect((await row(id)).state).toBe('open');
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } })).protected).toBe(false);
  });
});

describe('#4626 item 13 (coverage only): the App-secret URN the proof emits', () => {
  it('rewrites hrn:app:<root>:<slug> into hrn:secret:<root>:app:<slug>:<name>', async () => {
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged-4626' }, ctx()));
    const p = await proof(id);
    expect(p.outcome).toBe('change');
    if (p.outcome !== 'change') throw new Error('change expected');
    const appUrn = (await db.app.findUniqueOrThrow({ where: { id: appId } })).urn;
    const [root, slug] = appUrn.split(':');
    expect(p.summary.app).toBe(`hrn:app:${appUrn}`);
    expect(p.summary.secret).toBe(`hrn:secret:${root}:app:${slug}:canary`);
  });
});

describe('#4626 item 17: a protection-flag-only change does not claim a metadata change', () => {
  it('names the flag alone, and carries no metadata key, when turning protection off leaves the metadata unchanged', async () => {
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false }, ctx()));
    const p = await proof(id);
    expect(p.outcome).toBe('change');
    if (p.outcome === 'change') {
      expect(p.summary.change).toBe('Turn protection off');
      expect(p.summary).not.toHaveProperty('metadata');
    }
  });
  it('names the flag alone, and carries no metadata key, when turning protection on leaves the metadata unchanged', async () => {
    await db.secret.update({ where: { id: secretId }, data: { protected: false } });
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: true }, ctx()));
    const p = await proof(id);
    expect(p.outcome).toBe('change');
    if (p.outcome === 'change') {
      expect(p.summary.change).toBe('Turn protection on');
      expect(p.summary).not.toHaveProperty('metadata');
    }
  });
  it('still names the metadata, and carries it, when it changes together with the flag', async () => {
    const id = await staged(resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false, metadata: { note: 'changed' } }, ctx()));
    const p = await proof(id);
    expect(p.outcome).toBe('change');
    if (p.outcome === 'change') {
      expect(p.summary.change).toBe('Update secret metadata and turn protection off');
      expect(p.summary.metadata).toEqual({ note: 'changed' });
    }
  });
});

describe('#4626 item 1: the updateSecret description\'s legacy webfetch-auth recovery, as the code behaves', () => {
  // A "legacy" row is one written before metadata.type was derived from the value; forge one by stripping the
  // derived type from a row created through the real door (the derivation itself is pinned in resolvers.secret.test.ts).
  async function legacyRow() {
    const id = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: `legacy-${generateId()}`,
      kind: 'webfetch-auth', metadata: { urlPrefix: 'https://api.example.test/v1' }, value: { type: 'bearer', token: 'synthetic' } }, ctx())).id;
    await db.secret.update({ where: { id }, data: { metadata: { urlPrefix: 'https://api.example.test/v1' } } });
    return id;
  }
  it('refuses a metadata-only edit of an App legacy row: the stored type is unavailable', async () => {
    const id = await legacyRow();
    const err = await error(resolvers.Mutation.updateSecret({}, { ref: id, metadata: { urlPrefix: 'https://api.example.test/v2/' } }, ctx()));
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toBe('Stored webfetch-auth type is unavailable.');
  });
  it('recovers the row on a value rewrite: the type is re-derived from the new value, and a metadata-only edit works after', async () => {
    const id = await legacyRow();
    const recovered = await resolvers.Mutation.updateSecret({}, { ref: id, value: { type: 'basic', username: 'u', password: 'p' } }, ctx());
    expect(recovered.metadata).toEqual({ urlPrefix: 'https://api.example.test/v1', type: 'basic' });
    // "until a value rewrite restores it": the previously refused metadata-only edit now goes through.
    const after = await resolvers.Mutation.updateSecret({}, { ref: id, metadata: { urlPrefix: 'https://api.example.test/v2/' } }, ctx());
    expect(after.metadata).toEqual({ urlPrefix: 'https://api.example.test/v2/', type: 'basic' });
  });
});
