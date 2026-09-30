/**
 * Spec 041 — caller-held key derivation, verification, request staging.
 * D-2026-07-06-B: the server never persists a key; these tests pin the
 * material that IS stored (salt/params/verifier) and the transient staging.
 */

import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest';
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
import { requestKeyStorage } from './requestKeys.js';

// Interactive-strength scrypt is slow by design; a light cost keeps the
// suite fast while exercising the same code path.
const TEST_KDF = { ...DEFAULT_KDF_PARAMS, N: 1024 };

afterEach(() => sessionKeyCache.clear());

describe('KDF + verifier', () => {
  it('derives deterministically and the verifier round-trips', async () => {
    const salt = generateKdfSalt();
    const a = await deriveDataKeyFromPassphrase('correct horse', salt, TEST_KDF);
    const b = await deriveDataKeyFromPassphrase('correct horse', salt, TEST_KDF);
    expect(a.raw.equals(b.raw)).toBe(true);
    const verifier = makeKeyVerifier(a);
    expect(verifyDataKey(verifier, b)).toBe(true);
    const wrong = await deriveDataKeyFromPassphrase('battery staple', salt, TEST_KDF);
    expect(verifyDataKey(verifier, wrong)).toBe(false);
  });

  it('parseKdfParams rejects malformed / hostile persisted params (PR-514 review)', async () => {
    const { parseKdfParams } = await import('./memoryUnlock.js');
    for (const bad of [
      null,
      { alg: 'scrypt', N: '32768', r: 8, p: 1 }, // string N
      { alg: 'scrypt', N: 2 ** 23, r: 8, p: 1 }, // over cap
      { alg: 'scrypt', N: 12345, r: 8, p: 1 },   // not a power of two
      { alg: 'scrypt', N: 1024, r: 64, p: 1 },   // r over cap
      { alg: 'pbkdf2', N: 1024, r: 8, p: 1 },    // wrong alg
    ]) {
      expect(() => parseKdfParams(bad)).toThrowError(
        expect.objectContaining({ code: 'BAD_UNLOCK_INPUT' }),
      );
    }
    expect(parseKdfParams(TEST_KDF)).toEqual(TEST_KDF);
  });
});

describe('resolveSuppliedKey', () => {
  const salt = generateKdfSalt();
  let key: Awaited<ReturnType<typeof deriveDataKeyFromPassphrase>>;
  let memory: { kdfSalt: string; kdfParams: typeof TEST_KDF; keyVerifier: string };

  beforeAll(async () => {
    key = await deriveDataKeyFromPassphrase('pw', salt, TEST_KDF);
    memory = { kdfSalt: salt, kdfParams: TEST_KDF, keyVerifier: makeKeyVerifier(key) };
  });

  it('accepts the right passphrase, rejects the wrong one as WRONG_KEY', async () => {
    expect((await resolveSuppliedKey(memory, { passphrase: 'pw' })).raw.equals(key.raw)).toBe(true);
    await expect(resolveSuppliedKey(memory, { passphrase: 'nope' })).rejects.toMatchObject({
      code: 'WRONG_KEY',
    });
  });

  it('rejects both / neither inputs and passphrase-without-salt', async () => {
    await expect(resolveSuppliedKey(memory, { dataKey: 'x', passphrase: 'y' })).rejects.toMatchObject(
      { code: 'BAD_UNLOCK_INPUT' },
    );
    await expect(resolveSuppliedKey(memory, {})).rejects.toMatchObject({
      code: 'BAD_UNLOCK_INPUT',
    });
    await expect(
      resolveSuppliedKey({ ...memory, kdfSalt: null }, { passphrase: 'pw' }),
    ).rejects.toMatchObject({ code: 'BAD_UNLOCK_INPUT' });
  });

  it('refuses a pre-041 memory without a verifier even when given its old key', async () => {
    const legacy = { kdfSalt: null, kdfParams: null, keyVerifier: null };
    const raw = generateDataKey();
    await expect(resolveSuppliedKey(legacy, { dataKey: raw.raw.toString('base64') }))
      .rejects.toMatchObject({ code: 'BAD_UNLOCK_INPUT' });
  });
});

describe('stageRequestMemoryKeys', () => {
  let memoryId: string;
  let ownerId: string;
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
    ownerId = user.id;
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

  it('stages a verified key visible ONLY inside the request scope (PR-514 Codex P1)', async () => {
    await requestKeyStorage.run(new Map(), async () => {
      await stageRequestMemoryKeys(db, JSON.stringify([{ memory: memoryId, dataKey: key.raw.toString('base64') }]), ownerId);
      expect(sessionKeyCache.getByMemoryId(memoryId)?.raw.equals(key.raw)).toBe(true);
      // A CONCURRENT request (its own store) sees nothing.
      await requestKeyStorage.run(new Map(), async () => {
        expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
      });
    });
    // Outside every request scope — e.g. after an aborted response — the
    // key is unreachable with no eviction bookkeeping at all.
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });

  it('absent header is a no-op; malformed header is typed', async () => {
    await requestKeyStorage.run(new Map(), async () => {
      await expect(stageRequestMemoryKeys(db, undefined, ownerId)).resolves.toBeUndefined();
      await expect(stageRequestMemoryKeys(db, 'not json', ownerId)).rejects.toBeInstanceOf(
        MemoryUnlockError,
      );
    });
  });

  it('wrong key fails typed and nothing escapes the request scope', async () => {
    const wrong = generateDataKey();
    await requestKeyStorage.run(new Map(), async () => {
      await expect(
        stageRequestMemoryKeys(db, JSON.stringify([{ memory: memoryId, dataKey: wrong.raw.toString('base64') }]), ownerId),
      ).rejects.toMatchObject({ code: 'WRONG_KEY' });
      expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
    });
  });

  it('refuses a verifier-less memory before staging a request key', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { keyVerifier: null } });
    await requestKeyStorage.run(new Map(), async () => {
      await expect(stageRequestMemoryKeys(
        db, JSON.stringify([{ memory: memoryId, dataKey: key.raw.toString('base64') }]), ownerId,
      )).rejects.toMatchObject({ code: 'BAD_UNLOCK_INPUT' });
      expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
    });
  });

  it('a not-encrypted memory rejects NOT_ENCRYPTED', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: false } });
    await requestKeyStorage.run(new Map(), async () => {
      await expect(
        stageRequestMemoryKeys(db, JSON.stringify([{ memory: memoryId, dataKey: key.raw.toString('base64') }]), ownerId),
      ).rejects.toMatchObject({ code: 'NOT_ENCRYPTED' });
    });
  });

  it('requires an authenticated user and refuses unowned refs with a uniform NOT_FOUND (PR-514 Copilot)', async () => {
    await requestKeyStorage.run(new Map(), async () => {
      const header = JSON.stringify([{ memory: memoryId, dataKey: key.raw.toString('base64') }]);
      await expect(stageRequestMemoryKeys(db, header, null)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      // A different authenticated user gets NOT_FOUND — no existence,
      // encryption-state, or key oracle for memories they don't own.
      const other = await db.user.create({
        data: { githubId: 9602, githubUsername: 'unlock-other', roles: ['READER'] },
      });
      await expect(stageRequestMemoryKeys(db, header, other.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      // Nonexistent ref: the SAME error shape.
      await expect(
        stageRequestMemoryKeys(
          db,
          JSON.stringify([{ memory: generateId(), dataKey: key.raw.toString('base64') }]),
          ownerId,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('caps entries per header (PR-514 Copilot)', async () => {
    await requestKeyStorage.run(new Map(), async () => {
      const many = Array.from({ length: 9 }, () => ({ memory: memoryId, passphrase: 'x' }));
      await expect(
        stageRequestMemoryKeys(db, JSON.stringify(many), ownerId),
      ).rejects.toMatchObject({ code: 'BAD_UNLOCK_INPUT' });
    });
  });

  it('session-lived keys in the global cache still resolve outside any request scope', () => {
    sessionKeyCache.set('sess-1', memoryId, key);
    expect(sessionKeyCache.getByMemoryId(memoryId)?.raw.equals(key.raw)).toBe(true);
    sessionKeyCache.evict('sess-1');
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });
});
