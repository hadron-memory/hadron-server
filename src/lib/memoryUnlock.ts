/**
 * Spec 041 — caller-held key derivation, verification, and request-scoped
 * unlock staging (D-2026-07-06-B).
 *
 * The server NEVER persists a data key. What IS stored on the Memory row is
 * derivation material and a verifier — parameters, not secrets:
 *   - kdfSalt / kdfParams: how to turn a passphrase into the 32-byte key
 *     (scrypt; params stored per memory so they can be raised later).
 *   - keyVerifier: `enc:v1:` encryption of a fixed check string under the
 *     data key. Every unlock verifies against it, so a wrong passphrase is
 *     a typed WRONG_KEY — never garbage plaintext leaking to the caller.
 *
 * Keys enter per request (the `x-hadron-memory-keys` header, staged into a
 * request-scoped AsyncLocalStorage store — see requestKeys.ts — invisible
 * to concurrent requests and gone with the request's async context) or per
 * live session (startAgentSession / the MCP unlock tool, via the global
 * sessionKeyCache). All existing encrypt/decrypt call sites consult
 * sessionKeyCache.getByMemoryId, which checks the request store first, so
 * staging is the ONLY integration point stateless surfaces need.
 */

import { scryptSync, randomBytes } from 'crypto';
import type { PrismaClient } from '../generated/prisma/index.js';
import {
  parseDataKey,
  encryptString,
  decryptString,
  markCiphertext,
  stripCiphertextPrefix,
  isCiphertext,
  type EncryptionKey,
} from './crypto.js';
import { setRequestKey } from './requestKeys.js';
import { resolveMemoryRef } from './entityRef/memoryRef.js';

const KEY_CHECK_PLAINTEXT = 'hadron-key-check:v1';

export interface KdfParams {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
}

/** Default scrypt cost (interactive-grade; stored per memory, raisable later). */
export const DEFAULT_KDF_PARAMS: KdfParams = { alg: 'scrypt', N: 32768, r: 8, p: 1 };

/** Typed unlock failure — resolvers map `code` straight into GraphQL extensions. */
export class MemoryUnlockError extends Error {
  constructor(
    message: string,
    public readonly code: 'WRONG_KEY' | 'BAD_UNLOCK_INPUT' | 'NOT_ENCRYPTED',
  ) {
    super(message);
    this.name = 'MemoryUnlockError';
  }
}

/** Fresh random KDF salt (base64, 16 bytes). */
export function generateKdfSalt(): string {
  return randomBytes(16).toString('base64');
}

/** Parse a stored kdfParams JSON column; unknown algs fail loud. */
export function parseKdfParams(raw: unknown): KdfParams {
  const p = raw as Partial<KdfParams> | null;
  if (!p || p.alg !== 'scrypt' || !p.N || !p.r || !p.p) {
    throw new MemoryUnlockError('Memory has no usable KDF parameters.', 'BAD_UNLOCK_INPUT');
  }
  return { alg: 'scrypt', N: p.N, r: p.r, p: p.p };
}

/** Derive the 32-byte data key from a passphrase + stored salt/params. */
export function deriveDataKeyFromPassphrase(
  passphrase: string,
  saltB64: string,
  params: KdfParams,
): EncryptionKey {
  const raw = scryptSync(passphrase, Buffer.from(saltB64, 'base64'), 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    // scrypt default maxmem (32MB) is exceeded at N=2^15 r=8; give headroom.
    maxmem: 128 * params.N * params.r * 2,
  });
  return { raw };
}

/** Verifier stored on the Memory row — lets unlocks check the key without touching nodes. */
export function makeKeyVerifier(key: EncryptionKey): string {
  return markCiphertext(encryptString(KEY_CHECK_PLAINTEXT, key));
}

/** True iff `key` decrypts the stored verifier to the check string. */
export function verifyDataKey(verifier: string, key: EncryptionKey): boolean {
  if (!isCiphertext(verifier)) return false;
  try {
    return decryptString(stripCiphertextPrefix(verifier), key) === KEY_CHECK_PLAINTEXT;
  } catch {
    return false; // GCM auth failure = wrong key
  }
}

export interface SuppliedKeyInput {
  dataKey?: string | null;
  passphrase?: string | null;
}

/**
 * Resolve exactly-one-of dataKey/passphrase into a VERIFIED key for a
 * memory row. Rows created before spec 041 have no verifier — those accept
 * the key as-supplied (legacy posture: a wrong key surfaces as failed GCM
 * decrypts downstream, exactly as before).
 */
export function resolveSuppliedKey(
  memory: { kdfSalt: string | null; kdfParams: unknown; keyVerifier: string | null },
  input: SuppliedKeyInput,
): EncryptionKey {
  const hasKey = !!input.dataKey;
  const hasPass = !!input.passphrase;
  if (hasKey === hasPass) {
    throw new MemoryUnlockError('Provide exactly one of dataKey or passphrase.', 'BAD_UNLOCK_INPUT');
  }
  let key: EncryptionKey;
  if (hasKey) {
    try {
      key = parseDataKey(input.dataKey as string);
    } catch (e) {
      throw new MemoryUnlockError(String((e as Error).message), 'BAD_UNLOCK_INPUT');
    }
  } else {
    if (!memory.kdfSalt) {
      throw new MemoryUnlockError(
        'This memory was encrypted with a raw data key, not a passphrase.',
        'BAD_UNLOCK_INPUT',
      );
    }
    key = deriveDataKeyFromPassphrase(
      input.passphrase as string,
      memory.kdfSalt,
      parseKdfParams(memory.kdfParams),
    );
  }
  if (memory.keyVerifier && !verifyDataKey(memory.keyVerifier, key)) {
    throw new MemoryUnlockError('Wrong passphrase or data key for this memory.', 'WRONG_KEY');
  }
  return key;
}

/** One entry of the `x-hadron-memory-keys` request header (JSON array). */
export interface RequestKeyEntry {
  /** Memory ref — PK or URN. */
  memory: string;
  dataKey?: string;
  passphrase?: string;
}

export const REQUEST_KEYS_HEADER = 'x-hadron-memory-keys';

/**
 * Stage per-request unlock keys from the raw header value into the CURRENT
 * request's AsyncLocalStorage store (src/lib/requestKeys.ts) — never the
 * global cache, so concurrent requests can't observe them and an aborted
 * response leaves nothing behind (PR-514 review, Codex P1 ×2): the store is
 * garbage-collected with the request's async context, finished or not.
 * Must run inside requestKeyStorage.run(...) (the /graphql middleware
 * establishes it). Throws MemoryUnlockError on malformed input / wrong
 * keys — surfacing at context time, before any resolver runs.
 */
export async function stageRequestMemoryKeys(
  db: PrismaClient,
  headerValue: string | string[] | undefined,
): Promise<void> {
  if (!headerValue) return;
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  let entries: RequestKeyEntry[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    entries = parsed as RequestKeyEntry[];
  } catch {
    throw new MemoryUnlockError(
      `Malformed ${REQUEST_KEYS_HEADER} header — expected a JSON array of {memory, dataKey|passphrase}.`,
      'BAD_UNLOCK_INPUT',
    );
  }
  for (const entry of entries) {
    if (!entry || typeof entry.memory !== 'string') {
      throw new MemoryUnlockError('Each header entry needs a memory ref.', 'BAD_UNLOCK_INPUT');
    }
    const { id: memoryId } = await resolveMemoryRef(db, entry.memory);
    const memory = await db.memory.findUniqueOrThrow({
      where: { id: memoryId },
      select: { isEncrypted: true, kdfSalt: true, kdfParams: true, keyVerifier: true },
    });
    if (!memory.isEncrypted) {
      throw new MemoryUnlockError('Memory is not encrypted.', 'NOT_ENCRYPTED');
    }
    // Verified before staging; partial staging on a later failure is
    // harmless — the store is request-local and dies with the request.
    setRequestKey(memoryId, resolveSuppliedKey(memory, entry));
  }
}
