/**
 * #3996 (S1 of #3991) — per-App data keys for the App secret store.
 *
 * Each App gets a random 32-byte data key, stored wrapped (AES-256-GCM) under a platform root key in
 * `secret_app_keys` (versioned: one active key per App, retired keys still unwrap). This copies the stamp-key
 * registry (`src/lib/signing/stampKeys.ts`): wrapped keys, AAD binding, a transaction-scoped advisory lock for the
 * one creation leg, and fail-closed unwrap.
 *
 * Security shape (plan #3991, R17-R19):
 * - R17 KEY SEPARATION. The raw App key encrypts nothing and is never returned. Callers get SUBKEYS, one per
 *   purpose, derived by HKDF-SHA256 under a fixed label (`encryption`, `fingerprint`).
 * - R18 THE ROOT IS ITS OWN SECRET. `SECRET_ROOT_KEY` is a dedicated 64-hex-character (32-byte) variable, never
 *   `HADRON_ENCRYPTION_KEY`, so a root that opens App secrets is never one a dev or test environment holds. Missing,
 *   malformed or the wrong length refuses every App secret operation with `SECRET_KEY_UNAVAILABLE`; the value, its
 *   length and the reason it was refused are never echoed or logged. Boot does not require it.
 * - R19 EVERY CIPHERTEXT IS BOUND TO ITS PLACE. A wrapped key's AAD names its App and version, so a row copied to
 *   another App's row, or to another version of the same App, fails its GCM tag. The same module owns the AADs for
 *   secret versions and staged values so no caller spells one.
 * - The unwrapped-key cache has its OWN expiry (checked at use, refreshed by use) and its OWN sweep timer, never
 *   behind a sibling `DISABLE_*` flag, and an evicted key's buffer is overwritten (the `SessionKeyCache` pattern).
 *
 * Everything fails closed into one typed refusal with fixed text: the cause (no root, no row, wrong AAD, tampering,
 * not 32 bytes) is the operator's to diagnose from the database, not an oracle for a caller.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { decryptBytesAad, encryptBytesAad } from '../tokenCrypto.js';

/** The dedicated root-key variable (open question 9; R18). 64 hex characters. */
export const SECRET_ROOT_KEY_ENV = 'SECRET_ROOT_KEY';

/** The refusal. Fixed text on purpose: it must not distinguish the causes to a caller. */
export class SecretKeyUnavailableError extends GraphQLError {
  constructor() {
    super('App secret keys are unavailable.', { extensions: { code: 'SECRET_KEY_UNAVAILABLE' } });
    this.name = 'SecretKeyUnavailableError';
  }
}

/** AAD of a wrapped App key: names the App and the key version (R19). */
export const appKeyAad = (appId: string, keyVersion: number): string => `hadron:secret-app-key:v1:${appId}:${keyVersion}`;

/** AAD of a secret version's value: names the secret and the version number (R19). */
export const secretVersionAad = (secretId: string, versionNo: number): string => `hadron:secret:v1:${secretId}:${versionNo}`;

/** AAD of a staged change-request value: a different label from a version, so it is never copied across (R19). */
export const stagedValueAad = (requestId: string): string => `hadron:secret-staged:v1:${requestId}`;

const SUBKEY_LABEL_PREFIX = 'hadron:secret-subkey:v1:';

/** One subkey per purpose (R17). The raw App key is never one of them. */
export type AppKeyPurpose = 'encryption' | 'fingerprint';

/** What a caller holds: the subkeys of one App key version. Use them in place; do not retain them. */
export interface AppKeyHandle {
  appId: string;
  keyVersion: number;
  encryptionKey: Buffer;
  fingerprintKey: Buffer;
}

function deriveSubkey(appKey: Buffer, purpose: AppKeyPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', appKey, Buffer.alloc(0), `${SUBKEY_LABEL_PREFIX}${purpose}`, 32));
}

function handleFor(appId: string, keyVersion: number, appKey: Buffer): AppKeyHandle {
  return {
    appId,
    keyVersion,
    encryptionKey: deriveSubkey(appKey, 'encryption'),
    fingerprintKey: deriveSubkey(appKey, 'fingerprint'),
  };
}

/** The root key from the environment, or the refusal. Read per call so a change needs no restart. */
export function rootKey(): Buffer {
  const raw = process.env[SECRET_ROOT_KEY_ENV];
  if (raw === undefined || !/^[0-9a-fA-F]{64}$/.test(raw)) throw new SecretKeyUnavailableError();
  return Buffer.from(raw, 'hex');
}

/**
 * What a cache entry is bound to: a digest of the root it was unwrapped under. A cached key is served only while
 * the CURRENT root has that digest, so switching to another valid root is a miss (the entry is dropped and the
 * row must unwrap under the new root), and a continuously used App cannot keep a stale entry alive past a
 * rotation. The digest lives in process memory beside the keys it guards and is never logged.
 */
export const rootBinding = (root: Buffer): string => createHash('sha256').update('hadron:secret-root-binding:v1:').update(root).digest('hex');

/** Unwrap with the row's AAD and require exactly 32 bytes, or refuse. */
export function unwrap(root: Buffer, appId: string, keyVersion: number, wrapped: string): Buffer {
  let key: Buffer;
  try {
    key = decryptBytesAad(wrapped, appKeyAad(appId, keyVersion), root);
  } catch {
    throw new SecretKeyUnavailableError();
  }
  if (key.length !== 32) {
    key.fill(0);
    throw new SecretKeyUnavailableError();
  }
  return key;
}

// ── the cache ────────────────────────────────────────────────────────────────

export const DEFAULT_SECRET_APP_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/** `SECRET_APP_KEY_CACHE_TTL_MS`: a positive integer. Anything else (unset, empty, 0, negative, fractional, junk) is the default, so no value can switch expiry off. */
export function secretAppKeyCacheTtlMs(): number {
  const raw = process.env.SECRET_APP_KEY_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    // Decimal digits only: Number() would also accept hex ('0x10') and exponent ('1e3') spellings.
    const n = /^[0-9]+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return DEFAULT_SECRET_APP_KEY_CACHE_TTL_MS;
}

interface CacheEntry {
  key: Buffer;
  lastUsedAt: number;
  /** Digest of the root the key was unwrapped under; see {@link rootBinding}. */
  binding: string;
}

export class AppKeyCache {
  private entries = new Map<string, CacheEntry>();

  private static slot(appId: string, keyVersion: number): string {
    return `${appId}\u0000${keyVersion}`;
  }

  private expired(entry: CacheEntry, now: number): boolean {
    return now - entry.lastUsedAt >= secretAppKeyCacheTtlMs();
  }

  /**
   * A live entry's key (refreshing its clock), or null. An entry past its TTL, or bound to a different root than
   * `binding`, is dropped here, whatever the sweep has done.
   */
  get(appId: string, keyVersion: number, now: number = Date.now(), binding = ''): Buffer | null {
    const slot = AppKeyCache.slot(appId, keyVersion);
    const entry = this.entries.get(slot);
    if (!entry) return null;
    if (entry.binding !== binding || this.expired(entry, now)) {
      this.drop(slot, entry);
      return null;
    }
    entry.lastUsedAt = now;
    return entry.key;
  }

  set(appId: string, keyVersion: number, key: Buffer, now: number = Date.now(), binding = ''): void {
    const slot = AppKeyCache.slot(appId, keyVersion);
    const prior = this.entries.get(slot);
    if (prior && prior.key !== key) prior.key.fill(0);
    this.entries.set(slot, { key, lastUsedAt: now, binding });
  }

  /** Evict every version of one App (its keys were deleted or rotated away). */
  evictApp(appId: string): void {
    for (const [slot, entry] of this.entries) {
      if (slot.startsWith(`${appId}\u0000`)) this.drop(slot, entry);
    }
  }

  /** Drop every entry past its TTL; returns how many. The same predicate as the read path. */
  sweepExpired(now: number = Date.now()): number {
    let n = 0;
    for (const [slot, entry] of this.entries) {
      if (this.expired(entry, now)) {
        this.drop(slot, entry);
        n++;
      }
    }
    return n;
  }

  clear(): void {
    for (const [slot, entry] of this.entries) this.drop(slot, entry);
  }

  size(): number {
    return this.entries.size;
  }

  private drop(slot: string, entry: CacheEntry): void {
    entry.key.fill(0); // overwrite, do not merely unreference (R17)
    this.entries.delete(slot);
  }
}

export const appKeyCache = new AppKeyCache();

export interface AppKeySweepLoop {
  stop: () => void;
}

/**
 * The cache's sweep, on its OWN unref'd timer: not the secret sweep's, so `DISABLE_SECRET_SWEEP` cannot leave
 * expired key material resident (the `SESSION_KEY_CACHE_TTL_MS` independence, #1120). Cadence follows the TTL.
 */
export function startAppKeyCacheSweepLoop(intervalMs?: number): AppKeySweepLoop {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const cadence = () => intervalMs ?? Math.min(60_000, Math.max(1000, Math.floor(secretAppKeyCacheTtlMs() / 2)));
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      appKeyCache.sweepExpired();
      schedule();
    }, cadence());
    timer.unref?.();
  };
  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// ── operations ───────────────────────────────────────────────────────────────

/**
 * Keys this transaction created and has not committed. Such a key must not enter the process-wide cache: if the
 * transaction rolled back, the cache would serve a key no row holds, and a later creation of the same (App, version)
 * by this or another instance would be encrypted under a different one. A WeakMap on the client object, so nothing
 * outlives the transaction.
 */
const uncommitted = new WeakMap<object, Set<string>>();
const slotKey = (appId: string, keyVersion: number) => `${appId}\u0000${keyVersion}`;

/**
 * The subkeys of one App key version: from the cache while its entry is live, else unwrapped from the row under
 * the AAD naming its App and version and cached. Refuses (`SECRET_KEY_UNAVAILABLE`) when the root is missing or
 * malformed (checked FIRST, so a cached key does not outlive the root), the row is absent, the AAD does not match,
 * or the plaintext is not 32 bytes.
 */
export async function unwrapAppKey(
  db: Prisma.TransactionClient,
  appId: string,
  keyVersion: number,
): Promise<AppKeyHandle> {
  const root = rootKey();
  const binding = rootBinding(root);
  const cached = appKeyCache.get(appId, keyVersion, Date.now(), binding);
  if (cached) return handleFor(appId, keyVersion, cached);
  const row = await db.secretAppKey.findUnique({
    where: { appId_keyVersion: { appId, keyVersion } },
    select: { wrappedKey: true },
  });
  if (!row) throw new SecretKeyUnavailableError();
  const key = unwrap(root, appId, keyVersion, row.wrappedKey);
  if (uncommitted.get(db)?.has(slotKey(appId, keyVersion))) {
    const handle = handleFor(appId, keyVersion, key);
    key.fill(0);
    return handle;
  }
  appKeyCache.set(appId, keyVersion, key, Date.now(), binding);
  return handleFor(appId, keyVersion, key);
}

/**
 * The App's active key, minting version 1 (or n+1 after every earlier version was retired) when none is active.
 * The common path takes no lock; creation is serialized by a transaction-scoped advisory lock per App, and the
 * loser re-reads under it and returns the winner's key, so two racing callers leave one active key. The partial
 * unique index `(app_id) WHERE retired_at IS NULL` is the backstop (a P2002 on create re-reads the winner). Call it
 * INSIDE a transaction: the advisory lock is transaction-scoped. The App must exist (a missing one refuses with
 * `SECRET_KEY_UNAVAILABLE`). An active key that does not unwrap refuses; it never mints a second one beside it.
 */
export async function ensureAppKey(db: Prisma.TransactionClient, appId: string): Promise<AppKeyHandle> {
  const root = rootKey();
  const active = () => db.secretAppKey.findFirst({
    where: { appId, retiredAt: null },
    orderBy: { keyVersion: 'desc' },
    select: { keyVersion: true },
  });
  let row = await active();
  if (row) return unwrapAppKey(db, appId, row.keyVersion);
  await lockAppKeyMint(db, appId);
  row = await active();
  if (row) return unwrapAppKey(db, appId, row.keyVersion);
  // #4003 FIT delta 2: an instance whose root is not the recorded one mints nothing (checked under the lock).
  await assertRootCheck(db, root);
  // The App must exist: refuse with the typed error rather than leak a raw foreign-key failure (and mint nothing).
  if (!(await db.app.findUnique({ where: { id: appId }, select: { id: true } }))) throw new SecretKeyUnavailableError();
  const newest = await db.secretAppKey.findFirst({ where: { appId }, orderBy: { keyVersion: 'desc' }, select: { keyVersion: true } });
  try {
    return await mintAppKeyVersion(db, appId, (newest?.keyVersion ?? 0) + 1, root);
  } catch (err) {
    // The partial unique index is the backstop when the advisory lock did not serialize (a caller outside a
    // transaction releases it at once). Re-read once: the winner's key is the answer, not a raw P2002.
    if ((err as { code?: string }).code === 'P2002') {
      const winner = await active();
      if (winner) return unwrapAppKey(db, appId, winner.keyVersion);
    }
    throw err;
  }
}

/**
 * Take the locks every key-creating leg holds, in one fixed order: the secrets-root lock SHARED (so a root re-wrap,
 * which takes it exclusively, never interleaves with a mint), then the per-App mint lock. Both are
 * transaction-scoped: call inside a transaction.
 */
export async function lockAppKeyMint(db: Prisma.TransactionClient, appId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${SECRET_ROOT_LOCK}))`;
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hadron:secret-app-key-mint:${appId}`}))`;
}

/** The lock a root re-wrap holds exclusively and every mint holds shared. */
export const SECRET_ROOT_LOCK = 'hadron:secret-root';

/**
 * Create App key `keyVersion` as a fresh random key wrapped under `root`, and return its subkeys. The caller holds
 * {@link lockAppKeyMint} and has checked the root ({@link assertRootCheck}). The key is marked uncommitted for this
 * transaction, so it never enters the process-wide cache before the row is durable.
 */
export async function mintAppKeyVersion(
  db: Prisma.TransactionClient,
  appId: string,
  keyVersion: number,
  root: Buffer,
): Promise<AppKeyHandle> {
  const key = randomBytes(32);
  try {
    await db.secretAppKey.create({
      data: { appId, keyVersion, wrappedKey: encryptBytesAad(key, appKeyAad(appId, keyVersion), root) },
    });
    let mine = uncommitted.get(db);
    if (!mine) uncommitted.set(db, (mine = new Set()));
    mine.add(slotKey(appId, keyVersion));
    return handleFor(appId, keyVersion, key);
  } finally {
    key.fill(0);
  }
}

// ── the root check (#4003, FIT delta 2) ─────────────────────────────────────

/**
 * The key-check value of a root: HMAC-SHA256 under the root over a fixed label. It identifies which root is active
 * without revealing it (a 256-bit root cannot be recovered or guessed from it). Stored once, in
 * `secret_root_check`, and moved only by the root re-wrap, in the same transaction as the keys.
 */
export const rootCheckValue = (root: Buffer): string => createHmac('sha256', root).update('hadron:secret-root-check:v1').digest('hex');

/**
 * Refuse (`SECRET_KEY_UNAVAILABLE`) unless `root` is the recorded active root. This is what makes an instance still
 * running with the OLD root after a re-wrap fail closed: it would otherwise mint keys under a root nothing else
 * reads. Call it holding {@link lockAppKeyMint} (the shared root lock), so a concurrent re-wrap is either fully
 * visible or not yet started.
 *
 * With no recorded value (a fresh store, or one created before the check existed) the root is recorded, but only
 * after it is proven: if any App key exists, the newest one must unwrap under `root`. Two first recorders race on
 * the single row; the loser compares against the winner's value.
 */
export async function assertRootCheck(db: Prisma.TransactionClient, root: Buffer): Promise<void> {
  const mine = rootCheckValue(root);
  let row = await db.secretRootCheck.findUnique({ where: { id: 1 }, select: { checkValue: true } });
  if (!row) {
    const any = await db.secretAppKey.findFirst({ orderBy: { createdAt: 'desc' }, select: { appId: true, keyVersion: true, wrappedKey: true } });
    if (any) unwrap(root, any.appId, any.keyVersion, any.wrappedKey).fill(0);
    await db.$executeRaw`INSERT INTO secret_root_check (id, check_value) VALUES (1, ${mine}) ON CONFLICT (id) DO NOTHING`;
    row = await db.secretRootCheck.findUnique({ where: { id: 1 }, select: { checkValue: true } });
    if (!row) throw new SecretKeyUnavailableError();
  }
  const a = Buffer.from(row.checkValue, 'utf8');
  const b = Buffer.from(mine, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new SecretKeyUnavailableError();
}
