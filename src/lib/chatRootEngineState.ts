/** #3501 / cor:dmo:060:04, cor:sec:040:03. Operational does NOT mean plaintext.
 * All write helpers require the gated root's path lock. No read seeds or repairs state.
 * Ruling0209 retains the two names as encrypted rollback mirrors until #3557.
 */
import { GraphQLError } from 'graphql';
import { encryptString } from './crypto.js';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { decryptNodeFields, encryptNodeFields, isAuthenticatedDataEnvelope, type MemoryEncryptionInfo } from './nodeCrypto.js';
import { chatDataObject } from './chatRootCounters.js';
export const ENGINE_KEYS = ['conversationName', 'stageName', 'routeHistory', 'goalStack', 'lastOffTrackReason', 'lastOffTrackAt'] as const;
const MOVED = ['routeHistory', 'goalStack', 'lastOffTrackReason', 'lastOffTrackAt'] as const;
const invalid = () => new GraphQLError('Chat state is unavailable.', { extensions: { code: 'CHAT_STATE_INVALID' } });
/** Calendar validation without Date.parse rollover or database timezone conversion. */
function validEngineTime(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(:([0-9]{2})([.][0-9]+)?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?$/.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[7] ?? '0'].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || minute > 59 || second > 59 || hour > 24) return false;
  if (hour === 24 && (minute !== 0 || second !== 0 || /[1-9]/.test(m[8] ?? ''))) return false;
  const zone = m[9];
  if (zone && zone !== 'Z' && zone !== 'z') {
    const digits = zone.slice(1).replace(':', '');
    if (Number(digits.slice(0, 2)) > 23 || Number(digits.slice(2)) > 59) return false;
  }
  return true;
}
export function validEngineValue(key: string, value: unknown): boolean {
  if (key === 'conversationName' || key === 'stageName') return typeof value === 'string' && value.trim().length > 0;
  if (key === 'lastOffTrackReason') return typeof value === 'string';
  if (key === 'lastOffTrackAt') return validEngineTime(value);
  if (!Array.isArray(value)) return false;
  return value.every(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const e = entry as Record<string, unknown>;
    const strings = (keys: string[]) => keys.every(k => !Object.hasOwn(e, k) || e[k] === undefined || typeof e[k] === 'string');
    const time = validEngineTime;
    if (key === 'routeHistory') return typeof e.action === 'string' && ['ENTER','EXIT','COMPLETED','FOLLOWED'].includes(e.action) && time(e.timestamp)
      && strings(['nodeUrn','topicUrn','conversationUrn','edgeUrn'])
      && (!Object.hasOwn(e,'trigger') || (!!e.trigger && typeof e.trigger === 'object' && !Array.isArray(e.trigger)
        && typeof (e.trigger as Record<string,unknown>).type === 'string'
        && (!Object.hasOwn(e.trigger,'content') || (e.trigger as Record<string,unknown>).content === undefined || typeof (e.trigger as Record<string,unknown>).content === 'string')));
    return typeof e.description === 'string' && typeof e.createdBy === 'string' && ['ASSISTANT','USER'].includes(e.createdBy)
      && typeof e.status === 'string' && ['ACTIVE','COMPLETED','ABANDONED'].includes(e.status) && time(e.createdAt)
      && strings(['language','topicUrn','conversationUrn','nodeUrn','edgeUrn'])
      && (!Object.hasOwn(e,'completedAt') || time(e.completedAt));
  });
}
/** Existing rows are strict; malformed legacy non-name values stay in data, never silently stripped. */
export function engineState(data: unknown, strict = true): Record<string, unknown> {
  if (strict && (!data || typeof data !== 'object' || Array.isArray(data))) throw invalid();
  const object = chatDataObject(data), out: Record<string, unknown> = {};
  for (const key of ENGINE_KEYS) if (Object.hasOwn(object, key)) {
    if (validEngineValue(key, object[key])) out[key] = object[key];
    else if (strict || key === 'conversationName' || key === 'stageName') throw invalid();
  }
  return out;
}
function plaintext(state: unknown, info: MemoryEncryptionInfo): Record<string, unknown> {
  try {
    if (state && typeof state === 'object' && Object.hasOwn(state, '__enc') && (Object.keys(state).length !== 1 || typeof (state as Record<string, unknown>).__enc !== 'string')) throw invalid();
    return engineState(decryptNodeFields({ data: state }, info).data);
  }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('SESSION_EXPIRED:')) throw error;
    throw invalid();
  }
}
/** Read on the already gated node ids only. Never consult an arbitrary id supplied beside a gated root. */
export async function readChatEngineStates(db: PrismaClient, roots: readonly { id: string; memoryId: string; data: unknown }[]): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!roots.length) return result;
  const [rows, memories] = await Promise.all([
    db.chatRootEngineState.findMany({ where: { chatRootNodeId: { in: roots.map(r => r.id) } } }),
    db.memory.findMany({ where: { id: { in: [...new Set(roots.map(r => r.memoryId))] } }, select: { id: true, isEncrypted: true } }),
  ]);
  const byId = new Map(rows.map(r => [r.chatRootNodeId, r])), byMemory = new Map(memories.map(m => [m.id, m]));
  for (const root of roots) {
    const info = byMemory.get(root.memoryId);
    // Preserve myChats' existing encrypted-row null names, even for an unlocked memory.
    if (!info || info.isEncrypted) { result.set(root.id, {}); continue; }
    const row = byId.get(root.id);
    try { result.set(root.id, row ? plaintext(row.state, info) : engineState(root.data, false)); }
    catch (error) {
      // Display-only isolation: a corrupt root must not suppress healthy rows.
      // Never hide database/key failures or use legacy state as a repair fallback.
      if (!(error instanceof GraphQLError) || error.extensions.code !== 'CHAT_STATE_INVALID') throw error;
      result.set(root.id, {});
    }
  }
  return result;
}
/** Seed-if-absent, row wins, and scrub ONLY valid inert legacy keys. */
export async function lockedChatEngineState(tx: Prisma.TransactionClient, rootId: string, info: MemoryEncryptionInfo, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  let row = await tx.chatRootEngineState.findUnique({ where: { chatRootNodeId: rootId } });
  if (!row) {
    const legacy = engineState(data, false);
    const stored = encryptNodeFields({ data: legacy }, info).data;
    await tx.chatRootEngineState.createMany({ data: [{ chatRootNodeId: rootId, state: stored as Prisma.InputJsonValue }], skipDuplicates: true });
    row = await tx.chatRootEngineState.findUniqueOrThrow({ where: { chatRootNodeId: rootId } });
  }
  const state = plaintext(row.state, info);
  // Migration preserves malformed legacy fields. A partial row must not turn
  // such a name into the legacy no-stage case; a valid live row still wins.
  for (const key of ['conversationName', 'stageName']) {
    if (!Object.hasOwn(state, key) && Object.hasOwn(data, key) && !validEngineValue(key, data[key])) throw invalid();
  }
  const decoded = chatDataObject(decryptNodeFields({ data: row.state }, info).data);
  if (Object.keys(decoded).some(key => !(ENGINE_KEYS as readonly string[]).includes(key))) await writeChatEngineState(tx, rootId, info, state);
  const keys = MOVED.filter(key => Object.hasOwn(data, key) && Object.hasOwn(state, key) && validEngineValue(key, data[key]));
  if (keys.length) {
    if (info.isEncrypted) {
      const clean = { ...data }; for (const key of keys) delete clean[key];
      const stored = encryptNodeFields({ data: clean }, info).data;
      await tx.$executeRaw`UPDATE nodes n SET data=${JSON.stringify(stored)}::jsonb,
        revision_content_hash=CASE WHEN n.revision_content_hash=hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n.revision_content_hash END WHERE n.id=${rootId}`;
    } else {
      await tx.$executeRaw`UPDATE nodes n SET data=n.data - ${keys}::text[],
        revision_content_hash=CASE WHEN n.revision_content_hash=hadron_node_revision_state_hash(n) THEN 'refresh' ELSE n.revision_content_hash END WHERE n.id=${rootId}`;
    }
    for (const key of keys) delete data[key];
  }
  return state;
}
export async function writeChatEngineState(tx: Prisma.TransactionClient, rootId: string, info: MemoryEncryptionInfo, data: Record<string, unknown>): Promise<void> {
  const state = engineState(data);
  const stored = encryptNodeFields({ data: state }, info).data;
  await tx.chatRootEngineState.update({ where: { chatRootNodeId: rootId }, data: { state: stored as Prisma.InputJsonValue } });
}

/** Re-key at the existing node/memory locks; envelope shape, not the already-flipped flag, decides. */
export async function encryptChatEngineStateWithKey(tx: Prisma.TransactionClient, rootId: string, key: import('./crypto.js').EncryptionKey): Promise<boolean> {
  const row = await tx.chatRootEngineState.findUnique({ where: { chatRootNodeId: rootId } });
  if (!row || isAuthenticatedDataEnvelope(row.state, key)) return false;
  // A failed authentication is not plaintext. Preserve it and refuse, never nest or reseed it.
  if (row.state && typeof row.state === 'object' && Object.hasOwn(row.state, '__enc')) throw invalid();
  // Conversion is a confidentiality operation, not an engine execution/read.
  // Preserve all stored JSON (including malformed shapes and JSON null) verbatim;
  // strict semantic validation remains at the turn boundary after decryption.
  const stored = { __enc: encryptString(JSON.stringify(row.state), key) };
  await tx.chatRootEngineState.update({ where: { chatRootNodeId: rootId }, data: { state: stored as Prisma.InputJsonValue } });
  return true;
}
