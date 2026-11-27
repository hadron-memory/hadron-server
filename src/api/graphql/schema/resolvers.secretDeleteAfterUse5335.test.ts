/**
 * #5335 (cor:sec:060:03 arming rule, Decided #5217 Q6 "B"; cor:sec:070:01 auto-delete exception refused; cor:sec:070:02 edge):
 * a read client's auto-delete mark deletes a PROTECTED App secret only once the secret carries the option `deleteAfterUse`.
 * The mark stays the trigger; the option is the consent. Real passkey signing and ceremonies against a private test database.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { CeremonyRefused } from '../../../lib/signing/signingCeremony.js';
import { openSecretProof, proveSecretChange, completeSecretChange } from '../../../lib/secrets/changeCeremony.js';
import { secretSweepTick } from '../../../jobs/secretSweep.js';
import { changeSnapshot } from '../../../lib/secrets/changeRequests.js';
import { RUN_CLIENT_PREFIX } from '../../../lib/auth/runPrincipal.js';
import { resolvers, type Context } from './resolvers.js';

const RP = 'example.test', ORIGIN = 'https://sign.example.test';
let ownerId: string, appId: string, secretId: string, workerId: string;
const key = softPasskey();
let counter = 1;
const ctx = (over: Partial<Context> = {}): Context => ({ db, userId: ownerId, roles: [], ...over } as Context);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const reveal = (clientId: string) => runAsActor({ workerId, agentId: null }, () => resolvers.Mutation.revealSecret({}, { clientId }, ctx()));
const failure = (p: Promise<unknown>) => p.then(() => 'OK', e => e.extensions?.code ?? e.code ?? String(e));
const exists = () => db.secret.count({ where: { id: secretId } });
const assertion = (challenge: string) => key.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(challenge, 'base64url'), origin: ORIGIN, rpId: RP, counter: counter++ });

beforeEach(async () => {
  vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32));
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('PASSKEY_RP_ID', RP);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  await cleanDb(db); await upsertPlatformActions(db);
  counter = 1;
  ownerId = (await db.user.create({ data: { handle: `dau-${generateId()}` } })).id;
  appId = (await db.app.create({ data: { name: 'DAU', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}.test:dau` } })).id;
  const agent = await db.agent.create({ data: { ownerUserId: ownerId, name: 'DAU', urn: `${generateId().toLowerCase()}:ag` } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'dau', slug: 'dau' } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'tok', kind: 'generic', value: 'dau-canary' }, ctx())).id;
  await insertSoftPasskey(db, ownerId, key, { rpId: RP });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function sign(grantId: string) {
  const request = await db.$transaction(tx => createGrantSigningRequestInTransaction(tx, grantId, { appId, requester: { userId: ownerId, appId: null, workerId: null, sessionId: null } }));
  const browserNonceHash = hash(generateId());
  const proof = await openGrantProofCeremony(db, { requestId: request.id, browserNonceHash });
  const proved = await proveForGrantSigning(db, { requestId: request.id, ceremonyId: proof.ceremonyId, browserNonceHash, credentialId: key.credentialId,
    assertion: assertion(proof.challenge), rpId: RP, origins: [ORIGIN] });
  if (proved.outcome !== 'open' || !proved.canSign || !proved.sessionNonce) throw new Error('signing proof refused: ' + JSON.stringify(proved));
  const nonce = hash(proved.sessionNonce);
  const challenge = await currentGrantSigningChallenge(db, { requestId: request.id, browserNonceHash: nonce, rpId: RP });
  await completeGrantSigning(db, { requestId: request.id, ceremonyId: challenge.ceremonyId, browserNonceHash: nonce, credentialId: key.credentialId, assertion: assertion(challenge.challenge) });
}
async function dbDeadline(seconds: number): Promise<Date> {
  const [row] = await db.$queryRaw<Array<{ deadline: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') + ${seconds} * interval '1 second' AS deadline`;
  return row.deadline;
}
async function expired(grantId: string) {
  for (let i = 0; i < 600; i++) {
    const [r] = await db.$queryRaw<Array<{ done: boolean }>>`SELECT expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') AS done FROM grants WHERE id = ${grantId}`;
    if (r.done) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('test deadline never passed');
}
const issue = (over: Record<string, unknown> = {}, c: Context = ctx()) => resolvers.Mutation.issueSecretReadClient({}, { input: {
  secretRef: secretId, holderKind: 'WORKER', holderRef: workerId, autoDelete: true, maxReads: 1, reason: 'dau', ...over } } as never, c);
/** A marked client issued and signed on the (then unprotected) secret: the shape every grant made before this gate has. */
async function legacyMarked(mode: 'last-read' | 'window-end') {
  const a = await issue(mode === 'last-read' ? { maxReads: 1 } : { maxReads: null, expiresAt: (await dbDeadline(10)).toISOString() });
  await sign(a.grantId);
  return a;
}
/** Run the requester's own ceremony to completion for a staged request. */
async function completeCeremony(requestId: string) {
  const nonce = generateId();
  const open = await openSecretProof(db, { requestId, browserNonceHash: hash(nonce) });
  const p = await proveSecretChange(db, { requestId, ceremonyId: open.ceremonyId, browserNonceHash: hash(nonce), credentialId: key.credentialId, assertion: assertion(open.challenge) });
  if (p.outcome !== 'change') throw new Error('proof did not open a change: ' + JSON.stringify(p));
  await completeSecretChange(db, { requestId, ceremonyId: p.ceremonyId, browserNonceHash: hash(p.nonce), credentialId: key.credentialId, assertion: assertion(p.challenge) });
}
async function stagedId(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => { throw new Error('a staged refusal was expected'); }, (err: { extensions?: Record<string, unknown> }) => err);
  expect(e).toMatchObject({ extensions: { code: 'SECRET_PROTECTED_NEEDS_PASSKEY', requestId: expect.any(String) } });
  return e.extensions!.requestId as string;
}
const setOption = (deleteAfterUse: boolean, c: Context = ctx()) => resolvers.Mutation.updateSecret({}, { ref: secretId, deleteAfterUse } as never, c);
/** Protect the secret through its own ceremony (the real path), then optionally arm it through the new operation. */
async function protect(armed: boolean) {
  await completeCeremony(await stagedId(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: true }, ctx())));
  if (armed) await completeCeremony(await stagedId(setOption(true)));
  const row = await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { protected: boolean; deleteAfterUse: boolean };
  // Unarmed, only protection is asserted, so the legacy and issuance pins judge behaviour on a schema without the column too.
  expect(row).toMatchObject(armed ? { protected: true, deleteAfterUse: true } : { protected: true });
}

describe('#5335 Ask 1: the protected auto-delete exception is refused at issuance', () => {
  it('a manager marking a protected secret WITHOUT the option is refused SECRET_AUTO_DELETE_NOT_ALLOWED and nothing is staged', async () => {
    await protect(false);
    const before = await db.grant.count();
    expect(await failure(issue({ maxReads: 1 }))).toBe('SECRET_AUTO_DELETE_NOT_ALLOWED');
    expect(await failure(issue({ maxReads: null, expiresAt: (await dbDeadline(60)).toISOString() }))).toBe('SECRET_AUTO_DELETE_NOT_ALLOWED');
    expect(await db.grant.count()).toBe(before);
    expect(await db.secretReadClient.count()).toBe(0);
    // An unmarked client on the same protected secret is unchanged.
    await expect(issue({ autoDelete: false })).resolves.toHaveProperty('clientId');
  });
  it('the generic grant door is refused the same way at signing (the issuer rule), and the grant is never activated', async () => {
    await protect(false);
    const generic = () => db.$transaction(tx => createPendingGrant(tx, { appId, requester: { userId: ownerId, workerId: null, sessionId: null },
      holder: { kind: 'worker', id: workerId }, action: 'secret.reveal', values: { secret: secretId, 'auto-delete': 'delete' },
      maxUses: 1, expiresAt: null, reason: 'generic door', canReadMemory: async () => false }));
    const grantId = await generic();
    // A signing refusal carries no code by design (CeremonyRefused); the issuer gate is the one refusal that records an observation.
    await expect(sign(grantId)).rejects.toBeInstanceOf(CeremonyRefused);
    expect((await db.grantSigningRequest.findFirstOrThrow({ where: { grantId } })).lastRefusedAt).not.toBeNull();
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).activatedAt).toBeNull();
    // Control: the same grant on the armed secret signs, so the refusal above is the arming rule and nothing else.
    await completeCeremony(await stagedId(setOption(true)));
    const armed = await generic();
    await sign(armed);
    expect((await db.grant.findUniqueOrThrow({ where: { id: armed } })).activatedAt).not.toBeNull();
  });
  it('a stranger sees one refusal for a protected, an unprotected and a missing secret (no protection oracle)', async () => {
    const outsider = (await db.user.create({ data: { handle: `outsider-${generateId()}` } })).id;
    const other = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'plain', kind: 'generic', value: 'x' }, ctx())).id;
    await protect(false);
    const answers = [];
    for (const ref of [secretId, other, generateId()]) {
      answers.push(await resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: ref, holderKind: 'WORKER', holderRef: workerId, autoDelete: true, maxReads: 1, reason: 'no' } } as never,
        ctx({ userId: outsider })).then(() => 'OK', (e: { message: string; extensions: Record<string, unknown> }) => JSON.stringify([e.message, e.extensions])));
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain('SECRET_AUTO_DELETE_NOT_ALLOWED');
  });
});

describe('#5335 Ask 1 (Rook P3-1): no protection oracle for a non-person caller either', () => {
  it.each([
    ['worker session', () => ctx({ workerId: 'w' } as never)],
    ['App key', () => ctx({ appKeyId: 'k' } as never)],
    ['impersonation', () => ctx({ impersonation: { adminUserId: 'adm', targetUserId: 'x' } } as never)],
    ['run', () => ctx({ clientId: `${RUN_CLIENT_PREFIX}r1` } as never)],
  ])('a %s gets the same answer for a protected-unarmed secret as for a missing one', async (label, make) => {
    const other = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'plain', kind: 'generic', value: 'x' }, ctx())).id;
    await protect(false);
    const as = <T>(f: () => Promise<T>) => runAsActor({ workerId: label === 'worker session' ? workerId : null, agentId: null }, f);
    const answers = [];
    for (const ref of [secretId, other, generateId()]) {
      answers.push(await as(() => resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: ref, holderKind: 'WORKER', holderRef: workerId,
        autoDelete: true, maxReads: 1, reason: 'no' } } as never, make()))
        .then(() => 'OK', (e: { message: string; extensions: Record<string, unknown> }) => JSON.stringify([e.message, e.extensions])));
    }
    // Protected-unarmed answers exactly as a missing secret. The unprotected one is the control: a caller the issuer rule admits
    // (the App-key context here carries the owner) is issued there, so its answer may differ without telling protection apart.
    expect(answers[0]).not.toBe('OK');
    expect(answers[0]).toBe(answers[2]);
    expect(await db.secretReadClient.count({ where: { secretId } })).toBe(0);
  });
});

describe('#5335 Ask 2: the option arms the existing deletion moments', () => {
  it.each(['last-read', 'window-end'] as const)('protected + deleteAfterUse: a marked client deletes at %s, signed, audited, staged requests cleared', async (mode) => {
    await protect(true);
    const a = await issue(mode === 'last-read' ? { maxReads: 1 } : { maxReads: null, expiresAt: (await dbDeadline(10)).toISOString() });
    await sign(a.grantId);
    const sibling = await issue({ autoDelete: false, maxReads: 5 }); await sign(sibling.grantId);
    const staged = await stagedId(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'staged-uncommitted' }, ctx()));
    if (mode === 'last-read') expect(await reveal(a.clientId)).toMatchObject({ value: JSON.stringify('dau-canary'), readsLeft: 0 });
    else { await expired(a.grantId); await secretSweepTick(db); }
    expect(await exists()).toBe(0);
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(0);
    expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE' } })).toBe(1);
    expect((await db.secretReadClient.findUniqueOrThrow({ where: { id: sibling.clientId } })).endReason).toBe('SECRET_DELETED');
    const [ended] = await db.$queryRaw<Array<{ state: string; cleared: boolean }>>`SELECT state, staged_value_encrypted IS NULL AS cleared FROM secret_change_requests WHERE id=${staged}`;
    expect(ended).toEqual({ state: 'stale', cleared: true });
  }, 30_000);
  it('ruled B is unchanged: a 3-read armed client deletes at its third read, not its first', async () => {
    await protect(true);
    const a = await issue({ maxReads: 3 }); await sign(a.grantId);
    await reveal(a.clientId); await reveal(a.clientId); expect(await exists()).toBe(1);
    await reveal(a.clientId); expect(await exists()).toBe(0);
  });
  it('SECRET_AUTO_DELETE_NEEDS_LIMIT is unchanged on an armed secret', async () => {
    await protect(true);
    expect(await failure(issue({ maxReads: null }))).toBe('SECRET_AUTO_DELETE_NEEDS_LIMIT');
  });
});

describe('#5335 Ask 4: a legacy mark on a protected secret without the option deletes nothing', () => {
  it.each(['last-read', 'window-end'] as const)('legacy marked client, then protected without the option: nothing deletes at %s', async (mode) => {
    const a = await legacyMarked(mode);
    // Protection set after the grant was signed, through the real ceremony: the grant predates the issuance gate.
    await protect(false);
    // The protection ceremony ends a self-issued PERSON client only; a worker's client stays live.
    expect((await db.secretReadClient.findUniqueOrThrow({ where: { id: a.clientId } })).endedAt).toBeNull();
    if (mode === 'last-read') expect(await reveal(a.clientId)).toMatchObject({ readsLeft: 0 });
    else { await expired(a.grantId); await secretSweepTick(db); await secretSweepTick(db); }
    expect(await exists()).toBe(1);
    expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE' } })).toBe(0);
  }, 30_000);
});

describe('#5335 Proposed: clearing the option disarms at deletion time (pinned on its own, so an overruling is a one-line change)', () => {
  it.each(['last-read', 'window-end'] as const)('armed, marked, then the option cleared through the ceremony: nothing deletes at %s', async (mode) => {
    await protect(true);
    const a = await issue(mode === 'last-read' ? { maxReads: 1 } : { maxReads: null, expiresAt: (await dbDeadline(10)).toISOString() });
    await sign(a.grantId);
    await completeCeremony(await stagedId(setOption(false)));
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { deleteAfterUse: boolean }).deleteAfterUse).toBe(false);
    if (mode === 'last-read') await reveal(a.clientId);
    else { await expired(a.grantId); await secretSweepTick(db); }
    expect(await exists()).toBe(1);
  }, 30_000);
});

describe('#5335 Ask 3: who sets the option', () => {
  it('on an unprotected secret it is a plain updateSecret field, accepted, recorded, and changes nothing by itself (the mark governs)', async () => {
    const updated = await setOption(true) as unknown as { deleteAfterUse: boolean };
    expect(updated.deleteAfterUse).toBe(true);
    expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE_AFTER_USE_ON' } })).toBe(1);
    // An unmarked client never deletes, option or not.
    const keep = await issue({ autoDelete: false, maxReads: 1 }); await sign(keep.grantId);
    await reveal(keep.clientId); expect(await exists()).toBe(1);
    // A marked client deletes at its last read, exactly as without the option.
    const del = await issue({ maxReads: 1 }); await sign(del.grantId);
    await reveal(del.clientId); expect(await exists()).toBe(0);
  });
  it('setting the option to the value it already has records nothing', async () => {
    await setOption(false);
    expect(await db.secretEvent.count({ where: { secretId, kind: { in: ['DELETE_AFTER_USE_ON', 'DELETE_AFTER_USE_OFF'] } } })).toBe(0);
  });
  it('is refused on an org or user secret', async () => {
    const own = await resolvers.Mutation.createSecret({}, { ownerType: 'user', name: 'mine', kind: 'generic', value: 'v' }, ctx());
    expect(await failure(resolvers.Mutation.updateSecret({}, { ref: own.id, deleteAfterUse: true } as never, ctx()))).toBe('BAD_USER_INPUT');
  });
  it('on a protected secret it is staged as its own operation and lands only through the requester\'s ceremony, with its event', async () => {
    await protect(false);
    const id = await stagedId(setOption(true));
    const [r] = await db.$queryRaw<Array<{ operation: string }>>`SELECT operation FROM secret_change_requests WHERE id=${id}`;
    expect(r.operation).toBe('SET_DELETE_AFTER_USE');
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { deleteAfterUse: boolean }).deleteAfterUse).toBe(false);
    await completeCeremony(id);
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { deleteAfterUse: boolean }).deleteAfterUse).toBe(true);
    expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE_AFTER_USE_ON', actorUserId: ownerId } })).toBe(1);
    const clear = await stagedId(setOption(false));
    const [c] = await db.$queryRaw<Array<{ operation: string }>>`SELECT operation FROM secret_change_requests WHERE id=${clear}`;
    expect(c.operation).toBe('CLEAR_DELETE_AFTER_USE');
  });
  it('the option cannot ride along with a value or metadata change on a protected secret', async () => {
    await protect(false);
    expect(await failure(resolvers.Mutation.updateSecret({}, { ref: secretId, deleteAfterUse: true, value: 'v2' } as never, ctx()))).toBe('BAD_USER_INPUT');
    expect(await db.secretChangeRequest.count({ where: { secretId, state: 'open' } })).toBe(0);
  });
  it.each([
    ['worker session', () => ctx({ workerId: 'w' } as never)],
    ['App key', () => ctx({ appKeyId: 'k' } as never)],
    ['impersonation', () => ctx({ impersonation: { adminUserId: 'adm', targetUserId: 'x' } } as never)],
    ['run', () => ctx({ clientId: `${RUN_CLIENT_PREFIX}r1` } as never)],
  ])('a %s is refused on a protected secret exactly as for a value change, with nothing staged', async (label, make) => {
    // A worker session passes the shared visibility gate and reaches the staging person check (SECRET_PROTECTED_NEEDS_PASSKEY);
    // an App key, an impersonation and a run are stopped earlier by updateSecret's shared visibility gate (NOT_FOUND), as they are
    // for every other protected change. The option is pinned to the same answer as a value change, never a different one.
    await protect(false);
    const as = <T>(f: () => Promise<T>) => runAsActor({ workerId: label === 'worker session' ? workerId : null, agentId: null }, f);
    const answer = (p: Promise<unknown>) => p.then(() => null, (err: { message: string; extensions?: Record<string, unknown> }) => err);
    const option = await answer(as(() => setOption(true, make())));
    const value = await answer(as(() => resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'v2' }, make())));
    expect(option?.extensions?.code).toBe(label === 'worker session' ? 'SECRET_PROTECTED_NEEDS_PASSKEY' : 'NOT_FOUND');
    expect([option?.message, option?.extensions]).toEqual([value?.message, value?.extensions]);
    expect(option?.extensions?.requestId).toBeUndefined();
    // Asking for the value the option already has is answered the same: the silent no-op is only for a caller staging would admit.
    const already = await answer(as(() => setOption(false, make())));
    expect([already?.message, already?.extensions]).toEqual([value?.message, value?.extensions]);
    expect(await db.secretChangeRequest.count({ where: { secretId, state: 'open' } })).toBe(0);
  });
  it('protected: true together with the option on an UNPROTECTED secret is refused (one change at a time), nothing written', async () => {
    const answer = await resolvers.Mutation.updateSecret({}, { ref: secretId, deleteAfterUse: true, protected: true } as never, ctx())
      .then(() => null, (e: { message: string; extensions?: Record<string, unknown> }) => [e.message, e.extensions?.code]);
    expect(answer).toEqual(['On a protected secret, change deleteAfterUse on its own.', 'BAD_USER_INPUT']);
    expect(await db.secret.findUniqueOrThrow({ where: { id: secretId } })).toMatchObject({ protected: false, deleteAfterUse: false });
    expect(await db.secretChangeRequest.count({ where: { secretId } })).toBe(0);
  });
  it('the option on a user secret is refused by its own rule, even beside a value (the value is not written)', async () => {
    const own = await resolvers.Mutation.createSecret({}, { ownerType: 'user', name: 'mine', kind: 'generic', value: 'v' }, ctx());
    const answer = await resolvers.Mutation.updateSecret({}, { ref: own.id, deleteAfterUse: true, value: 'v2' } as never, ctx())
      .then(() => null, (e: { message: string; extensions?: Record<string, unknown> }) => [e.message, e.extensions?.code]);
    expect(answer).toEqual(['deleteAfterUse is available only for App secrets.', 'BAD_USER_INPUT']);
    expect((await db.secret.findUniqueOrThrow({ where: { id: own.id } })).updatedAt).toEqual(own.updatedAt);
  });
  it('completion judges the deletion authority again: a manager demoted after staging SET_DELETE_AFTER_USE is refused', async () => {
    const mgr = (await db.user.create({ data: { handle: `mgr-${generateId()}` } })).id;
    await db.appMember.create({ data: { appId, userId: mgr, role: 'owner' } });
    const mgrKey = softPasskey(); await insertSoftPasskey(db, mgr, mgrKey, { rpId: RP });
    await protect(false);
    const id = await stagedId(setOption(true, ctx({ userId: mgr })));
    await db.appMember.update({ where: { appId_userId: { appId, userId: mgr } }, data: { role: 'reader' } });
    let n = 1;
    const sig = (c: string) => mgrKey.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(c, 'base64url'), origin: ORIGIN, rpId: RP, counter: n++ });
    const nonce = generateId();
    const open = await openSecretProof(db, { requestId: id, browserNonceHash: hash(nonce) });
    const p = await proveSecretChange(db, { requestId: id, ceremonyId: open.ceremonyId, browserNonceHash: hash(nonce), credentialId: mgrKey.credentialId, assertion: sig(open.challenge) });
    if (p.outcome !== 'change') throw new Error('proof did not open a change');
    await expect(completeSecretChange(db, { requestId: id, ceremonyId: p.ceremonyId, browserNonceHash: hash(p.nonce), credentialId: mgrKey.credentialId, assertion: sig(p.challenge) })).rejects.toThrow();
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { deleteAfterUse: boolean }).deleteAfterUse).toBe(false);
  });
  it('on a protected secret, setting needs the deletion authority (creator or manager); a plain member may only clear', async () => {
    const member = (await db.user.create({ data: { handle: `m-${generateId()}` } })).id;
    await db.appMember.create({ data: { appId, userId: member, role: 'reader' } });
    await protect(true);
    expect(await failure(setOption(true, ctx({ userId: member })))).toBe('OK'); // already on: the silent no-op, nothing staged
    expect(await db.secretChangeRequest.count({ where: { secretId, state: 'open' } })).toBe(0);
    await stagedId(setOption(false, ctx({ userId: member })));
    await db.secret.update({ where: { id: secretId }, data: { deleteAfterUse: false } });
    expect(await failure(setOption(true, ctx({ userId: member })))).toBe('FORBIDDEN');
    expect(await db.secretChangeRequest.count({ where: { secretId, state: 'open', operation: 'SET_DELETE_AFTER_USE' } })).toBe(0);
  });
  it('a stale request (the secret changed after staging) does not land', async () => {
    await protect(false);
    const id = await stagedId(setOption(true));
    await db.secret.update({ where: { id: secretId }, data: { metadata: { moved: true } } });
    expect(await failure(completeCeremony(id))).toBe('SECRET_CHANGE_REQUEST_STALE');
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { deleteAfterUse: boolean }).deleteAfterUse).toBe(false);
  });
  it('on an unprotected secret, clearing records DELETE_AFTER_USE_OFF', async () => {
    await setOption(true);
    const cleared = await setOption(false) as unknown as { deleteAfterUse: boolean };
    expect(cleared.deleteAfterUse).toBe(false);
    expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE_AFTER_USE_OFF' } })).toBe(1);
  });
  it('on an unprotected secret, the option rides along with a value change: both land, one event each, one answer', async () => {
    const updated = await resolvers.Mutation.updateSecret({}, { ref: secretId, deleteAfterUse: true, value: 'dau-canary-2' } as never, ctx()) as unknown as { deleteAfterUse: boolean };
    expect(updated.deleteAfterUse).toBe(true);
    const kinds = (await db.secretEvent.findMany({ where: { secretId, kind: { in: ['DELETE_AFTER_USE_ON', 'VERSION'] } }, orderBy: { at: 'asc' } })).map(e => e.kind);
    expect(kinds.sort()).toEqual(['DELETE_AFTER_USE_ON', 'VERSION']);
    expect(await db.secretVersion.count({ where: { secretId } })).toBe(2);
  });
});

describe('#5335 blind P2: an option set while unprotected does not survive protection', () => {
  async function memberArms() {
    const member = (await db.user.create({ data: { handle: `m-${generateId()}` } })).id;
    await db.appMember.create({ data: { appId, userId: member, role: 'reader' } });
    await setOption(true, ctx({ userId: member }));
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { deleteAfterUse: boolean }).deleteAfterUse).toBe(true);
  }
  const row = async () => await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { protected: boolean; deleteAfterUse: boolean };
  it('SET_PROTECTED clears a member-set option and records DELETE_AFTER_USE_OFF; a mark is then refused', async () => {
    await memberArms();
    await completeCeremony(await stagedId(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: true }, ctx())));
    expect(await row()).toMatchObject({ protected: true, deleteAfterUse: false });
    expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE_AFTER_USE_OFF' } })).toBe(1);
    expect(await failure(issue({ maxReads: 1 }))).toBe('SECRET_AUTO_DELETE_NOT_ALLOWED');
  });
  it('a STORE that turns protection on (updateSecret value + protected) clears it the same way', async () => {
    await memberArms();
    await completeCeremony(await stagedId(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'dau-canary-2', protected: true } as never, ctx())));
    expect(await row()).toMatchObject({ protected: true, deleteAfterUse: false });
    expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE_AFTER_USE_OFF' } })).toBe(1);
  });
  it('a legacy mark signed while a member had armed the unprotected secret deletes nothing once it is protected', async () => {
    await memberArms();
    const a = await legacyMarked('last-read');
    await completeCeremony(await stagedId(resolvers.Mutation.setSecretProtected({}, { ref: secretId, protected: true }, ctx())));
    await reveal(a.clientId).catch(() => undefined);
    expect(await exists()).toBe(1);
  });
  it('a STORE that restates protection on an already-protected, armed secret keeps the option (consent given under protection stands)', async () => {
    await protect(true);
    await completeCeremony(await stagedId(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'dau-canary-2', protected: true } as never, ctx())));
    const [r] = await db.$queryRaw<Array<{ protected_result: boolean | null }>>`SELECT protected_result FROM secret_change_requests WHERE secret_id = ${secretId} AND operation = 'STORE'`;
    expect(r.protected_result).toBe(true); // the completion runs the protection-on block, so only the was-unprotected test keeps the option
    expect(await row()).toMatchObject({ protected: true, deleteAfterUse: true });
    expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE_AFTER_USE_OFF' } })).toBe(0);
  });
  it('the database refuses the option on a non-App row (chk_secret_delete_after_use_app_only)', async () => {
    const own = await resolvers.Mutation.createSecret({}, { ownerType: 'user', name: 'mine', kind: 'generic', value: 'v' }, ctx());
    await expect(db.$executeRaw`UPDATE secrets SET delete_after_use = true WHERE id = ${own.id}`).rejects.toThrow(/chk_secret_delete_after_use_app_only/);
  });
});

describe('#5335 blind at c2e758a2 (Brooks): re-arm, completion membership, and the previous image', () => {
  it('P2-1, by design (cor:sec:060:03 edge: a protected secret with a signed mark is armed by setting the option): a mark that fell due while unarmed deletes at the first sweep after SET_DELETE_AFTER_USE, not before', async () => {
    const a = await legacyMarked('window-end');
    await protect(false);
    await expired(a.grantId);
    await secretSweepTick(db);
    expect(await exists()).toBe(1); // due but unarmed: the sweep skips it
    await completeCeremony(await stagedId(setOption(true)));
    expect(await exists()).toBe(1); // arming itself deletes nothing
    await secretSweepTick(db);
    expect(await exists()).toBe(0);
  }, 30_000);
  it('P2-2: a creator who left the App after staging SET_DELETE_AFTER_USE is refused at completion (still a member)', async () => {
    const creator = (await db.user.create({ data: { handle: `cr-${generateId()}` } })).id;
    await db.appMember.create({ data: { appId, userId: creator, role: 'reader' } });
    const crKey = softPasskey(); await insertSoftPasskey(db, creator, crKey, { rpId: RP });
    await db.secret.update({ where: { id: secretId }, data: { createdBy: creator } });
    await protect(false);
    const id = await stagedId(setOption(true, ctx({ userId: creator }))); // the creator's own authority, not a manager's
    await db.appMember.delete({ where: { appId_userId: { appId, userId: creator } } });
    let n = 1;
    const sig = (c: string) => crKey.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(c, 'base64url'), origin: ORIGIN, rpId: RP, counter: n++ });
    const nonce = generateId();
    await expect((async () => {
      const open = await openSecretProof(db, { requestId: id, browserNonceHash: hash(nonce) });
      const p = await proveSecretChange(db, { requestId: id, ceremonyId: open.ceremonyId, browserNonceHash: hash(nonce), credentialId: crKey.credentialId, assertion: sig(open.challenge) });
      if (p.outcome !== 'change') throw new Error('proof did not open a change');
      await completeSecretChange(db, { requestId: id, ceremonyId: p.ceremonyId, browserNonceHash: hash(p.nonce), credentialId: crKey.credentialId, assertion: sig(p.challenge) });
    })()).rejects.toThrow();
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { deleteAfterUse: boolean }).deleteAfterUse).toBe(false);
  });
  it('P3-8: protected: false beside the option on an unprotected secret keeps the manager gate; a manager gets the plain write', async () => {
    const member = (await db.user.create({ data: { handle: `m-${generateId()}` } })).id;
    await db.appMember.create({ data: { appId, userId: member, role: 'reader' } });
    const both = (c: Context) => resolvers.Mutation.updateSecret({}, { ref: secretId, protected: false, deleteAfterUse: true } as never, c);
    expect(await failure(both(ctx({ userId: member })))).toBe('FORBIDDEN');
    expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE_AFTER_USE_ON' } })).toBe(0);
    await both(ctx());
    expect(await db.secret.findUniqueOrThrow({ where: { id: secretId } })).toMatchObject({ protected: false, deleteAfterUse: true });
    expect(await db.secretChangeRequest.count({ where: { secretId } })).toBe(0);
  });
  it('P2-3: a deleteAfterUse request carries a snapshot the previous image never computes (it ends stale there); a STORE keeps the plain one', async () => {
    await protect(false);
    const plain = async () => {
      const secret = await db.secret.findUniqueOrThrow({ where: { id: secretId } });
      const v = await db.secretVersion.findFirst({ where: { secretId }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
      return changeSnapshot(secret, v?.versionNo ?? 0);
    };
    const set = await stagedId(setOption(true));
    const staged = await db.secretChangeRequest.findUniqueOrThrow({ where: { id: set } });
    expect(staged.snapshot).not.toBe(await plain());
    await completeCeremony(set); // and this image still completes it
    expect((await db.secret.findUniqueOrThrow({ where: { id: secretId } }) as unknown as { deleteAfterUse: boolean }).deleteAfterUse).toBe(true);
    const store = await stagedId(resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'dau-canary-3' } as never, ctx()));
    expect((await db.secretChangeRequest.findUniqueOrThrow({ where: { id: store } })).snapshot).toBe(await plain());
  });
});
