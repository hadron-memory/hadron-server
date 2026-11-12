/**
 * #3996 (S1 of #3991; R17-R19) — per-App data keys: wrapping, binding, the cache and the root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { encryptBytesAad } from '../tokenCrypto.js';
import {
  AppKeyCache, SecretKeyUnavailableError, appKeyAad, appKeyCache, ensureAppKey, secretAppKeyCacheTtlMs,
  secretVersionAad, stagedValueAad, startAppKeyCacheSweepLoop, unwrapAppKey, DEFAULT_SECRET_APP_KEY_CACHE_TTL_MS,
} from './appKeys.js';

const ROOT = 'a1'.repeat(32);
const OTHER_ROOT = 'b2'.repeat(32);
let orgId: string;
let appA: string;
let appB: string;
const ensure = (appId: string) => db.$transaction((tx) => ensureAppKey(tx, appId));
const unwrap = (appId: string, v: number) => db.$transaction((tx) => unwrapAppKey(tx, appId, v));
const wrappedOf = async (appId: string, v: number) => (await db.secretAppKey.findUniqueOrThrow({ where: { appId_keyVersion: { appId, keyVersion: v } } })).wrappedKey;
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ extensions: { code: 'SECRET_KEY_UNAVAILABLE' } });

beforeEach(async () => {
  await cleanDb(db);
  process.env.SECRET_ROOT_KEY = ROOT;
  delete process.env.SECRET_APP_KEY_CACHE_TTL_MS;
  appKeyCache.clear();
  const org = await db.organization.create({ data: { id: generateId(), name: 'keys org', urn: 'keys-org.test' } });
  orgId = org.id;
  appA = (await createDbAppWithKey(db, 'keys-a', orgId)).app.id;
  appB = (await createDbAppWithKey(db, 'keys-b', orgId)).app.id;
});
afterEach(() => { delete process.env.SECRET_ROOT_KEY; vi.restoreAllMocks(); vi.useRealTimers(); appKeyCache.clear(); });

describe('wrapping and binding (R19)', () => {
  it('mints version 1 on first need, then reuses it', async () => {
    const first = await ensure(appA);
    expect(first.keyVersion).toBe(1);
    expect((await ensure(appA)).keyVersion).toBe(1);
    expect(await db.secretAppKey.count({ where: { appId: appA } })).toBe(1);
    expect((await unwrap(appA, 1)).encryptionKey.equals(first.encryptionKey)).toBe(true);
  });
  it('stores the key wrapped: the row holds no plaintext key or subkey', async () => {
    const h = await ensure(appA);
    const stored = Buffer.from(await wrappedOf(appA, 1), 'base64');
    expect(stored.length).toBe(12 + 16 + 32);
    expect(stored.includes(h.encryptionKey)).toBe(false);
    expect(stored.includes(h.fingerprintKey)).toBe(false);
  });
  it('a key wrapped for one App fails to unwrap under another App\'s AAD', async () => {
    await ensure(appA);
    await db.secretAppKey.create({ data: { appId: appB, keyVersion: 1, wrappedKey: await wrappedOf(appA, 1) } });
    await refused(unwrap(appB, 1));
  });
  it('a key presented with the AAD of the same App\'s other key version fails to unwrap', async () => {
    await ensure(appA);
    await db.secretAppKey.update({ where: { appId_keyVersion: { appId: appA, keyVersion: 1 } }, data: { retiredAt: new Date() } });
    await db.secretAppKey.create({ data: { appId: appA, keyVersion: 2, wrappedKey: await wrappedOf(appA, 1) } });
    await refused(unwrap(appA, 2));
    expect((await unwrap(appA, 1)).keyVersion).toBe(1);
  });
  it('a plaintext that is not 32 bytes is refused, on unwrap and without minting a second key', async () => {
    for (const len of [16, 31, 33, 64]) {
      await db.secretAppKey.deleteMany({ where: { appId: appA } });
      appKeyCache.clear();
      await db.secretAppKey.create({ data: { appId: appA, keyVersion: 1, wrappedKey: encryptBytesAad(randomBytes(len), appKeyAad(appA, 1), Buffer.from(ROOT, 'hex')) } });
      await refused(unwrap(appA, 1));
      await refused(ensure(appA));
      expect(await db.secretAppKey.count({ where: { appId: appA } })).toBe(1);
    }
  });
  it('a missing row, a tampered ciphertext and a wrong root all refuse with the same fixed text', async () => {
    const msgs = new Set<string>();
    const text = async (p: Promise<unknown>) => { try { await p; } catch (e) { msgs.add((e as Error).message); } };
    await text(unwrap(appA, 1));
    await ensure(appA); appKeyCache.clear();
    const good = await wrappedOf(appA, 1);
    const tampered = Buffer.from(good, 'base64'); tampered[tampered.length - 1] ^= 1;
    await db.secretAppKey.update({ where: { appId_keyVersion: { appId: appA, keyVersion: 1 } }, data: { wrappedKey: tampered.toString('base64') } });
    await text(unwrap(appA, 1));
    await db.secretAppKey.update({ where: { appId_keyVersion: { appId: appA, keyVersion: 1 } }, data: { wrappedKey: good } });
    process.env.SECRET_ROOT_KEY = OTHER_ROOT;
    await text(unwrap(appA, 1));
    expect([...msgs]).toEqual(['App secret keys are unavailable.']);
  });
  it('the AAD helpers name their place and are distinct per use', () => {
    expect(appKeyAad('a1', 2)).toBe('hadron:secret-app-key:v1:a1:2');
    expect(secretVersionAad('s1', 3)).toBe('hadron:secret:v1:s1:3');
    expect(stagedValueAad('r1')).toBe('hadron:secret-staged:v1:r1');
    expect(new Set([appKeyAad('x', 1), secretVersionAad('x', 1), stagedValueAad('x')]).size).toBe(3);
  });
});

describe('one active key (race)', () => {
  it('two racing ensureAppKey calls leave one active key and the same version', async () => {
    const out = await Promise.all([ensure(appA), ensure(appA), ensure(appA), ensure(appA)]);
    expect(new Set(out.map((h) => h.keyVersion))).toEqual(new Set([1]));
    expect(new Set(out.map((h) => h.encryptionKey.toString('hex'))).size).toBe(1);
    expect(await db.secretAppKey.count({ where: { appId: appA, retiredAt: null } })).toBe(1);
    expect(await db.secretAppKey.count({ where: { appId: appA } })).toBe(1);
  });
  it('a creator held open past a second caller\'s start still leaves one active key (the lock, not timing)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = db.$transaction(async (tx) => { const h = await ensureAppKey(tx, appA); await gate; return h; });
    await new Promise((r) => setTimeout(r, 200));
    const second = ensure(appA);
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b.keyVersion).toBe(a.keyVersion);
    expect(b.encryptionKey.equals(a.encryptionKey)).toBe(true);
    expect(await db.secretAppKey.count({ where: { appId: appA } })).toBe(1);
  });
  it('the database refuses a second active key and a malformed row', async () => {
    await ensure(appA);
    await expect(db.secretAppKey.create({ data: { appId: appA, keyVersion: 2, wrappedKey: 'x' } })).rejects.toThrow();
    await expect(db.secretAppKey.create({ data: { appId: appB, keyVersion: 0, wrappedKey: 'x' } })).rejects.toThrow();
    await expect(db.secretAppKey.create({ data: { appId: appB, keyVersion: 1, wrappedKey: '' } })).rejects.toThrow();
  });
  it('after every key is retired the next ensure mints the next version', async () => {
    await ensure(appA);
    await db.secretAppKey.updateMany({ where: { appId: appA }, data: { retiredAt: new Date() } });
    expect((await ensure(appA)).keyVersion).toBe(2);
    expect((await unwrap(appA, 1)).keyVersion).toBe(1);
  });
  it('a key minted in a rolled-back transaction is never served from the cache', async () => {
    let first = '';
    await expect(db.$transaction(async (tx) => {
      const h = await ensureAppKey(tx, appA);
      first = h.encryptionKey.toString('hex');
      await unwrapAppKey(tx, appA, 1);
      await ensureAppKey(tx, appA);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(appKeyCache.size()).toBe(0);
    const second = await ensure(appA);
    expect(second.encryptionKey.toString('hex')).not.toBe(first);
  });
  it('deleting an App deletes its keys', async () => {
    await ensure(appA);
    await db.app.delete({ where: { id: appA } });
    expect(await db.secretAppKey.count({ where: { appId: appA } })).toBe(0);
  });
});

describe('key separation (R17)', () => {
  it('returns distinct subkeys, neither the stored or raw key, and different Apps get different ones', async () => {
    const a = await ensure(appA); const b = await ensure(appB); await unwrap(appA, 1);
    expect(a.encryptionKey.length).toBe(32); expect(a.fingerprintKey.length).toBe(32);
    expect(a.encryptionKey.equals(a.fingerprintKey)).toBe(false);
    expect(a.encryptionKey.equals(b.encryptionKey)).toBe(false);
    const raw = appKeyCache.get(appA, 1)!;
    expect(raw).not.toBeNull();
    for (const sub of [a.encryptionKey, a.fingerprintKey]) expect(sub.equals(raw)).toBe(false);
    expect(Object.keys(a).sort()).toEqual(['appId', 'encryptionKey', 'fingerprintKey', 'keyVersion']);
  });
});

describe('the root (R18)', () => {
  const bad: Array<[string, string | undefined]> = [
    ['unset', undefined], ['empty', ''], ['short hex', 'ab'.repeat(16)], ['long hex', 'ab'.repeat(33)],
    ['not hex', 'zz'.repeat(32)], ['a 32-char passphrase', 'correct horse battery staple!!']];
  it.each(bad)('a root that is %s refuses unwrap and ensure, even for a cached key, and logs nothing sensitive', async (_n, value) => {
    await ensure(appA); await unwrap(appA, 1); // now cached
    const logs: string[] = [];
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.map(String).join(' ')); });
    if (value === undefined) delete process.env.SECRET_ROOT_KEY; else process.env.SECRET_ROOT_KEY = value;
    await refused(unwrap(appA, 1));
    await refused(ensure(appA));
    await refused(ensure(appB));
    expect(await db.secretAppKey.count({ where: { appId: appB } })).toBe(0);
    const all = logs.join('\n');
    for (const secret of [ROOT, value ?? '\u0001', await wrappedOf(appA, 1)]) if (secret.length > 3) expect(all).not.toContain(secret);
  });
  it('the refusal never carries the root, its length or a cause', async () => {
    process.env.SECRET_ROOT_KEY = 'not-the-root-value';
    const err = await unwrap(appA, 1).catch((e) => e);
    expect(err).toBeInstanceOf(SecretKeyUnavailableError);
    expect(JSON.stringify([err.message, err.extensions, err.stack?.split('\n')[0]])).not.toContain('not-the-root-value');
  });
  it('is not HADRON_ENCRYPTION_KEY: that variable alone does not open App secrets', async () => {
    delete process.env.SECRET_ROOT_KEY;
    expect(process.env.HADRON_ENCRYPTION_KEY).toBeTruthy();
    await refused(ensure(appA));
  });
});

describe('the cache', () => {
  it('serves a live entry without reading the row, and use refreshes its clock', async () => {
    const c = new AppKeyCache(); const key = randomBytes(32);
    c.set('a', 1, key, 1000);
    expect(c.get('a', 1, 1000 + DEFAULT_SECRET_APP_KEY_CACHE_TTL_MS - 1)).toBe(key);
    expect(c.get('a', 1, 1000 + 2 * DEFAULT_SECRET_APP_KEY_CACHE_TTL_MS - 2)).toBe(key); // refreshed at the first get
  });
  it('a cached key past its expiry is dropped at use even with no sweep, and its buffer is overwritten', () => {
    const c = new AppKeyCache(); const key = randomBytes(32);
    c.set('a', 1, key, 0);
    expect(c.get('a', 1, DEFAULT_SECRET_APP_KEY_CACHE_TTL_MS)).toBeNull();
    expect(c.size()).toBe(0);
    expect(key.equals(Buffer.alloc(32))).toBe(true);
  });
  it('the sweep drops only expired entries and overwrites them', () => {
    const c = new AppKeyCache(); const old = randomBytes(32), fresh = randomBytes(32);
    c.set('a', 1, old, 0); c.set('b', 1, fresh, DEFAULT_SECRET_APP_KEY_CACHE_TTL_MS);
    expect(c.sweepExpired(DEFAULT_SECRET_APP_KEY_CACHE_TTL_MS + 1)).toBe(1);
    expect(old.equals(Buffer.alloc(32))).toBe(true);
    expect(fresh.equals(Buffer.alloc(32))).toBe(false);
    expect(c.size()).toBe(1);
  });
  it('unwrapAppKey uses the cache: a second unwrap after the row is gone still answers until expiry', async () => {
    await ensure(appA); await unwrap(appA, 1);
    await db.secretAppKey.deleteMany({ where: { appId: appA } });
    expect((await unwrap(appA, 1)).keyVersion).toBe(1);
    appKeyCache.clear();
    await refused(unwrap(appA, 1));
  });
  it('evictApp drops every version of that App only', () => {
    const c = new AppKeyCache(); const k1 = randomBytes(32), k2 = randomBytes(32);
    c.set('a', 1, k1); c.set('a', 2, randomBytes(32)); c.set('b', 1, k2);
    c.evictApp('a');
    expect(c.size()).toBe(1); expect(k1.equals(Buffer.alloc(32))).toBe(true); expect(k2.equals(Buffer.alloc(32))).toBe(false);
  });
  it.each([undefined, '', ' ', '0', '-5', '1.5', 'abc', 'Infinity', '9'.repeat(30)])('TTL setting %j falls back to the default and never disables expiry', (v) => {
    if (v === undefined) delete process.env.SECRET_APP_KEY_CACHE_TTL_MS; else process.env.SECRET_APP_KEY_CACHE_TTL_MS = v;
    expect(secretAppKeyCacheTtlMs()).toBe(DEFAULT_SECRET_APP_KEY_CACHE_TTL_MS);
  });
  it('a valid TTL setting is honoured', () => {
    process.env.SECRET_APP_KEY_CACHE_TTL_MS = '1000';
    const c = new AppKeyCache(); c.set('a', 1, randomBytes(32), 0);
    expect(c.get('a', 1, 999)).not.toBeNull();
    expect(c.get('a', 1, 1998)).not.toBeNull(); // 999 ms since the refresh
    expect(c.get('a', 1, 3000)).toBeNull();
  });
  it('the sweep runs on its own timer, whatever DISABLE_SECRET_SWEEP says', async () => {
    vi.useFakeTimers();
    process.env.DISABLE_SECRET_SWEEP = 'true';
    process.env.SECRET_APP_KEY_CACHE_TTL_MS = '1000';
    const key = randomBytes(32);
    appKeyCache.set('a', 1, key);
    const loop = startAppKeyCacheSweepLoop();
    try {
      await vi.advanceTimersByTimeAsync(3000);
      expect(appKeyCache.size()).toBe(0);
      expect(key.equals(Buffer.alloc(32))).toBe(true);
    } finally { loop.stop(); delete process.env.DISABLE_SECRET_SWEEP; }
  });
  it('the sweep loop is started by the server outside tests, not gated on a DISABLE flag', () => {
    const src = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
    const at = src.indexOf('startAppKeyCacheSweepLoop();');
    expect(at).toBeGreaterThan(0);
    const guard = src.slice(src.lastIndexOf('if (', at), at);
    expect(guard).toContain("process.env.NODE_ENV !== 'test'");
    expect(guard).not.toContain('DISABLE_');
  });
});

describe('operational pins', () => {
  it('the prod snapshot script leaves out secret_app_keys', () => {
    const sh = readFileSync(new URL('../../../scripts/dev-from-prod-snapshot.sh', import.meta.url), 'utf8');
    expect(sh).toMatch(/pg_dump[^\n]*\\\n(?:[^\n]*\\\n)*?\s*--exclude-table='secret_app_keys'/);
  });
  it('the migration and post-push carry the invariants file verbatim', () => {
    const inv = readFileSync(new URL('../../../prisma/secret-app-keys-invariants.sql', import.meta.url), 'utf8');
    const mig = readFileSync(new URL('../../../prisma/migrations/20261112150000_secret_app_keys/migration.sql', import.meta.url), 'utf8');
    const post = readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8');
    expect(mig).toContain(inv);
    expect(post).toContain('\\ir secret-app-keys-invariants.sql');
  });
  it('the CLAUDE.md environment table documents both settings and the unset-root refusal', () => {
    const md = readFileSync(new URL('../../../CLAUDE.md', import.meta.url), 'utf8');
    expect(md).toMatch(/\| `SECRET_ROOT_KEY`[^\n]*SECRET_KEY_UNAVAILABLE/);
    expect(md).toMatch(/\| `SECRET_ROOT_KEY` \/ `SECRET_APP_KEY_CACHE_TTL_MS` \|/);
  });
});
