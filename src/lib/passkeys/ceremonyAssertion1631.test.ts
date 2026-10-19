/** #1631 S2a PR1a: the shared owner-bound assertion verifier and its deciding transaction. */
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import { SignatureVerificationError } from '../signing/verify.js';
import { createCeremony, decideCeremonyAssertion, verifyCeremonyAssertion } from './ceremony.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const NONCE = 'c'.repeat(64);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let ownerId: string;
let passkeyId: string;
let key: SoftPasskey;

beforeEach(async () => {
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { handle: 'ceremony-owner', roles: [] } })).id;
  key = softPasskey();
  passkeyId = await insertSoftPasskey(db, ownerId, key);
});

/** A challenge the server issued, and the assertion a browser would answer it with. */
function challenge() {
  const seed = randomBytes(32);
  return { seed, expected: createHash('sha256').update(seed).digest() };
}
const answer = (seed: Buffer, over: Partial<Parameters<SoftPasskey['assert']>[0]> = {}) =>
  key.assert({ payload: seed, origin: ORIGIN, rpId: RP, ...over });
const credential = (counter = 0n) => ({ passkeyId, ownerId, credentialId: key.credentialId, publicKey: key.cosePublicKey, counter });
const verify = (a: ReturnType<typeof answer>, expected: Buffer, over: { rpId?: string; origins?: string[]; counter?: bigint } = {}) =>
  verifyCeremonyAssertion({ assertion: a, credential: credential(over.counter), expectedChallenge: expected, rpId: over.rpId ?? RP, origins: over.origins ?? [ORIGIN] });
/** Verify (outside the write tx) then decide in the caller's tx, passing the verified snapshot. */
const decide = async (ceremonyId: string, over: { browserNonceHash?: string; purpose?: 'SIGN_IN' | 'STEP_UP_ONLY'; counter?: number; snapshot?: Record<string, unknown> } = {}) => {
  const c = issued.get(ceremonyId) ?? challenge();
  const stored = (await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).counter;
  const { snapshot } = await verify(answer(c.seed, { counter: over.counter ?? 1 }), c.expected, { counter: stored });
  return db.$transaction((tx) => decideCeremonyAssertion(tx, {
    ceremonyId, browserNonceHash: over.browserNonceHash ?? NONCE, purpose: over.purpose ?? 'SIGN_IN',
    verified: { ...snapshot, ...over.snapshot },
  }));
};
const issued = new Map<string, ReturnType<typeof challenge>>();
/** Open a ceremony with a server-issued challenge bound to it (decide requires the binding). */
const open = async () => {
  const c = challenge();
  const id = (await db.$transaction((tx) => createCeremony(tx, { purpose: 'SIGN_IN', browserNonceHash: NONCE, ttlSeconds: 300, challengeHash: sha(c.expected) }))).id;
  issued.set(id, c);
  return id;
};

describe('verifyCeremonyAssertion (pure crypto)', () => {
  it('accepts a UV webauthn.get over the issued challenge and returns the counter', async () => {
    const c = challenge();
    expect(await verify(answer(c.seed, { counter: 3 }), c.expected)).toMatchObject({ newCounter: 3, snapshot: { passkeyId, ownerId, priorCounter: 0, newCounter: 3, challengeHash: sha(c.expected) } });
  });

  it.each([
    ['another challenge', () => ({ over: {}, expected: challenge().expected })],
    ['a wrong origin', () => ({ over: { origin: 'https://evil.example' }, expected: undefined })],
    ['a wrong RP ID', () => ({ over: { rpId: 'evil.example' }, expected: undefined })],
    ['no user verification', () => ({ over: { uv: false }, expected: undefined })],
    ['a webauthn.create assertion', () => ({ over: { type: 'webauthn.create' }, expected: undefined })],
  ])('refuses %s with no detail', async (_n, make) => {
    const c = challenge();
    const { over, expected } = make();
    await expect(verify(answer(c.seed, over), expected ?? c.expected)).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it('refuses when no origin is configured instead of accepting any', async () => {
    const c = challenge();
    await expect(verify(answer(c.seed), c.expected, { origins: [] })).rejects.toThrow();
  });
});

describe('decideCeremonyAssertion (deciding transaction)', () => {
  it('consumes the ceremony and names the owner and credential row', async () => {
    const id = await open();
    expect(await decide(id)).toEqual({ ownerId, passkeyId });
    const row = await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } });
    expect(row.counter).toBe(1n);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('is single-use: a replay is the uniform refusal', async () => {
    const id = await open();
    expect(await decide(id)).not.toBeNull();
    expect(await decide(id, { counter: 2 })).toBeNull();
  });

  it('refuses a foreign browser, another purpose and an unknown credential without consuming', async () => {
    const id = await open();
    expect(await decide(id, { browserNonceHash: 'd'.repeat(64) })).toBeNull();
    expect(await decide(id, { purpose: 'STEP_UP_ONLY' })).toBeNull();
    expect(await decide(id, { snapshot: { credentialId: randomBytes(16) } })).toBeNull();
    expect(await decide(id)).not.toBeNull();
  });

  it('refuses a revoked credential and leaves the ceremony unconsumed', async () => {
    const id = await open();
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE id = ${passkeyId}`;
    expect(await decide(id)).toBeNull();
    const [row] = await db.$queryRaw<Array<{ consumed_at: Date | null }>>`SELECT consumed_at FROM passkey_ceremonies WHERE id = ${id}`;
    expect(row.consumed_at).toBeNull();
  });

  it('refuses a counter that does not advance (clone detection): verify throws, and decide refuses a forged snapshot', async () => {
    expect(await decide(await open(), { counter: 5 })).not.toBeNull();
    await expect(decide(await open(), { counter: 5 })).rejects.toBeInstanceOf(SignatureVerificationError);
    await expect(decide(await open(), { counter: 4 })).rejects.toBeInstanceOf(SignatureVerificationError);
    expect(await decide(await open(), { counter: 5, snapshot: { priorCounter: 5, newCounter: 5 } }).catch(() => 'threw')).toBe('threw');
    // The stored counter is 5; a snapshot claiming it advanced to 4 is refused by decide itself.
    const c = challenge();
    const { snapshot } = await verify(answer(c.seed, { counter: 6 }), c.expected, { counter: 5n });
    const forgedId = await open();
    expect(await db.$transaction((tx) => decideCeremonyAssertion(tx, {
      ceremonyId: forgedId, browserNonceHash: NONCE, purpose: 'SIGN_IN', verified: { ...snapshot, newCounter: 4 },
    }))).toBeNull();
    expect(await decide(await open(), { counter: 6 })).not.toBeNull();
  });

  it('exactly one of two concurrent deciders on one ceremony wins', async () => {
    const id = await open();
    const results = await Promise.all([decide(id), decide(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rolls back with the caller: a later refusal leaves the ceremony and counter untouched', async () => {
    const id = await open();
    const c = issued.get(id)!;
    const { snapshot } = await verify(answer(c.seed, { counter: 1 }), c.expected);
    await expect(db.$transaction(async (tx) => {
      expect(await decideCeremonyAssertion(tx, { ceremonyId: id, browserNonceHash: NONCE, purpose: 'SIGN_IN', verified: snapshot })).not.toBeNull();
      throw new Error('refused later');
    })).rejects.toThrow('refused later');
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).counter).toBe(0n);
    expect(await decide(id)).not.toBeNull();
  });

  it('refuses when the locked row no longer matches the verified snapshot (owner, key identity, prior counter)', async () => {
    const other = (await db.user.create({ data: { handle: 'someone-else', roles: [] } })).id;
    expect(await decide(await open(), { snapshot: { ownerId: other } })).toBeNull();
    expect(await decide(await open(), { snapshot: { publicKeyFingerprint: 'e'.repeat(64) } })).toBeNull();
    expect(await decide(await open(), { snapshot: { priorCounter: 9 } })).toBeNull();
    expect(await decide(await open())).not.toBeNull();
  });

  it('refuses a snapshot whose challenge is not the one issued for the ceremony', async () => {
    const id = await open();
    const c = issued.get(id)!;
    const other = challenge();
    const wrong = await verify(answer(other.seed, { counter: 1 }), other.expected);
    expect(await db.$transaction((tx) => decideCeremonyAssertion(tx, { ceremonyId: id, browserNonceHash: NONCE, purpose: 'SIGN_IN', verified: wrong.snapshot }))).toBeNull();
    const right = await verify(answer(c.seed, { counter: 1 }), c.expected);
    expect(await db.$transaction((tx) => decideCeremonyAssertion(tx, { ceremonyId: id, browserNonceHash: NONCE, purpose: 'SIGN_IN', verified: right.snapshot }))).not.toBeNull();
  });

  it('judges expiry at the moment of consuming, not at the caller transaction start (a lock wait can cross it)', async () => {
    const c = challenge();
    // Bound to the challenge that is verified below, so only EXPIRY can make decide refuse.
    const id = (await db.$transaction((tx) => createCeremony(tx, { purpose: 'SIGN_IN', browserNonceHash: NONCE, ttlSeconds: 1, challengeHash: sha(c.expected) }))).id;
    const { snapshot } = await verify(answer(c.seed, { counter: 1 }), c.expected);
    const decided = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT CURRENT_TIMESTAMP`; // the transaction has started, well inside the ceremony's lifetime
      await tx.$executeRaw`SELECT pg_sleep(1.6)`;   // stands in for the anchor/row-lock wait; expiry passes inside the transaction
      return decideCeremonyAssertion(tx, { ceremonyId: id, browserNonceHash: NONCE, purpose: 'SIGN_IN', verified: snapshot });
    });
    expect(decided).toBeNull();
    const [row] = await db.$queryRaw<Array<{ consumed_at: Date | null }>>`SELECT consumed_at FROM passkey_ceremonies WHERE id = ${id}`;
    expect(row.consumed_at).toBeNull();
    expect((await db.passkeyCredential.findUniqueOrThrow({ where: { id: passkeyId } })).counter).toBe(0n);
  });

  it('the table itself refuses a ceremony with no challenge binding (so decide never meets one)', async () => {
    const id = randomBytes(32).toString('base64url');
    await expect(db.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, expires_at)
      VALUES (${id}, 'SIGN_IN', ${NONCE}, (clock_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes')`).rejects.toThrow();
  });

  it('refuses to create a ceremony with no challenge binding', async () => {
    await expect(db.$transaction((tx) => createCeremony(tx, { purpose: 'SIGN_IN', browserNonceHash: NONCE, ttlSeconds: 60 } as never))).rejects.toThrow();
  });

  it('control: the same bound ceremony inside its lifetime is accepted (so the expiry pin refuses for expiry alone)', async () => {
    const c = challenge();
    const id = (await db.$transaction((tx) => createCeremony(tx, { purpose: 'SIGN_IN', browserNonceHash: NONCE, ttlSeconds: 60, challengeHash: sha(c.expected) }))).id;
    const { snapshot } = await verify(answer(c.seed, { counter: 1 }), c.expected);
    expect(await db.$transaction((tx) => decideCeremonyAssertion(tx, { ceremonyId: id, browserNonceHash: NONCE, purpose: 'SIGN_IN', verified: snapshot }))).not.toBeNull();
  });
});
