/**
 * #2973 C1 (cor:dmo:130:09; gate holds 6749839869 / 6750325233; rulings #92963,
 * #92967, #92969, #92972) — the retained versioned registry of stamp HMAC keys, and
 * the canonical stamp itself.
 *
 * The stamp is the durable at-signing verdict a row-seeding attacker cannot produce:
 * HMAC-SHA256 under a key that never leaves the process unencrypted, over the
 * signature row's own identity fields plus what the completion attested (the memory
 * at signing; which Agent/App the signer managed, when they did). A completed
 * request alone pins node/revision/hash but no signer-bound authority fact — a seed
 * copies any static column, so only a value keyed on a secret the seed cannot read
 * distinguishes ceremony-made rows (Anne's C1). A plain verdict column would be
 * copied with the row; this is not one.
 *
 * Key lifecycle (Xylon #92967 accepted conditionally; Vera 6750118215 §2; Rico
 * #92969): random purpose-scoped 32-byte keys in `stamp_signing_keys`, stored
 * AES-256-GCM-wrapped with AAD `hadron:stamp-key:v1:<id>` — never derived from
 * `HADRON_ENCRYPTION_KEY` (retaining an old root would retain a key that decrypts
 * everything; a stamp key retains only stamp power). Verification keys are retained
 * forever; rotating the root RE-WRAPS registry rows (`rewrapStampSigningKeys`),
 * never invalidates them, so no signature ever stops counting because of a key
 * change. Minting uses the newest unretired key; nothing in PR1 retires (no ops
 * surface — no env var, no tool). An unknown or undecryptable key id fails closed.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { decryptBytesAad, encryptBytesAad, encryptionKeyFromHex } from '../tokenCrypto.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The registry cannot serve keys under the configured root — a wrong-root rotation
 * (rewrap never ran or ran partway), a planted row, a tampered ciphertext. Typed so
 * the ceremony surface can answer 503 SIGNING_UNAVAILABLE instead of a generic
 * internal error: an operator can act on this, a signer cannot retry past it. Never
 * wraps a signature under material it cannot prove (fail closed).
 */
export class StampRegistryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StampRegistryUnavailableError';
  }
}

/** The stamp's purpose label; the `v1` is the STAMP shape version (not a key id). */
export const STAMP_PURPOSE = 'hadron:signing:eligibility-stamp:v1';

/** The AAD binding a registry row to its purpose and id (Rico #92969 §1). */
export const stampKeyAad = (keyId: number): string => `hadron:stamp-key:v1:${keyId}`;

/** What a stamp attests: the row's identity plus the completion's verdict facts. */
export interface StampInput {
  keyId: number;
  nodeId: string;
  signingRequestId: string;
  signerId: string;
  /** The passkey credential's raw id bytes (the credential `requireSigner` admitted). */
  credentialId: Buffer;
  revision: number;
  approvalHash: string;
  /** The node's memory AT SIGNING — the capture-memory binding of the #92963 fence. */
  memoryId: string;
  /** The Agent/App the signer managed at signing, when they did (the manager grade). */
  ownerKind: 'AGENT' | 'APP' | null;
  ownerId: string | null;
}

/**
 * Length-prefixed canonical encoding (Rico #92969 §4): every field is
 * `uint32be(len) || bytes`, so no concatenation of values can alias another and a
 * moved field boundary changes the tag. Fixed order, fixed types — the tag is a
 * function of the INPUT alone, never of how a caller assembled it.
 */
export function canonicalStampInput(input: StampInput): Buffer {
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0, 0);
    return b;
  };
  const str = (v: string) => {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([u32(b.length), b]);
  };
  const bytes = (v: Buffer) => Buffer.concat([u32(v.length), v]);
  return Buffer.concat([
    str(STAMP_PURPOSE),
    u32(input.keyId),
    str(input.nodeId),
    str(input.signingRequestId),
    str(input.signerId),
    bytes(input.credentialId),
    u32(input.revision),
    str(input.approvalHash),
    str(input.memoryId),
    str(input.ownerKind ?? ''),
    str(input.ownerId ?? ''),
  ]);
}

/** The stamp tag over `input` under `key`. */
export function computeStampTag(key: Buffer, input: StampInput): Buffer {
  return createHmac('sha256', key).update(canonicalStampInput(input)).digest();
}

/** Constant-time tag comparison (Rico #92969 §4). Equal lengths are part of the shape. */
export function stampTagMatches(key: Buffer, input: StampInput, tag: Buffer): boolean {
  const expected = computeStampTag(key, input);
  return tag.length === expected.length && timingSafeEqual(tag, expected);
}

/**
 * The newest unretired mint key, creating the first row if none exists. The COMMON
 * path (a usable newest key exists) takes NO lock: ceremonies serialize only when a
 * row must be created, and creation is serialized by a transaction-scoped advisory
 * lock (Rico #92969 §3) — two ceremonies racing the first mint both leave with A
 * key and every stamp names the key that made it, but the registry stays one row
 * per generation (the loser re-reads under the lock and returns the winner's row).
 * The explicit id is assigned under the lock so the AAD can bind it before the
 * insert; `setval` afterwards keeps the identity sequence ahead of the explicit
 * ids, so any future implicit insert (an ops script, Prisma's default) never
 * collides at 1. Fails closed: an unwrap that throws (wrong AAD — a planted
 * ciphertext — wrong root, tampering) is a typed StampRegistryUnavailableError and
 * ends the completion, never mints under material it cannot prove.
 */
export async function mintStampSigningKey(tx: Prisma.TransactionClient): Promise<{ id: number; key: Buffer }> {
  const newestRow = () => tx.stampSigningKey.findFirst({ orderBy: { id: 'desc' }, select: { id: true, keyMaterial: true, retiredAt: true } });
  const usable = async (row: { id: number; keyMaterial: string; retiredAt: Date | null } | null) => {
    if (!row || row.retiredAt !== null) return null;
    try {
      return { id: row.id, key: unwrapStampKey(row.id, row.keyMaterial) };
    } catch (e) {
      throw new StampRegistryUnavailableError(
        `stamp key ${row.id} does not unwrap under the configured root (wrong-root rotation or a planted row): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  let newest = await newestRow();
  let minted = await usable(newest);
  if (minted) return minted;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hadron:stamp-signing-key-mint'))`;
  newest = await newestRow();
  minted = await usable(newest);
  if (minted) return minted;
  const id = (newest?.id ?? 0) + 1;
  const key = randomBytes(32);
  await tx.stampSigningKey.create({ data: { id, keyMaterial: encryptBytesAad(key, stampKeyAad(id)) } });
  await tx.$executeRaw`SELECT setval(pg_get_serial_sequence('stamp_signing_keys', 'id'), ${id}, true)`;
  return { id, key };
}

/**
 * The verification key a stamp names, or null — unknown id, missing row, a planted
 * ciphertext (wrong AAD fails the GCM tag), a wrong root, anything but exactly 32
 * bytes of recoverable material. Null NEVER counts (Rico #92969 §4).
 *
 * Fail-closed is right, but a null with no trace reads to an operator as a plain
 * NOT_SIGNED (Bob P3-2, delta review of deef730133): an unreadable key is an
 * operator-actionable registry fault. So the failure is logged — the key id and the
 * unwrap reason, never material — once per process per key id, enough to diagnose
 * without flooding a serve path that hits the same dead row per request.
 */
const unreadableKeyLogged = new Set<number>();

export async function stampVerificationKey(db: Pick<PrismaClient, 'stampSigningKey'>, keyId: number): Promise<Buffer | null> {
  const row = await db.stampSigningKey.findUnique({ where: { id: keyId }, select: { keyMaterial: true } });
  if (!row) return null;
  try {
    return unwrapStampKey(keyId, row.keyMaterial);
  } catch (e) {
    if (!unreadableKeyLogged.has(keyId)) {
      unreadableKeyLogged.add(keyId);
      console.warn(`[stamp-keys] stamp key ${keyId} does not unwrap under the configured root (wrong-root rotation or a planted row): ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
}

/** Unwrap with the row's AAD and require exactly 32 bytes, or throw. */
function unwrapStampKey(keyId: number, keyMaterial: string): Buffer {
  const key = decryptBytesAad(keyMaterial, stampKeyAad(keyId));
  if (key.length !== 32) throw new Error(`stamp key ${keyId} is not 32 bytes`);
  return key;
}

/**
 * Root-rotation re-wrap (recovery evidence per Xylon #92967): decrypt every registry
 * row under `fromRootHex` and wrap it again under `toRootHex`, AAD unchanged. Stamps
 * verify identically before and after — a rotation adds no way for a signature to
 * stop counting (Vera 6750118215 §2, engineered away rather than ruled on). The
 * inverse call is the rollback.
 *
 * ATOMIC and IDEMPOTENT (Anne D1 / Bob P2-2, gate hold #93166): the whole operation
 * is ONE interactive transaction this function opens — every row is validated and
 * unwrapped BEFORE any write, all writes commit together, and any failure (a row
 * that unwraps under neither root, a DB write error) rolls the registry back to
 * exactly the state it was found in, so a failed rewrap can never leave a usable key
 * stranded under the wrong root. Re-running is safe by try-`to`-first: a row that
 * already unwraps under the NEW root is skipped (a re-run after success is a no-op;
 * a re-run after a rolled-back failure finds every row still under `from`). A row
 * under NEITHER root aborts the whole call with a typed error naming it — planted
 * or corrupt material is never silently carried. Reached by
 * `scripts/db/rewrap-stamp-signing-keys.ts` (the rotation runbook holds both roots
 * explicitly); not wired to any route or env var.
 */
export async function rewrapStampSigningKeys(
  db: PrismaClient,
  fromRootHex: string,
  toRootHex: string,
): Promise<{ rows: number; rewrapped: number }> {
  const from = encryptionKeyFromHex(fromRootHex);
  const to = encryptionKeyFromHex(toRootHex);
  return db.$transaction(async (tx) => {
    // Serialize against mint's creation leg (the registry's only other writer), which takes the same
    // transaction-scoped lock (Rico #92969 §3 / #93374): an in-flight creation either commits before this
    // transaction's snapshot (and is rewrapped below) or waits for it. The lock does NOT cover a mint by a
    // still-running old-root instance AFTER the rewrap commits — on an empty registry that mint re-reads no
    // rows under the lock and creates key 1 under the OLD root, a stranded row; stopping all writers first and
    // re-running the tool after the switch are what cover that (the runbook's proof, not this lock).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hadron:stamp-signing-key-mint'))`;
    const rows = await tx.stampSigningKey.findMany({ select: { id: true, keyMaterial: true }, orderBy: { id: 'asc' } });
    const writes: Array<{ id: number; keyMaterial: string }> = [];
    for (const row of rows) {
      const aad = stampKeyAad(row.id);
      try {
        const already = decryptBytesAad(row.keyMaterial, aad, to);
        if (already.length !== 32) throw new Error('not 32 bytes');
        continue; // already under the new root — idempotent skip
      } catch {
        // not under `to` yet; must be under `from` or the call aborts below
      }
      let material: Buffer;
      try {
        material = decryptBytesAad(row.keyMaterial, aad, from);
      } catch (e) {
        throw new StampRegistryUnavailableError(
          `stamp key ${row.id} unwraps under neither the old nor the new root (planted or corrupt row): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (material.length !== 32) throw new StampRegistryUnavailableError(`stamp key ${row.id} is not 32 bytes`);
      writes.push({ id: row.id, keyMaterial: encryptBytesAad(material, aad, to) });
    }
    for (const w of writes) {
      await tx.stampSigningKey.update({ where: { id: w.id }, data: { keyMaterial: w.keyMaterial } });
    }
    return { rows: rows.length, rewrapped: writes.length };
  });
}
