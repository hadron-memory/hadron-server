/**
 * #4003 (S8 of #3991; R17, R18, R21) — App key rotation and the root re-wrap, the parts that need only S1's
 * `secret_app_keys`. The version-level rows (re-encrypt, a key a version still uses) are pinned beside S2's tables.
 *
 * - `rotateAppKey` mints key n+1 and retires n in one transaction; retired keys still unwrap.
 * - FIT delta 2 — an old-root instance fails closed: the database holds a key-check value of the active root, and a
 *   mint (first key or rotation) under any other root refuses `SECRET_KEY_UNAVAILABLE` and writes nothing.
 * - `rewrapSecretRootKeys` moves every wrapped key from the old root to the new one in one transaction, moves the
 *   key-check value with them, is idempotent, and on any row that unwraps under neither root changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { decryptBytesAad, encryptBytesAad } from '../tokenCrypto.js';
import { appKeyAad, appKeyCache, ensureAppKey, unwrapAppKey } from './appKeys.js';
import { rewrapSecretRootKeys, rotateAppKey } from './rotation.js';

const ROOT = 'a1'.repeat(32);
const NEW_ROOT = 'c3'.repeat(32);
const STRANGER = 'd4'.repeat(32);
let appA: string;
let appB: string;

const ensure = (appId: string) => db.$transaction((tx) => ensureAppKey(tx, appId));
const unwrap = (appId: string, v: number) => db.$transaction((tx) => unwrapAppKey(tx, appId, v));
const rotate = (appId: string) => db.$transaction((tx) => rotateAppKey(tx, appId));
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ extensions: { code: 'SECRET_KEY_UNAVAILABLE' } });
const keysOf = (appId: string) => db.secretAppKey.findMany({ where: { appId }, orderBy: { keyVersion: 'asc' } });
const useRoot = (hex: string) => { process.env.SECRET_ROOT_KEY = hex; appKeyCache.clear(); };

beforeEach(async () => {
  await cleanDb(db);
  useRoot(ROOT);
  const org = await db.organization.create({ data: { id: generateId(), name: 'rotation org', urn: 'rotation-org.test' } });
  appA = (await createDbAppWithKey(db, 'rot-a', org.id)).app.id;
  appB = (await createDbAppWithKey(db, 'rot-b', org.id)).app.id;
});
afterEach(() => { delete process.env.SECRET_ROOT_KEY; appKeyCache.clear(); });

describe('rotateAppKey', () => {
  it('mints key n+1, retires n, and new work uses n+1 while n still unwraps', async () => {
    const v1 = await ensure(appA);
    const v2 = await rotate(appA);
    expect(v2.keyVersion).toBe(2);
    expect(v2.encryptionKey.equals(v1.encryptionKey)).toBe(false);
    expect((await ensure(appA)).keyVersion).toBe(2);
    const rows = await keysOf(appA);
    expect(rows.map((r) => [r.keyVersion, r.retiredAt === null])).toEqual([[1, false], [2, true]]);
    appKeyCache.clear();
    expect((await unwrap(appA, 1)).encryptionKey.equals(v1.encryptionKey)).toBe(true);
  });

  it('rotating twice leaves exactly one active key, the newest', async () => {
    await ensure(appA);
    await rotate(appA);
    await rotate(appA);
    const rows = await keysOf(appA);
    expect(rows.map((r) => r.keyVersion)).toEqual([1, 2, 3]);
    expect(rows.filter((r) => r.retiredAt === null).map((r) => r.keyVersion)).toEqual([3]);
  });

  it('two concurrent rotations serialize: no version is skipped and one key stays active', async () => {
    await ensure(appA);
    await Promise.all([rotate(appA), rotate(appA)]);
    const rows = await keysOf(appA);
    expect(rows.map((r) => r.keyVersion)).toEqual([1, 2, 3]);
    expect(rows.filter((r) => r.retiredAt === null)).toHaveLength(1);
  });

  it('touches only the named App', async () => {
    await ensure(appA);
    await ensure(appB);
    await rotate(appA);
    expect((await keysOf(appB)).map((r) => [r.keyVersion, r.retiredAt === null])).toEqual([[1, true]]);
  });

  it('a rotation that rolls back leaves the old key active and no new row', async () => {
    await ensure(appA);
    await expect(db.$transaction(async (tx) => { await rotateAppKey(tx, appA); throw new Error('abort'); })).rejects.toThrow('abort');
    expect((await keysOf(appA)).map((r) => [r.keyVersion, r.retiredAt === null])).toEqual([[1, true]]);
    expect((await ensure(appA)).keyVersion).toBe(1);
  });

  it('refuses an App that does not exist, and writes nothing', async () => {
    await refused(rotate(generateId()));
    expect(await db.secretAppKey.count()).toBe(0);
  });
});

describe('an old-root instance fails closed (FIT delta 2)', () => {
  it('a first mint under a root other than the recorded one refuses and writes no key', async () => {
    await ensure(appA); // records ROOT's check value
    useRoot(STRANGER);
    await refused(ensure(appB));
    expect(await db.secretAppKey.count({ where: { appId: appB } })).toBe(0);
  });

  it('a rotation under a root other than the recorded one refuses and retires nothing', async () => {
    await ensure(appA);
    useRoot(STRANGER);
    await refused(rotate(appA));
    expect((await keysOf(appA)).map((r) => [r.keyVersion, r.retiredAt === null])).toEqual([[1, true]]);
  });

  it('after a re-wrap, an instance still on the OLD root mints nothing', async () => {
    await ensure(appA);
    await rewrapSecretRootKeys(db, ROOT, NEW_ROOT);
    useRoot(ROOT); // the instance nobody restarted
    await refused(ensure(appB));
    await refused(rotate(appA));
    expect(await db.secretAppKey.count({ where: { appId: appB } })).toBe(0);
    useRoot(NEW_ROOT);
    expect((await ensure(appB)).keyVersion).toBe(1);
  });

  it('the first mint on an empty store records the check value of the root it ran under', async () => {
    await ensure(appA);
    useRoot(ROOT);
    expect((await ensure(appB)).keyVersion).toBe(1);
  });
});

describe('rewrapSecretRootKeys (the root re-wrap)', () => {
  it('re-wraps every App key, retired ones too, so every key unwraps under the new root only', async () => {
    const a1 = await ensure(appA);
    const a2 = await rotate(appA);
    const b1 = await ensure(appB);
    const out = await rewrapSecretRootKeys(db, ROOT, NEW_ROOT);
    expect(out).toMatchObject({ rows: 3, rewrapped: 3 });
    useRoot(NEW_ROOT);
    expect((await unwrap(appA, 1)).encryptionKey.equals(a1.encryptionKey)).toBe(true);
    expect((await unwrap(appA, 2)).encryptionKey.equals(a2.encryptionKey)).toBe(true);
    expect((await unwrap(appB, 1)).encryptionKey.equals(b1.encryptionKey)).toBe(true);
    useRoot(ROOT);
    await refused(unwrap(appA, 1));
  });

  it('is idempotent: a re-run after the switch rewraps nothing and still succeeds', async () => {
    await ensure(appA);
    await rewrapSecretRootKeys(db, ROOT, NEW_ROOT);
    expect(await rewrapSecretRootKeys(db, ROOT, NEW_ROOT)).toMatchObject({ rows: 1, rewrapped: 0 });
  });

  it('a row under neither root aborts the whole re-wrap: every key stays readable under the old root', async () => {
    await ensure(appA);
    const before = (await keysOf(appA))[0].wrappedKey;
    await db.secretAppKey.create({
      data: { appId: appB, keyVersion: 1, wrappedKey: encryptBytesAad(Buffer.alloc(32, 7), appKeyAad(appB, 1), Buffer.from(STRANGER, 'hex')) },
    });
    await expect(rewrapSecretRootKeys(db, ROOT, NEW_ROOT)).rejects.toMatchObject({ extensions: { code: 'SECRET_KEY_UNAVAILABLE' } });
    expect((await keysOf(appA))[0].wrappedKey).toBe(before);
    expect(decryptBytesAad(before, appKeyAad(appA, 1), Buffer.from(ROOT, 'hex'))).toHaveLength(32);
    useRoot(ROOT);
    expect((await ensure(appA)).keyVersion).toBe(1); // the check value did not move either
  });

  it('keeps each row bound to its own App and version (the AAD is unchanged)', async () => {
    await ensure(appA);
    await rewrapSecretRootKeys(db, ROOT, NEW_ROOT);
    const wrapped = (await keysOf(appA))[0].wrappedKey;
    expect(() => decryptBytesAad(wrapped, appKeyAad(appB, 1), Buffer.from(NEW_ROOT, 'hex'))).toThrow();
    expect(decryptBytesAad(wrapped, appKeyAad(appA, 1), Buffer.from(NEW_ROOT, 'hex'))).toHaveLength(32);
  });
});
