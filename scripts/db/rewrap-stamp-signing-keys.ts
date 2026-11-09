/**
 * #2973 C1 — root-rotation re-wrap of the stamp-key registry (`stamp_signing_keys`), the tool the
 * HADRON_ENCRYPTION_KEY rotation runbook calls BEFORE switching the configured root (Bob P2-3,
 * delta review of 77c9fda85b; the gate's "actual rollback/rotation recovery evidence").
 *
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/rewrap-stamp-signing-keys.ts <from-root-hex> <to-root-hex>
 *
 * Both roots are EXPLICIT arguments, never env-derived guesses: the runbook holds both. The
 * whole rewrap is one transaction inside {@link rewrapStampSigningKeys} — atomic (a failure
 * rolls every row back to the state it was found in) and idempotent (rows already under the
 * new root are skipped, so a re-run after success is a no-op and a re-run after a rolled-back
 * failure is correct). The inverse argument order is the rollback.
 *
 * After the rewrap this script VERIFIES: every registry row must unwrap under the NEW root,
 * and every retained generation must still round-trip a stamp (HMAC under the unwrapped key)
 * — the "stamps verify identically before and after" property, checked rather than assumed.
 * Exit is 0 only if the rewrap AND the verify pass; the script never prints key material or
 * roots. The server is NOT restarted or reconfigured here: the runbook switches
 * HADRON_ENCRYPTION_KEY after this script exits 0.
 *
 * Exit codes: 0 ok, 1 failed (rewrap or verify), 2 usage (bad args or no DATABASE_URL).
 */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import {
  computeStampTag, rewrapStampSigningKeys, StampRegistryUnavailableError, stampKeyAad, stampTagMatches,
} from '../../src/lib/signing/stampKeys.js';
import { decryptBytesAad, encryptionKeyFromHex } from '../../src/lib/tokenCrypto.js';
import type { StampInput } from '../../src/lib/signing/stampKeys.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** One throwaway stamp per retained generation proves the unwrapped key still HMACs (never printed). */
function keyStillStamps(key: Buffer): boolean {
  const probe: StampInput = {
    keyId: 0, nodeId: 'verify-probe', signingRequestId: 'verify-probe', signerId: 'verify-probe',
    credentialId: Buffer.alloc(32), revision: 1, approvalHash: '0'.repeat(64),
    memoryId: 'verify-probe', ownerKind: null, ownerId: null,
  };
  return stampTagMatches(key, probe, computeStampTag(key, probe));
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  const [fromHex, toHex] = argv;
  if (!fromHex || !toHex || !HEX64.test(fromHex) || !HEX64.test(toHex)) {
    log('db.stamp_key_rewrap.usage: two 64-hex-char roots required (from-root, to-root)');
    return 2;
  }
  if (!env.DATABASE_URL) {
    log('db.stamp_key_rewrap.database_url_missing');
    return 2;
  }
  const db = new PrismaClient();
  try {
    let out: { rows: number; rewrapped: number };
    try {
      out = await rewrapStampSigningKeys(db, fromHex, toHex);
    } catch (e) {
      // Named for the operator, without echoing roots or material.
      if (e instanceof StampRegistryUnavailableError) log(`db.stamp_key_rewrap.refused: ${e.message}`);
      else log('db.stamp_key_rewrap.rewrap_failed');
      return 1;
    }
    const to = encryptionKeyFromHex(toHex);
    const rows = await db.stampSigningKey.findMany({ select: { id: true, keyMaterial: true }, orderBy: { id: 'asc' } });
    for (const row of rows) {
      const key = decryptBytesAad(row.keyMaterial, stampKeyAad(row.id), to); // throws if not under the new root
      if (key.length !== 32 || !keyStillStamps(key)) {
        log(`db.stamp_key_rewrap.verify_failed: key ${row.id}`);
        return 1;
      }
    }
    log(`db.stamp_key_rewrap ok rows=${out.rows} rewrapped=${out.rewrapped} verified=${rows.length}`);
    return 0;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2), process.env, (line) => console.error(line));
}
