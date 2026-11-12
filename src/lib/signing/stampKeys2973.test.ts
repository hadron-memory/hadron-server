/**
 * #2973 C1 (cor:dmo:130:09 rev 9; Rico §10 conditions #92969, accepted #92972) — the stamp-key registry
 * (`stamp_signing_keys`) and the canonical stamp encoding, pinned at the registry level (the predicate's own tests
 * pin the counting behaviour end to end).
 *
 * The registry is the seed-proof: a row-seeding attacker can copy any static column but cannot produce an HMAC under
 * a key that never leaves the process unencrypted. So the pins here are the ones that make the registry itself
 * unplantable and unbreakable:
 *
 * - PURPOSE BINDING (Rico §1): key material is wrapped with AAD `hadron:stamp-key:v1:<id>` — a ciphertext minted
 *   through any OTHER tokenCrypto use (AAD-less `encryptToken`, another row's AAD) fails its GCM tag and the row is
 *   unusable; exactly 32 bytes of recoverable material or nothing.
 * - LENGTH-PREFIXED CANONICAL INPUT (Rico §4): no two distinct inputs can alias by shifting a field boundary.
 * - ONE ROW PER GENERATION: minting is serialized (advisory lock) and reuses the newest unretired key; a retired key
 *   stays readable for verification forever and never mints again.
 * - ROOT ROTATION RE-WRAPS (Vera 6750118215 §2): rotating HADRON_ENCRYPTION_KEY re-wraps the rows and stamps keep
 *   verifying — the law has no way for a key change to end a signature's counting; the inverse call is the rollback.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { decryptBytesAad, encryptBytesAad, encryptToken, encryptionKeyFromHex } from '../tokenCrypto.js';
import {
  canonicalStampInput, computeStampTag, mintStampSigningKey, rewrapStampSigningKeys,
  StampRegistryUnavailableError, stampKeyAad, stampTagMatches, stampVerificationKey, type StampInput,
} from './stampKeys.js';

const ROOT_A = '0'.repeat(64); // what vitest.config.ts pins as HADRON_ENCRYPTION_KEY
const ROOT_B = 'b'.repeat(64);

const input = (over: Partial<StampInput> = {}): StampInput => ({
  keyId: 1,
  nodeId: 'node-1',
  signingRequestId: 'req-1',
  signerId: 'user-1',
  credentialId: Buffer.alloc(32, 1),
  revision: 3,
  approvalHash: 'a'.repeat(64),
  memoryId: 'mem-1',
  ownerKind: 'AGENT',
  ownerId: 'agent-1',
  ...over,
});

const mint = () => db.$transaction((tx) => mintStampSigningKey(tx));

beforeEach(async () => {
  await cleanDb(db);
  process.env.HADRON_ENCRYPTION_KEY = ROOT_A;
});

describe('#2973 stamp canonical input (length-prefixed, Rico #92969 §4)', () => {
  it('two inputs whose values differ only by a field boundary never share a tag', async () => {
    const key = Buffer.alloc(32, 7);
    // 'ab' + 'c' vs 'a' + 'bc': a NAIVE concatenation is identical; the length prefixes are not.
    const x = input({ nodeId: 'ab', signingRequestId: 'c' });
    const y = input({ nodeId: 'a', signingRequestId: 'bc' });
    expect(canonicalStampInput(x).equals(canonicalStampInput(y))).toBe(false);
    expect(computeStampTag(key, x).equals(computeStampTag(key, y))).toBe(false);
    // The bytes-boundary pair across a string and the credential buffer likewise.
    const p = input({ signerId: 'us', credentialId: Buffer.from('er-1') });
    const q = input({ signerId: 'user', credentialId: Buffer.from('-1') });
    expect(computeStampTag(key, p).equals(computeStampTag(key, q))).toBe(false);
    // The tag is 32 bytes (HMAC-SHA256) and deterministic.
    expect(computeStampTag(key, x).length).toBe(32);
    expect(computeStampTag(key, x).equals(computeStampTag(key, x))).toBe(true);
  });

  it('a tag made under one key does not match under another, and a flipped tag bit never matches', async () => {
    const k1 = Buffer.alloc(32, 1);
    const k2 = Buffer.alloc(32, 2);
    const i = input();
    expect(stampTagMatches(k1, i, computeStampTag(k1, i))).toBe(true);
    expect(stampTagMatches(k2, i, computeStampTag(k1, i))).toBe(false);
    const flipped = Buffer.from(computeStampTag(k1, i));
    flipped[0]! ^= 0xff;
    expect(stampTagMatches(k1, i, flipped)).toBe(false);
    expect(stampTagMatches(k1, i, computeStampTag(k1, i).subarray(0, 31))).toBe(false); // length is part of the shape
  });
});

describe('#2973 the key registry (purpose binding, one row per generation)', () => {
  it('mints the first key lazily, then reuses it; minting twice leaves one row with one id', async () => {
    const first = await mint();
    const second = await mint();
    expect(first.id).toBe(1);
    expect(second.id).toBe(1);
    expect(await db.stampSigningKey.count()).toBe(1);
    expect(first.key.length).toBe(32);
    await expect(stampVerificationKey(db, 1)).resolves.not.toBeNull();
    // The stored material is NOT the raw key: it is wrapped under the env root with the row's AAD.
    const row = await db.stampSigningKey.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.keyMaterial).not.toContain(first.key.toString('base64'));
    expect(decryptBytesAad(row.keyMaterial, stampKeyAad(1)).equals(first.key)).toBe(true);
  });

  it('a retired key never mints again but verifies forever; the next mint is a new id', async () => {
    await mint();
    await db.$executeRaw`UPDATE stamp_signing_keys SET retired_at = public.hadron_signing_now() WHERE id = 1`;
    const second = await mint();
    expect(second.id).toBe(2);
    expect(await db.stampSigningKey.count()).toBe(2);
    expect((await stampVerificationKey(db, 1))!.length).toBe(32); // retained: verification never retires
  });

  it('a planted ciphertext from another tokenCrypto use is unusable (the AAD binds purpose and id)', async () => {
    const { key } = await mint();
    const i = input({ keyId: 1 });
    const tag = computeStampTag(key, i);
    await db.$executeRaw`UPDATE stamp_signing_keys SET key_material = ${encryptToken('attacker chosen plaintext')} WHERE id = 1`;
    await expect(stampVerificationKey(db, 1)).resolves.toBeNull();
    // Even 32 honest random bytes wrapped for ANOTHER row's AAD fail this row's tag.
    await db.$executeRaw`UPDATE stamp_signing_keys SET key_material = ${encryptBytesAad(Buffer.alloc(32, 9), stampKeyAad(2))} WHERE id = 1`;
    await expect(stampVerificationKey(db, 1)).resolves.toBeNull();
    // And the raw key itself, wrapped with the RIGHT aad, verifies: the planted rows above are what fail.
    await db.$executeRaw`UPDATE stamp_signing_keys SET key_material = ${encryptBytesAad(key, stampKeyAad(1))} WHERE id = 1`;
    const restored = await stampVerificationKey(db, 1);
    expect(restored).not.toBeNull();
    expect(stampTagMatches(restored!, i, tag)).toBe(true);
  });

  it('an unknown key id resolves to null, and a recoverable-but-wrong-length plaintext is unusable', async () => {
    await expect(stampVerificationKey(db, 999)).resolves.toBeNull();
    await mint();
    // A row whose material decrypts (right AAD) but is not exactly 32 bytes: unusable, fail closed.
    await db.$executeRaw`UPDATE stamp_signing_keys SET key_material = ${encryptBytesAad(Buffer.alloc(31, 5), stampKeyAad(1))} WHERE id = 1`;
    await expect(stampVerificationKey(db, 1)).resolves.toBeNull();
  });
});

describe('#2973 root rotation (recovery evidence — re-wrap, never invalidate)', () => {
  it('re-wraps every row under the new root and stamps verify identically; the inverse call is the rollback', async () => {
    const { key, id } = await mint();
    const i = input({ keyId: id });
    const tag = computeStampTag(key, i);
    const before = (await db.stampSigningKey.findUniqueOrThrow({ where: { id } })).keyMaterial;

    const out = await rewrapStampSigningKeys(db, ROOT_A, ROOT_B);
    expect(out).toEqual({ rows: 1, rewrapped: 1 });
    const after = (await db.stampSigningKey.findUniqueOrThrow({ where: { id } })).keyMaterial;
    expect(after).not.toBe(before); // genuinely re-wrapped...
    expect(() => decryptBytesAad(after, stampKeyAad(id))).toThrow(); // ...not under the OLD root anymore (sync throw)

    process.env.HADRON_ENCRYPTION_KEY = ROOT_B;
    try {
      const rotated = await stampVerificationKey(db, id);
      expect(rotated).not.toBeNull();
      expect(stampTagMatches(rotated!, i, tag)).toBe(true); // the stamp still verifies: keys are retained, not rotated away

      expect(await rewrapStampSigningKeys(db, ROOT_B, ROOT_A)).toEqual({ rows: 1, rewrapped: 1 }); // the rollback
    } finally {
      process.env.HADRON_ENCRYPTION_KEY = ROOT_A;
    }
    const back = await stampVerificationKey(db, id);
    expect(back).not.toBeNull();
    expect(stampTagMatches(back!, i, tag)).toBe(true);
  });

  it('a re-run after success is a no-op (try-to-first idempotency: nothing re-wrapped, bytes unchanged)', async () => {
    await mint();
    await rewrapStampSigningKeys(db, ROOT_A, ROOT_B);
    const settled = (await db.stampSigningKey.findUniqueOrThrow({ where: { id: 1 } })).keyMaterial;
    expect(await rewrapStampSigningKeys(db, ROOT_A, ROOT_B)).toEqual({ rows: 1, rewrapped: 0 });
    expect((await db.stampSigningKey.findUniqueOrThrow({ where: { id: 1 } })).keyMaterial).toBe(settled);
  });

  it('D1 malformed-later-row: the call aborts BEFORE any write, every row still under the old root; repair, retry, all under the new root', async () => {
    // Three generations: 1 and 3 honest, 2 shape-valid but not 32 bytes (Anne's probe shape).
    const g1 = await mint();
    await db.$executeRaw`UPDATE stamp_signing_keys SET retired_at = public.hadron_signing_now() WHERE id = 1`;
    await mint(); // id 2, then corrupt it
    await db.$executeRaw`UPDATE stamp_signing_keys SET key_material = ${encryptBytesAad(Buffer.alloc(31, 5), stampKeyAad(2), Buffer.from(ROOT_A, 'hex'))} WHERE id = 2`;
    await db.$executeRaw`UPDATE stamp_signing_keys SET retired_at = public.hadron_signing_now() WHERE id = 2`;
    const g3 = await mint();
    expect(g3.id).toBe(3);
    const at1 = (await db.stampSigningKey.findUniqueOrThrow({ where: { id: 1 } })).keyMaterial;

    await expect(rewrapStampSigningKeys(db, ROOT_A, ROOT_B)).rejects.toBeInstanceOf(StampRegistryUnavailableError);
    // Rollback proven by the rows: 1 and 3 are byte-identical and STILL decrypt under the old root.
    expect((await db.stampSigningKey.findUniqueOrThrow({ where: { id: 1 } })).keyMaterial).toBe(at1);
    expect(decryptBytesAad(at1, stampKeyAad(1), Buffer.from(ROOT_A, 'hex')).equals(g1.key)).toBe(true);
    expect(decryptBytesAad((await db.stampSigningKey.findUniqueOrThrow({ where: { id: 3 } })).keyMaterial, stampKeyAad(3), Buffer.from(ROOT_A, 'hex')).equals(g3.key)).toBe(true);

    // Repair row 2 with honest material under the old root; the retry converts the WHOLE registry.
    const g2key = Buffer.alloc(32, 2);
    await db.$executeRaw`UPDATE stamp_signing_keys SET key_material = ${encryptBytesAad(g2key, stampKeyAad(2), Buffer.from(ROOT_A, 'hex'))} WHERE id = 2`;
    expect(await rewrapStampSigningKeys(db, ROOT_A, ROOT_B)).toEqual({ rows: 3, rewrapped: 3 });
    for (const [id, key] of [[1, g1.key], [2, g2key], [3, g3.key]] as const) {
      const material = (await db.stampSigningKey.findUniqueOrThrow({ where: { id } })).keyMaterial;
      expect(decryptBytesAad(material, stampKeyAad(id), Buffer.from(ROOT_B, 'hex')).equals(key)).toBe(true);
    }
  });

  it('D1 later-write-failure: a DB update that fails mid-loop rolls every earlier write back; the retry succeeds', async () => {
    await mint();
    await db.$executeRaw`UPDATE stamp_signing_keys SET retired_at = public.hadron_signing_now() WHERE id = 1`;
    await mint(); // id 2 — registry of two rows, both to be re-wrapped
    const at1 = (await db.stampSigningKey.findUniqueOrThrow({ where: { id: 1 } })).keyMaterial;

    // A client whose SECOND update throws: row 1's write succeeds inside the transaction, row 2's fails.
    let updates = 0;
    const failing = db.$extends({
      query: {
        stampSigningKey: {
          async update({ args, query }) {
            if (++updates === 2) throw new Error('injected write failure');
            return query(args);
          },
        },
      },
    });
    await expect(rewrapStampSigningKeys(failing as unknown as typeof db, ROOT_A, ROOT_B)).rejects.toThrow('injected write failure');
    // Rollback proven: row 1 is byte-identical and still under the old root — the earlier write did not survive.
    expect((await db.stampSigningKey.findUniqueOrThrow({ where: { id: 1 } })).keyMaterial).toBe(at1);
    expect(() => decryptBytesAad(at1, stampKeyAad(1), Buffer.from(ROOT_A, 'hex'))).not.toThrow();

    // The retry (healthy client) converts both rows.
    expect(await rewrapStampSigningKeys(db, ROOT_A, ROOT_B)).toEqual({ rows: 2, rewrapped: 2 });
    for (const id of [1, 2]) {
      const material = (await db.stampSigningKey.findUniqueOrThrow({ where: { id } })).keyMaterial;
      expect(() => decryptBytesAad(material, stampKeyAad(id), Buffer.from(ROOT_B, 'hex'))).not.toThrow();
    }
  });

  it('a row under neither root aborts the whole call with the typed error naming it (planted material is never carried)', async () => {
    await mint();
    await db.$executeRaw`UPDATE stamp_signing_keys SET key_material = ${encryptToken('planted')} WHERE id = 1`;
    await expect(rewrapStampSigningKeys(db, ROOT_A, ROOT_B)).rejects.toThrow(/stamp key 1/);
  });
});

describe('rewrap serializes against a first mint holding the mint lock (Rico, delta review of f44e2c6a)', () => {
  // The concurrent-first-mint pin the gate required (Xylon #93367): M1 (drop the rewrap's advisory lock) is RED
  // here — without the lock the rewrap's snapshot can miss the creation that commits while it would have waited,
  // leaving the new row stranded under the retired root (rewrapped=0 instead of 1).
  it('a creation committed while the rewrap waits is rewrapped, never stranded under the old root', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const haveLock = new Promise<void>((r) => (locked = r));
    // The mint's creation leg, held open: lock, insert under the OLD root, wait, commit.
    const mintTx = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hadron:stamp-signing-key-mint'))`;
      await tx.stampSigningKey.create({ data: { id: 1, keyMaterial: encryptBytesAad(Buffer.alloc(32, 7), stampKeyAad(1)) } });
      locked();
      await gate;
    }, { timeout: 20_000 });
    await haveLock;
    const rewrap = rewrapStampSigningKeys(db, ROOT_A, ROOT_B);
    await new Promise((r) => setTimeout(r, 300)); // the rewrap is now waiting on the lock (or, mutated, already read)
    release();
    await mintTx;
    expect(await rewrap).toEqual({ rows: 1, rewrapped: 1 });
    const row = await db.stampSigningKey.findUniqueOrThrow({ where: { id: 1 } });
    expect(decryptBytesAad(row.keyMaterial, stampKeyAad(1), encryptionKeyFromHex(ROOT_B)).equals(Buffer.alloc(32, 7))).toBe(true);
  }, 30_000);
});
