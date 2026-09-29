import type { PrismaClient } from '../generated/prisma/index.js';
import {
  encryptString,
  decryptString,
  encryptJson,
  decryptJson,
  markCiphertext,
  isCiphertext,
  stripCiphertextPrefix,
  type EncryptionKey,
} from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';

/**
 * Fields on a Node that are encrypted at rest when the memory is encrypted.
 * Everything else (name, loc, description, tags, nodeType, seq, etc.) stays
 * plaintext so queries, tree displays, and structural ops keep working.
 *
 * Spec 031 — `abstract` joins this set. Rationale: the abstract is a
 * paragraph-length summary of `content`, so leaking it plaintext on an
 * encrypted memory would defeat the encryption guarantee for the most
 * informative ~2000 chars per node (the same data the RAG follow-up will
 * vectorize). Trade-off: hadron_find_nodes previews and any future RAG/preview
 * surface on encrypted memories require an active session key, the same
 * way `content` reads already do. Documented in PR-201 review round-2.
 */
export interface EncryptedNodeFields {
  abstract: string | null;
  content: string | null;
  data: unknown | null;
}

/** Minimal interface we need from a Memory row to make encryption decisions. */
export interface MemoryEncryptionInfo {
  id: string;
  isEncrypted: boolean;
}

/**
 * Encrypt the `content` and `data` fields of a node payload in place. If the
 * memory is not encrypted, the payload is returned unchanged.
 *
 * Throws SESSION_EXPIRED_ERROR if the memory is encrypted but no active
 * session key is available.
 */
export function encryptNodeFields<T extends Partial<EncryptedNodeFields>>(
  payload: T,
  memory: MemoryEncryptionInfo,
): T {
  if (!memory.isEncrypted) return payload;
  const key = sessionKeyCache.getByMemoryId(memory.id);
  if (!key) {
    throw new Error('SESSION_EXPIRED: no active session key for this memory');
  }
  return applyEncryption(payload, key);
}

/** Like encryptNodeFields, but the key is passed in directly. */
export function encryptNodeFieldsWithKey<T extends Partial<EncryptedNodeFields>>(
  payload: T,
  key: EncryptionKey,
): T {
  return applyEncryption(payload, key);
}

/** A marker is only an envelope when its GCM tag authenticates under this memory key. */
export function isAuthenticatedStringEnvelope(value: string | null | undefined, key: EncryptionKey): boolean {
  if (!isCiphertext(value)) return false;
  try {
    decryptString(stripCiphertextPrefix(value), key);
    return true;
  } catch {
    return false;
  }
}

export function isAuthenticatedDataEnvelope(value: unknown, key: EncryptionKey): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== '__enc' || typeof entries[0][1] !== 'string') return false;
  try {
    decryptJson(entries[0][1], key);
    return true;
  } catch {
    return false;
  }
}

function applyEncryption<T extends Partial<EncryptedNodeFields>>(
  payload: T,
  key: EncryptionKey,
): T {
  const out: T = { ...payload };
  // Spec 031 — abstract is encrypted under the same envelope as content.
  if (payload.abstract !== undefined && payload.abstract !== null) {
    if (!isAuthenticatedStringEnvelope(payload.abstract, key)) {
      out.abstract = markCiphertext(encryptString(payload.abstract, key));
    }
  }
  if (payload.content !== undefined && payload.content !== null) {
    if (!isAuthenticatedStringEnvelope(payload.content, key)) {
      out.content = markCiphertext(encryptString(payload.content, key));
    }
  }
  if (payload.data !== undefined && payload.data !== null) {
    // JSON data is serialized then encrypted. We wrap the ciphertext in a
    // small JSON object so Prisma's Json type still accepts it.
    const existing = payload.data as Record<string, unknown>;
    if (!isAuthenticatedDataEnvelope(existing, key)) {
      const ct = encryptJson(payload.data, key);
      out.data = ct ? ({ __enc: ct } as unknown as T['data']) : payload.data;
    }
  }
  return out;
}

/**
 * Decrypt a node in place. Mutates the object so callers don't have to remap
 * shapes. If the memory is not encrypted, the node is returned unchanged.
 *
 * Throws SESSION_EXPIRED if the memory is encrypted and no key is available.
 * Callers that want a silent miss should check sessionKeyCache first.
 */
export function decryptNodeFields<T extends Partial<EncryptedNodeFields>>(
  node: T,
  memory: MemoryEncryptionInfo,
): T {
  if (!memory.isEncrypted) return node;
  const key = sessionKeyCache.getByMemoryId(memory.id);
  if (!key) {
    throw new Error('SESSION_EXPIRED: no active session key for this memory');
  }
  return applyDecryption(node, key);
}

/** Like decryptNodeFields, but the key is passed in directly. */
export function decryptNodeFieldsWithKey<T extends Partial<EncryptedNodeFields>>(
  node: T,
  key: EncryptionKey,
): T {
  return applyDecryption(node, key);
}

function applyDecryption<T extends Partial<EncryptedNodeFields>>(
  node: T,
  key: EncryptionKey,
): T {
  // Spec 031 — abstract decrypts under the same envelope as content.
  if (node.abstract != null && isAuthenticatedStringEnvelope(node.abstract, key)) {
    node.abstract = decryptString(stripCiphertextPrefix(node.abstract), key);
  }
  if (node.content != null && isAuthenticatedStringEnvelope(node.content, key)) {
    node.content = decryptString(stripCiphertextPrefix(node.content), key);
  }
  if (node.data != null && typeof node.data === 'object') {
    const wrapped = node.data as { __enc?: string };
    if (isAuthenticatedDataEnvelope(wrapped, key)) {
      node.data = decryptJson(wrapped.__enc, key);
    }
  }
  return node;
}

/**
 * Fetch a memory's encryption flag from the database. Cached-ish via the
 * caller — resolvers should call this once per request per memory.
 */
export async function getMemoryEncryptionInfo(
  db: PrismaClient,
  memoryId: string,
): Promise<MemoryEncryptionInfo> {
  const mem = await db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: { id: true, isEncrypted: true },
  });
  return mem;
}

/**
 * Convenience: decrypt a batch of nodes that may belong to different
 * memories. Looks up each memory's `isEncrypted` flag once and then decrypts.
 *
 * Nodes whose memory is encrypted but has no active session key are **kept
 * as-is** (ciphertext) rather than throwing, so callers can return partial
 * results. Callers that need a hard failure should check themselves.
 */
export async function decryptNodesBatch<
  T extends Partial<EncryptedNodeFields> & { memoryId: string },
>(db: PrismaClient, nodes: T[]): Promise<T[]> {
  if (nodes.length === 0) return nodes;
  const memoryIds = [...new Set(nodes.map((n) => n.memoryId))];
  const memories = await db.memory.findMany({
    where: { id: { in: memoryIds } },
    select: { id: true, isEncrypted: true },
  });
  const byId = new Map(memories.map((m) => [m.id, m]));
  for (const node of nodes) {
    const mem = byId.get(node.memoryId);
    if (mem && mem.isEncrypted) {
      const key = sessionKeyCache.getByMemoryId(mem.id);
      if (key) applyDecryption(node, key);
      // no key → leave as ciphertext rather than throwing
    }
  }
  return nodes;
}
