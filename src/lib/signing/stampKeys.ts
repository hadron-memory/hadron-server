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
 * The newest unretired mint key, creating the first row if none exists. Serialized
 * by a transaction-scoped advisory lock (Rico #92969 §3): two ceremonies completing
 * concurrently both leave with A key and every stamp names the key that made it, but
 * the registry stays one row per generation — the explicit id is assigned under the
 * lock so the AAD can bind it before the insert. Fails closed: an unwrap that throws
 * (wrong AAD — a planted ciphertext — wrong root, tampering) ends the completion,
 * never mints under material it cannot prove.
 */
export async function mintStampSigningKey(tx: Prisma.TransactionClient): Promise<{ id: number; key: Buffer }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hadron:stamp-signing-key-mint'))`;
  const newest = await tx.stampSigningKey.findFirst({ orderBy: { id: 'desc' }, select: { id: true, keyMaterial: true, retiredAt: true } });
  if (newest && newest.retiredAt === null) {
    return { id: newest.id, key: unwrapStampKey(newest.id, newest.keyMaterial) };
  }
  const id = (newest?.id ?? 0) + 1;
  const key = randomBytes(32);
  await tx.stampSigningKey.create({ data: { id, keyMaterial: encryptBytesAad(key, stampKeyAad(id)) } });
  return { id, key };
}

/**
 * The verification key a stamp names, or null — unknown id, missing row, a planted
 * ciphertext (wrong AAD fails the GCM tag), a wrong root, anything but exactly 32
 * bytes of recoverable material. Null NEVER counts (Rico #92969 §4).
 */
export async function stampVerificationKey(db: Db, keyId: number): Promise<Buffer | null> {
  const row = await db.stampSigningKey.findUnique({ where: { id: keyId }, select: { keyMaterial: true } });
  if (!row) return null;
  try {
    return unwrapStampKey(keyId, row.keyMaterial);
  } catch {
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
 * inverse call is the rollback. Not wired to any route or env var: the rotation
 * runbook (which already owns every tokenCrypto secret) holds both roots explicitly;
 * a partial failure throws with rows left wrapped as they were found, each row is
 * re-wrapped independently, and re-running is idempotent in effect.
 */
export async function rewrapStampSigningKeys(db: Db, fromRootHex: string, toRootHex: string): Promise<number> {
  const from = encryptionKeyFromHex(fromRootHex);
  const to = encryptionKeyFromHex(toRootHex);
  const rows = await db.stampSigningKey.findMany({ select: { id: true, keyMaterial: true }, orderBy: { id: 'asc' } });
  for (const row of rows) {
    const material = decryptBytesAad(row.keyMaterial, stampKeyAad(row.id), from);
    if (material.length !== 32) throw new Error(`stamp key ${row.id} is not 32 bytes`);
    const rewrapped = encryptBytesAad(material, stampKeyAad(row.id), to);
    if (rewrapped === row.keyMaterial) continue;
    await db.stampSigningKey.update({ where: { id: row.id }, data: { keyMaterial: rewrapped } });
  }
  return rows.length;
}
