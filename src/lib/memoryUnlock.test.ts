/**
 * Spec 041 — caller-held key derivation, verification, request staging.
 * D-2026-07-06-B: the server never persists a key; these tests pin the
 * material that IS stored (salt/params/verifier) and the transient staging.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { generateDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import {
  deriveDataKeyFromPassphrase,
  generateKdfSalt,
  makeKeyVerifier,
  verifyDataKey,
  resolveSuppliedKey,
  stageRequestMemoryKeys,
  MemoryUnlockError,
  DEFAULT_KDF_PARAMS,
} from './memoryUnlock.js';

// Interactive-strength scrypt is slow by design; a light cost keeps the
// suite fast while exercising the same code path.
const TEST_KDF = { ...DEFAULT_KDF_PARAMS, N: 1024 };

afterEach(() => sessionKeyCache.clear());

describe('KDF + verifier', () => {
  it('derives deterministically and the verifier round-trips', () => {
    const salt = generateKdfSalt();
    const a = deriveDataKeyFromPassphrase('correct horse', salt, TEST_KDF);
    const b = deriveDataKeyFromPassphrase('correct horse', salt, TEST_KDF);
    expect(a.raw.equals(b.raw)).toBe(true);
    const verifier = makeKeyVerifier(a);
    expect(verifyDataKey(verifier, b)).toBe(true);
    const wrong = deriveDataKeyFromPassphrase('battery staple', salt, TEST_KDF);
    expect(verifyDataKey(verifier, wrong)).toBe(false);
  });
});

describe('resolveSuppliedKey', () => {
  const salt = generateKdfSalt();
  const key = deriveDataKeyFromPassphrase('pw', salt, TEST_KDF);
  const memory = { kdfSalt: salt, kdfParams: TEST_KDF, keyVerifier: makeKeyVerifier(key) };

  it('accepts the right passphrase, rejects the wrong one as WRONG_KEY', () => {
    expect(resolveSuppliedKey(memory, { passphrase: 'pw' }).raw.equals(key.raw)).toBe(true);
    expect(() => resolveSuppliedKey(memory, { passphrase: 'nope' })).toThrowError(
      expect.objectContaining({ code: 'WRONG_KEY' }),
    );
  });

  it('rejects both / neither inputs and passphrase-without-salt', () => {
    const both = { dataKey: 'x', passphrase: 'y' };
    expect(() => resolveSuppliedKey(memory, both)).toThrowError(
      expect.objectContaining({ code: 'BAD_UNLOCK_INPUT' }),
    );
    expect(() => resolveSuppliedKey(memory, {})).toThrowError(
      expect.objectContaining({ code: 'BAD_UNLOCK_INPUT' }),
    );
    expect(() =>
      resolveSuppliedKey({ ...memory, kdfSalt: null }, { passphrase: 'pw' }),
    ).toThrowError(expect.objectContaining({ code: 'BAD_UNLOCK_INPUT' }));
  });

  it('a pre-041 memory (no verifier) accepts a raw key as-supplied', () => {
    const legacy = { kdfSalt: null, kdfParams: null, keyVerifier: null };
    const raw = generateDataKey();
    const resolved = resolveSuppliedKey(legacy, { dataKey: raw.raw.toString('base64') });
    expect(resolved.raw.equals(raw.raw)).toBe(true);
  });
});

describe('stageRequestMemoryKeys', () => {
  let memoryId: string;
  const key = generateDataKey();

  beforeEach(async () => {
    await cleanDb(db);
    sessionKeyCache.clear();
    const org = await db.organization.create({
      data: { id: generateId(), name: 'unlock-org', urn: 'unlock-org' },
    });
    const user = await db.user.create({
      data: { githubId: 9601, githubUsername: 'unlock-user', roles: ['READER'] },
    });
    const memory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'vault',
        urn: 'unlock-org:vault',
        class: 'private',
        userId: user.id,
        isEncrypted: true,
        keyVerifier: makeKeyVerifier(key),
      },
    });
    memoryId = memory.id;
  });

  it('stages a verified key under a request session and the evict releases it', async () => {
    const evict = await stageRequestMemoryKeys(
      db,
      JSON.stringify([{ memory: memoryId, dataKey: key.raw.toString('base64') }]),
    );
    expect(evict).not.toBeNull();
    expect(sessionKeyCache.getByMemoryId(memoryId)?.raw.equals(key.raw)).toBe(true);
    evict!();
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });

  it('absent header is a no-op; malformed header is typed', async () => {
    expect(await stageRequestMemoryKeys(db, undefined)).toBeNull();
    await expect(stageRequestMemoryKeys(db, 'not json')).rejects.toBeInstanceOf(MemoryUnlockError);
  });

  it('wrong key fails typed and leaves nothing staged', async () => {
    const wrong = generateDataKey();
    await expect(
      stageRequestMemoryKeys(
        db,
        JSON.stringify([{ memory: memoryId, dataKey: wrong.raw.toString('base64') }]),
      ),
    ).rejects.toMatchObject({ code: 'WRONG_KEY' });
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });

  it('a not-encrypted memory rejects NOT_ENCRYPTED', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false } });
    await expect(
      stageRequestMemoryKeys(
        db,
        JSON.stringify([{ memory: memoryId, dataKey: key.raw.toString('base64') }]),
      ),
    ).rejects.toMatchObject({ code: 'NOT_ENCRYPTED' });
  });
});
