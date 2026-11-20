/** #4001 S6: real passkey activation, reads and shared sweep against a private test DB. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { createPendingGrant } from '../../../lib/grants/create.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { insertSoftPasskey, softPasskey } from '../../../test/softPasskey.js';
import { createGrantSigningRequestInTransaction } from '../../../lib/signing/grantRequests.js';
import { openGrantProofCeremony, proveForGrantSigning, currentGrantSigningChallenge, completeGrantSigning } from '../../../lib/signing/grantCeremony.js';
import { secretSweepTick } from '../../../jobs/secretSweep.js';
import * as deletion from '../../../lib/secrets/autoDelete.js';
import * as secretValues from '../../../lib/secrets/appSecrets.js';
import { resolvers, type Context } from './resolvers.js';

let ownerId: string, appId: string, secretId: string, workerId: string;
const ctx = (): Context => ({ db, userId: ownerId, roles: [] });
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const reveal = (clientId: string) => runAsActor({ workerId, agentId: null }, () => resolvers.Mutation.revealSecret({}, { clientId }, ctx()));
const failure = (p: Promise<unknown>) => p.then(() => 'OK', e => e.extensions?.code ?? e.code ?? String(e));

beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32));
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', 'example.test');
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', 'https://sign.example.test');
  await cleanDb(db); await upsertPlatformActions(db);
  ownerId = (await db.user.create({ data: { handle: `s6-${generateId()}` } })).id;
  appId = (await db.app.create({ data: { name: 'S6', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}.test:s6` } })).id;
  const agent = await db.agent.create({ data: { ownerUserId: ownerId, name: 'S6', urn: `${generateId().toLowerCase()}:ag` } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 's6', slug: 's6' } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'tok', kind: 'generic', value: 's6-canary' }, ctx())).id;
  await resolvers.Mutation.updateSecret({}, { ref: secretId, value: 's6-latest' }, ctx());
});
afterEach(() => vi.unstubAllEnvs());

/** Generic grant door intentionally used: runtime pins must reach the read on the S3 baseline. No trigger bypass. */
async function client(mark = 'delete', maxUses: number | null = 1, expiresAt: Date | null = null, signed = true) {
  const grantId = await db.$transaction(tx => createPendingGrant(tx, { appId, requester: { userId: ownerId, workerId: null, sessionId: null },
    holder: { kind: 'worker', id: workerId }, action: 'secret.reveal', values: { secret: secretId, 'auto-delete': mark },
    maxUses, expiresAt, reason: 'S6 acceptance', canReadMemory: async () => false }));
  if (signed) await sign(grantId);
  if (!signed) await db.secretReadClient.create({ data: { id: generateId(), appId, grantId, secretId, secretName: 'tok', issuerUserId: ownerId, selfIssued: false } });
  const row = await db.secretReadClient.findUnique({ where: { grantId } });
  return { grantId, clientId: row?.id ?? '' };
}
async function sign(grantId: string) {
    const key = softPasskey(); await insertSoftPasskey(db, ownerId, key, { rpId: 'example.test' });
    const request = await db.$transaction(tx => createGrantSigningRequestInTransaction(tx, grantId, { appId, requester: { userId: ownerId, appId: null, workerId: null, sessionId: null } }));
    const requestId = request.id;
    const browserNonceHash = hash(generateId());
    const proof = await openGrantProofCeremony(db, { requestId, browserNonceHash });
    const assertion = (challenge: string, counter: number) => key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: 'https://sign.example.test', rpId: 'example.test', counter });
    const proved = await proveForGrantSigning(db, { requestId, ceremonyId: proof.ceremonyId, browserNonceHash, credentialId: key.credentialId,
      assertion: assertion(proof.challenge, 1), rpId: 'example.test', origins: ['https://sign.example.test'] });
    if (proved.outcome !== 'open' || !proved.canSign || !proved.sessionNonce) throw new Error('S6 signing proof refused: ' + JSON.stringify(proved));
    const nonce = hash(proved.sessionNonce);
    const challenge = await currentGrantSigningChallenge(db, { requestId, browserNonceHash: nonce, rpId: 'example.test' });
    await completeGrantSigning(db, { requestId, ceremonyId: challenge.ceremonyId, browserNonceHash: nonce, credentialId: key.credentialId, assertion: assertion(challenge.challenge, 2) });
}
const exists = () => db.secret.count({ where: { id: secretId } });
const deletedEvents = () => db.secretEvent.count({ where: { secretId, kind: 'DELETE' } });
async function expired(grantId: string) {
  for (let i = 0; i < 100; i++) {
    const [r] = await db.$queryRaw<Array<{ done: boolean }>>`SELECT expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') AS done FROM grants WHERE id = ${grantId}`;
    if (r.done) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('test deadline never passed');
}

it('admits a bounded mark at the client door and refuses the unbounded mark at both doors before writes', async () => {
  const issue = (maxReads: number | null) => resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: secretId, holderKind: 'WORKER', holderRef: workerId, autoDelete: true, maxReads, reason: 's6' } }, ctx());
  expect(await failure(issue(null))).toBe('SECRET_AUTO_DELETE_NEEDS_LIMIT');
  expect(await failure(client('delete', null))).toBe('SECRET_AUTO_DELETE_NEEDS_LIMIT');
  expect(await db.grant.count()).toBe(0);
  await expect(issue(1)).resolves.toHaveProperty('clientId');
});
it('last read returns latest value, spends once, deletes every version and ends sibling clients; a lost response cannot replay', async () => {
  const a = await client(); const sibling = await client('keep', 5);
  expect(await reveal(a.clientId)).toMatchObject({ value: JSON.stringify('s6-latest'), readsLeft: 0 });
  expect(await exists()).toBe(0);
  expect(await db.secretVersion.count({ where: { secretId } })).toBe(0);
  expect((await db.secretReadClient.findUniqueOrThrow({ where: { id: sibling.clientId } })).endReason).toBe('SECRET_DELETED');
  expect((await db.grant.findUniqueOrThrow({ where: { id: a.grantId } })).useCount).toBe(1);
  expect(await failure(reveal(a.clientId))).toBe('SECRET_DELETED');
  expect(await deletedEvents()).toBe(1);
});
it('non-final marked read and final keep read retain the secret', async () => {
  const a = await client('delete', 2); await reveal(a.clientId); expect(await exists()).toBe(1);
  const b = await client('keep', 1); await reveal(b.clientId); expect(await exists()).toBe(1);
});
it('two last readers produce one value and one deletion', async () => {
  const a = await client();
  const r = await Promise.allSettled([reveal(a.clientId), reveal(a.clientId)]);
  expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  expect(await exists()).toBe(0); expect(await deletedEvents()).toBe(1);
});
it.each(['live', 'revoked', 'departed', 'protected'])('signed %s client deletes at expiry once, across two sweep instances', async ending => {
  const a = await client('delete', null, new Date(Date.now() + 1800));
  if (ending === 'revoked') await db.$executeRaw`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = ${ownerId} WHERE id = ${a.grantId}`;
  if (ending === 'departed') await db.worker.update({ where: { id: workerId }, data: { retiredAt: new Date() } });
  if (ending === 'departed') await db.$executeRaw`UPDATE grants SET holder_departed_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = ${a.grantId}`;
  if (ending === 'protected') await db.$executeRaw`UPDATE secret_read_clients SET ended_at = (clock_timestamp() AT TIME ZONE 'UTC'), end_reason = 'PROTECTED' WHERE id = ${a.clientId}`;
  await secretSweepTick(db); expect(await exists()).toBe(1);
  await expired(a.grantId);
  expect(await failure(reveal(a.clientId))).not.toBe('OK');
  await Promise.all([secretSweepTick(db), secretSweepTick(db)]); await secretSweepTick(db);
  expect(await exists()).toBe(0); expect(await deletedEvents()).toBe(1);
});
it('unsigned pending and unmarked expired grants never delete', async () => {
  const a = await client('delete', null, new Date(Date.now() + 200), false);
  await expired(a.grantId); await secretSweepTick(db); expect(await exists()).toBe(1);
  const b = await client('keep', null, new Date(Date.now() + 1800));
  await expired(b.grantId); await secretSweepTick(db); expect(await exists()).toBe(1);
});

it('failure after decryption rolls back spend, reveal event, deletion and client ends', async () => {
  const a = await client(); const original = secretValues.currentAppSecretValue;
  const fail = vi.spyOn(secretValues, 'currentAppSecretValue').mockImplementation(async (...args) => {
    await original(...args); throw new Error('deliberate failure after decryption');
  });
  try { await expect(reveal(a.clientId)).rejects.toThrow('deliberate failure after decryption'); }
  finally { fail.mockRestore(); }
  expect(await exists()).toBe(1); expect(await db.secretVersion.count({ where: { secretId } })).toBe(2);
  expect((await db.grant.findUniqueOrThrow({ where: { id: a.grantId } })).useCount).toBe(0);
  expect((await db.secretReadClient.findUniqueOrThrow({ where: { id: a.clientId } })).endedAt).toBeNull();
  expect(await db.grantEvent.count({ where: { grantId: a.grantId, action: 'USE' } })).toBe(0);
  expect(await db.secretEvent.count({ where: { secretId, kind: { in: ['REVEAL', 'DELETE'] } } })).toBe(0);
});
it('a signed mark deletes a protected secret without a change request and never reaches a replacement by name', async () => {
  const a = await client();
  await db.secret.update({ where: { id: secretId }, data: { protected: true } });
  await reveal(a.clientId); expect(await exists()).toBe(0);
  const replacement = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'tok', kind: 'generic', value: 'replacement' }, ctx());
  expect(replacement.id).not.toBe(secretId);
  await secretSweepTick(db); expect(await failure(reveal(a.clientId))).toBe('SECRET_DELETED');
  expect(await db.secret.count({ where: { id: replacement.id } })).toBe(1);
});

it('failure after deletion rolls back the deletion, siblings, spend and all success events', async () => {
  const a = await client(); const sibling = await client('keep', 3);
  const original = deletion.deleteLockedAppSecret;
  const fail = vi.spyOn(deletion, 'deleteLockedAppSecret').mockImplementation(async (...args) => {
    await original(...args); throw new Error('deliberate failure after deletion');
  });
  try { await expect(reveal(a.clientId)).rejects.toThrow('deliberate failure after deletion'); }
  finally { fail.mockRestore(); }
  expect(await exists()).toBe(1); expect(await db.secretVersion.count({ where: { secretId } })).toBe(2);
  expect((await db.grant.findUniqueOrThrow({ where: { id: a.grantId } })).useCount).toBe(0);
  expect((await db.secretReadClient.findUniqueOrThrow({ where: { id: sibling.clientId } })).endedAt).toBeNull();
  expect(await deletedEvents()).toBe(0);
});
it('rejects a stranger marking a real or missing secret with the same ruled refusal', async () => {
  const outsider = await db.user.create({ data: { handle: `outsider-${generateId()}` } });
  for (const ref of [secretId, generateId()]) {
    const p = resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: ref, holderKind: 'WORKER', holderRef: workerId, autoDelete: true, maxReads: 1, reason: 'no' } }, { ...ctx(), userId: outsider.id });
    expect(await failure(p)).toBe('SECRET_AUTO_DELETE_NOT_ALLOWED');
  }
  expect(await db.grant.count()).toBe(0);
});

it('rechecks a historical unbounded pending mark at signing without consuming or activating it', async () => {
  const grantId = generateId();
  const constraint = readFileSync(new URL('../../../../prisma/secret-auto-delete-invariants.sql', import.meta.url), 'utf8');
  // Model the old generic door before the new NOT VALID CHECK existed; every signature/activation guard stays enabled.
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DROP CONSTRAINT chk_secret_auto_delete_limit');
    await tx.grant.create({ data: { id: grantId, appId, workerId, requestedByUserId: ownerId,
      action: 'secret.reveal', values: { secret: secretId, 'auto-delete': 'delete' }, reason: 'historical pending mark' } });
    for (const statement of constraint.replace(/^--.*$/gm, '').split(';').map(x => x.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
  });
  await expect(sign(grantId)).rejects.toMatchObject({ code: 'SECRET_AUTO_DELETE_NEEDS_LIMIT' });
  expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).activatedAt).toBeNull();
  expect(await db.grantSignature.count({ where: { grantId } })).toBe(0);
  expect(await db.secretReadClient.count({ where: { grantId } })).toBe(0);
});
