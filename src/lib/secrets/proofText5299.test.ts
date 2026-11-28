/**
 * #5299 item 2: the proof text the ceremony page shows for every kind of staged change, pinned byte for byte BEFORE `proveSecretChange`'s
 * nested ternary is restructured, so the restructure provably changes no text for any case (the item-17 text and the stale-judgment behaviour).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { openSecretProof, proveSecretChange } from './changeCeremony.js';
import { upsertPlatformActions } from '../grants/actions.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const RP = 'localhost', ORIGIN = 'http://localhost:4000';
let userId: string, appId: string, secretId: string;
const key = softPasskey();
const ctx = (): Context => ({ db, userId, roles: [] } as unknown as Context);
const error = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected refusal'); }, (e) => e);
async function proofOf(requestId: string) {
  const nonce = 'browser-nonce-5299';
  const open = await openSecretProof(db, { requestId, browserNonceHash: hash(nonce) });
  return proveSecretChange(db, { requestId, ceremonyId: open.ceremonyId, browserNonceHash: hash(nonce), credentialId: key.credentialId,
    assertion: key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(open.challenge, 'base64url'), origin: ORIGIN, rpId: RP }) });
}
async function textOf(p: Promise<unknown>): Promise<{ change: string; hasMetadata: boolean }> {
  const e = await error(p);
  expect(e.extensions?.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
  const proof = await proofOf(e.extensions.requestId as string);
  if (proof.outcome !== 'change') throw new Error('change expected');
  // one open request per case: the requester's open-request cap is not what this file pins.
  await db.$executeRaw`DELETE FROM secret_change_requests`;
  return { change: proof.summary.change, hasMetadata: 'metadata' in proof.summary };
}
const setProtected = (isProtected: boolean) => db.secret.update({ where: { id: secretId }, data: { protected: isProtected } });
const update = (args: Record<string, unknown>) => resolvers.Mutation.updateSecret({}, { ref: secretId, ...args }, ctx());

beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32)); vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP); vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@s5.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'S5 proof', urn: `${generateId().toLowerCase()}:s5p` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'canary', kind: 'generic', value: 'original' }, ctx())).id;
  await insertSoftPasskey(db, userId, key, { rpId: RP });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('#5299 item 2: the proof text of every staged change, byte for byte', () => {
  it('a protected create', async () => {
    expect(await textOf(resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'born', kind: 'generic', value: 'v', protected: true }, ctx())))
      .toEqual({ change: 'Create a protected secret', hasMetadata: true });
  });
  it('a new version, with and without a protection change', async () => {
    await setProtected(true);
    expect(await textOf(update({ value: 'v2' }))).toEqual({ change: 'Store a new version', hasMetadata: true });
    expect(await textOf(update({ value: 'v3', protected: false }))).toEqual({ change: 'Store a new version and turn protection off', hasMetadata: true });
    await setProtected(false);
    expect(await textOf(update({ value: 'v4', protected: true }))).toEqual({ change: 'Store a new version and turn protection on', hasMetadata: true });
  });
  it('a protection-flag-only change names the flag alone and carries no metadata (item 17)', async () => {
    await setProtected(false);
    expect(await textOf(update({ protected: true }))).toEqual({ change: 'Turn protection on', hasMetadata: false });
    await setProtected(true);
    expect(await textOf(update({ protected: false }))).toEqual({ change: 'Turn protection off', hasMetadata: false });
  });
  it('a metadata update, with and without a protection change', async () => {
    await setProtected(true);
    expect(await textOf(update({ metadata: { note: 'a' } }))).toEqual({ change: 'Update secret metadata', hasMetadata: true });
    expect(await textOf(update({ metadata: { note: 'b' }, protected: false }))).toEqual({ change: 'Update secret metadata and turn protection off', hasMetadata: true });
    await setProtected(false);
    expect(await textOf(update({ metadata: { note: 'c' }, protected: true }))).toEqual({ change: 'Update secret metadata and turn protection on', hasMetadata: true });
  });
  it('a delete, and the two standalone protection operations', async () => {
    await setProtected(true);
    expect(await textOf(resolvers.Mutation.deleteSecret({}, { ref: secretId }, ctx()))).toEqual({ change: 'Delete this secret', hasMetadata: false });
    await setProtected(false);
    expect(await textOf(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: true }, ctx()))).toEqual({ change: 'Turn protection on', hasMetadata: false });
    await setProtected(true);
    expect(await textOf(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: false }, ctx()))).toEqual({ change: 'Turn protection off', hasMetadata: false });
  });
  it('stale judgment (#5331 item 4): a flag-only request whose live metadata changed before the proof reads as a metadata update, with the metadata', async () => {
    await setProtected(false);
    const e = await error(update({ protected: true }));
    expect(e.extensions?.code).toBe('SECRET_PROTECTED_NEEDS_PASSKEY');
    await db.secret.update({ where: { id: secretId }, data: { metadata: { note: 'moved meanwhile' } } });
    const proof = await proofOf(e.extensions.requestId as string);
    if (proof.outcome !== 'change') throw new Error('change expected');
    expect(proof.summary.change).toBe('Update secret metadata and turn protection on');
    expect(proof.summary).toHaveProperty('metadata');
  });
});
