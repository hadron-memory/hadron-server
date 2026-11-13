/**
 * #4003 (S8 of #3991; R17, R18) — App key rotation and the secrets-root re-wrap.
 *
 * Both run ONLY as ops scripts under the owner credential in v1 (FIT delta 1, option a, ruled by Victor under
 * ruling 0265): there is no GraphQL, CLI or MCP surface, so no authorization-table row and no rate-limit row. The
 * scripts are `scripts/db/rotate-app-key.ts` and `scripts/db/rewrap-secret-keys.ts`; the runbook is the ops node
 * `hrn:node:hadronmemory.com:dev:ops:alpha:app-secrets-key-rotation`.
 *
 * - {@link rotateAppKey}: mint App key n+1 and retire n in one transaction. A retired key stops encrypting and still
 *   unwraps, so every version written under it stays readable until an optional re-encrypt moves it.
 * - {@link rewrapSecretRootKeys}: move every wrapped App key from the old root to the new one, and the root's
 *   key-check value with them, in one transaction. It is idempotent, and it aborts with nothing changed if any row
 *   unwraps under neither root, so a failed run leaves every key readable under ONE root.
 *
 * An instance still running the old root after a re-wrap fails closed (FIT delta 2): every mint and rotation first
 * compares the instance's root with the recorded key-check value ({@link assertRootCheck}). The runbook still
 * stops writers before the switch and re-runs the re-wrap afterwards as the proof, as the stamp-key precedent does.
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { decryptBytesAad, encryptBytesAad } from '../tokenCrypto.js';
import {
  type AppKeyHandle, SECRET_ROOT_LOCK, SecretKeyUnavailableError, appKeyAad, appKeyCache, assertRootCheck,
  lockAppKeyMint, mintAppKeyVersion, rootCheckValue, rootKey,
} from './appKeys.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Rotate one App's data key: retire the active version (if any) and mint the next one under the current root.
 * Returns the new key's subkeys. Call INSIDE a transaction (the locks are transaction-scoped). Refuses
 * `SECRET_KEY_UNAVAILABLE`, writing nothing, when the root is missing or is not the recorded active root, or the
 * App does not exist. Two concurrent rotations serialize on the App's mint lock: each mints the next number.
 */
export async function rotateAppKey(db: Prisma.TransactionClient, appId: string): Promise<AppKeyHandle> {
  const root = rootKey();
  await lockAppKeyMint(db, appId);
  await assertRootCheck(db, root);
  if (!(await db.app.findUnique({ where: { id: appId }, select: { id: true } }))) throw new SecretKeyUnavailableError();
  const newest = await db.secretAppKey.findFirst({ where: { appId }, orderBy: { keyVersion: 'desc' }, select: { keyVersion: true } });
  // Retire first: the partial unique index allows one active key per App, and the stamp is the database clock.
  await db.$executeRaw`UPDATE secret_app_keys SET retired_at = clock_timestamp() AT TIME ZONE 'UTC' WHERE app_id = ${appId} AND retired_at IS NULL`;
  return mintAppKeyVersion(db, appId, (newest?.keyVersion ?? 0) + 1, root);
}

/** Unwrap `wrapped` under `root` with `aad`, or null (any GCM failure, or a plaintext that is not 32 bytes). */
function tryUnwrap(wrapped: string, aad: string, root: Buffer): Buffer | null {
  try {
    const key = decryptBytesAad(wrapped, aad, root);
    if (key.length === 32) return key;
    key.fill(0);
  } catch {
    // not under this root
  }
  return null;
}

/**
 * Re-wrap every App key from `fromRootHex` to `toRootHex` and record the new root's key-check value, in one
 * transaction holding the secrets-root lock exclusively (every mint holds it shared, so none interleaves). A row
 * already under the new root is skipped (idempotent: the post-switch re-run is the proof and rewraps nothing). A row
 * under neither root refuses `SECRET_KEY_UNAVAILABLE` and the transaction rolls back, so the keys and the check
 * value stay together under the old root. Each row keeps its AAD (its App and version). Clears this process's key
 * cache on success. The roots are never logged; the caller supplies them from protected input, never argv.
 */
export async function rewrapSecretRootKeys(
  db: PrismaClient,
  fromRootHex: string,
  toRootHex: string,
): Promise<{ rows: number; rewrapped: number }> {
  if (!HEX64.test(fromRootHex) || !HEX64.test(toRootHex)) throw new SecretKeyUnavailableError();
  const from = Buffer.from(fromRootHex, 'hex');
  const to = Buffer.from(toRootHex, 'hex');
  const out = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SECRET_ROOT_LOCK}))`;
    const rows = await tx.secretAppKey.findMany({
      select: { appId: true, keyVersion: true, wrappedKey: true },
      orderBy: [{ appId: 'asc' }, { keyVersion: 'asc' }],
    });
    const writes: Array<{ appId: string; keyVersion: number; wrappedKey: string }> = [];
    for (const row of rows) {
      const aad = appKeyAad(row.appId, row.keyVersion);
      const already = tryUnwrap(row.wrappedKey, aad, to);
      if (already) {
        already.fill(0);
        continue;
      }
      const key = tryUnwrap(row.wrappedKey, aad, from);
      if (!key) throw new SecretKeyUnavailableError();
      try {
        writes.push({ appId: row.appId, keyVersion: row.keyVersion, wrappedKey: encryptBytesAad(key, aad, to) });
      } finally {
        key.fill(0);
      }
    }
    for (const w of writes) {
      await tx.secretAppKey.update({
        where: { appId_keyVersion: { appId: w.appId, keyVersion: w.keyVersion } },
        data: { wrappedKey: w.wrappedKey },
      });
    }
    const check = rootCheckValue(to);
    await tx.$executeRaw`INSERT INTO secret_root_check (id, check_value) VALUES (1, ${check})
      ON CONFLICT (id) DO UPDATE SET check_value = EXCLUDED.check_value, updated_at = clock_timestamp() AT TIME ZONE 'UTC'`;
    return { rows: rows.length, rewrapped: writes.length };
  });
  appKeyCache.clear();
  return out;
}
