/**
 * Who a memory's `loc:'data'` values are about, and who may read them (#910).
 *
 * The memory-level `data` node is the variable bag that `compileTemplate`
 * reads as prompt defaults and that routing conditions evaluate against. Chat
 * extraction folds the model's extracted values into it.
 *
 * **Single-human hosts are unchanged.** In a personal or private memory there
 * is only one person a value can be about, so the bag stays one flat object,
 * read and written exactly as before.
 *
 * **A multi-human chat host keeps personal values per person.** In an
 * app-class memory every chat is joint and every member of the App takes part
 * in it (`cor:acl:030:01`), so one flat bag cannot say whose `industry` it
 * holds: member A's answer used to become member B's prompt variable and
 * routing operand. There, the node is laid out as:
 *
 *   - `data.users[<userId>][<field>]` — values extracted from that member's
 *     own turns. Read only during that member's turns.
 *   - flat `data[<field>]` — memory-wide values, read for everyone, but only
 *     when the field is EXPLICITLY memory-wide (below).
 *   - `data.memoryWideKeys` — an optional string array naming flat fields an
 *     owner has classified as memory-wide by hand.
 *
 * The read rule is Vera's PROPOSAL on `cor:acl:030:01` ("a value about one
 * person is only ever read for that person"), built under Eden's direction
 * (team chat #13017). It is not yet a confirmed amendment.
 *
 * **Explicitly memory-wide** means one of:
 *   - every extraction spec in the host Agent's system memory that names the
 *     field declares it `memory.<field>`. This is the existing explicit
 *     destination syntax (`chatExtraction.ts`), and it is what an author
 *     already uses to say "everyone in this memory shares this value";
 *   - the field is listed in `data.memoryWideKeys`.
 *
 * **Legacy values.** Before #910, every extracted value in an app-class host
 * was written flat, so a flat field that is not explicitly memory-wide may be
 * any member's personal answer. Nothing says whose. Such a field is kept in
 * storage untouched, but no prompt or routing view reads it, for any member:
 * it is never assigned to the chat creator, the last speaker or everyone, and
 * never treated as a trusted default. An owner repairs it explicitly, either
 * by listing it in `memoryWideKeys` (it really is shared) or by moving it
 * under `users.<id>` (it is that person's). No migration runs.
 *
 * The `chat.` / `stage.` destinations sketched by the #927 groundwork in
 * `chatExtraction.ts` are NOT built: filing values on the chat node answers
 * the Deferred registry question Q-2026-08-07-004, and a chat in a
 * multi-human host is joint anyway, so it would still need a person key. Here
 * every field that is not declared `memory.` is personal.
 *
 * Only `app` is a multi-human chat host today: per `cor:acl:030:01`, a shared
 * chat lives only in an app-class memory (`shared ⇔ app`). Every other class
 * keeps the flat bag. The `system` memory holding an Agent's definition is
 * authored, never extracted into, so its `data` node is read whole.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { USERS_SUBKEY, parseExtractionField } from './chatExtraction.js';

/** Per-person buckets on a multi-human host's `data` node, keyed by user id. */
export const USERS_KEY = USERS_SUBKEY;

/** Owner-maintained list of flat fields classified as memory-wide. */
export const MEMORY_WIDE_KEYS_KEY = 'memoryWideKeys';

/** Storage keys on the `data` node that are never prompt or routing variables. */
const RESERVED_KEYS: ReadonlySet<string> = new Set([USERS_KEY, MEMORY_WIDE_KEYS_KEY]);

/** The memory fields `isMultiHumanChatHost` and `hostAgentSystemMemoryId` need. */
export interface DataHostMemory {
  id: string;
  class: string;
  sharedMemoryOfAgentId: string | null;
  userMemoryOfAgentId: string | null;
}

export const DATA_HOST_MEMORY_SELECT = {
  id: true,
  class: true,
  sharedMemoryOfAgentId: true,
  userMemoryOfAgentId: true,
} as const;

/**
 * Whether this memory's `data` node is laid out per person.
 *
 * `app` only: it is the one multi-human class that can hold a chat
 * (`cor:acl:030:01`), so it is the only one extraction can have written
 * personal values into.
 */
export function isMultiHumanChatHost(memory: Pick<DataHostMemory, 'class'> | null | undefined): boolean {
  return memory?.class === 'app';
}

/**
 * Field names the host Agent's extraction specs declare memory-wide.
 *
 * A name counts only when EVERY declaration of it says `memory.`: if one stage
 * declares `memory.industry` and another plain `industry`, the field is
 * ambiguous and stays personal. Both the write path and the read path use this
 * one function, so a value is never filed under one rule and read under
 * another.
 */
export async function declaredMemoryWideFields(
  db: PrismaClient,
  memory: DataHostMemory,
): Promise<Set<string>> {
  const systemMemoryId = await hostAgentSystemMemoryId(db, memory);
  if (!systemMemoryId) return new Set();
  const nodes = await db.node.findMany({
    where: {
      memoryId: systemMemoryId,
      deletedAt: null,
      OR: [{ loc: 'config' }, { loc: { startsWith: 'conversations:' } }],
    },
    select: { data: true },
  });
  const memoryWide = new Set<string>();
  const personal = new Set<string>();
  for (const node of nodes) {
    const data = node.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') continue;
    for (const key of ['agentExtractionSpec', 'extractionSpec']) {
      const specs = data[key];
      if (!Array.isArray(specs)) continue;
      for (const spec of specs) {
        const field = (spec as { field?: unknown } | null)?.field;
        if (typeof field !== 'string') continue;
        const parsed = parseExtractionField(field);
        (parsed.destination === 'memory' ? memoryWide : personal).add(parsed.name);
      }
    }
  }
  for (const name of personal) memoryWide.delete(name);
  for (const name of RESERVED_KEYS) memoryWide.delete(name);
  return memoryWide;
}

async function hostAgentSystemMemoryId(
  db: PrismaClient,
  memory: DataHostMemory,
): Promise<string | null> {
  const agentId = memory.sharedMemoryOfAgentId ?? memory.userMemoryOfAgentId;
  if (!agentId) return null;
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { systemMemoryId: true },
  });
  return agent?.systemMemoryId ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The variables one turn may read from a multi-human host's `data` node:
 * explicitly memory-wide fields, then the reading person's own values on top.
 *
 * `personId` null (an App-key turn, a runner render, a plain node read) reads
 * memory-wide values only: with no attributable person there is nobody whose
 * values it may read.
 */
export function multiHumanDataView(
  stored: Record<string, unknown> | null | undefined,
  declaredMemoryWide: ReadonlySet<string>,
  personId: string | null | undefined,
): Record<string, unknown> {
  const data = asRecord(stored);
  const listed = Array.isArray(data[MEMORY_WIDE_KEYS_KEY])
    ? (data[MEMORY_WIDE_KEYS_KEY] as unknown[]).filter((k): k is string => typeof k === 'string')
    : [];
  const memoryWide = new Set([...declaredMemoryWide, ...listed]);
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED_KEYS.has(key) || !memoryWide.has(key)) continue;
    view[key] = value;
  }
  if (personId) {
    const mine = asRecord(asRecord(data[USERS_KEY])[personId]);
    Object.assign(view, mine);
  }
  return view;
}

/**
 * Load a memory's `data`-node view for one reader. Single-human hosts get the
 * stored bag back unchanged; a multi-human host gets `multiHumanDataView`.
 * A db without `memory` (narrow test doubles) is treated as single-human.
 */
export async function dataViewFor(
  db: PrismaClient,
  memoryId: string,
  stored: Record<string, unknown> | null | undefined,
  personId: string | null | undefined,
): Promise<Record<string, unknown> | null | undefined> {
  if (!db.memory?.findUnique) return stored;
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: DATA_HOST_MEMORY_SELECT,
  });
  if (!memory || !isMultiHumanChatHost(memory)) return stored;
  return multiHumanDataView(stored, await declaredMemoryWideFields(db, memory), personId);
}

/**
 * Fold one turn's extracted values into a multi-human host's stored `data`.
 *
 * Declared memory-wide fields land flat. Everything else is the speaker's and
 * lands under `users[<speakerId>]`; with no attributable speaker those values
 * are dropped rather than filed under a placeholder that some reader would
 * later take for a person. Other members' buckets, the classification list and
 * every legacy flat field are carried over untouched.
 */
export function mergeTurnExtraction(
  stored: Record<string, unknown> | null | undefined,
  extracted: Record<string, unknown>,
  declaredMemoryWide: ReadonlySet<string>,
  speakerId: string | null | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...asRecord(stored) };
  const personal: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extracted)) {
    if (declaredMemoryWide.has(key) && !RESERVED_KEYS.has(key)) next[key] = value;
    else personal[key] = value;
  }
  if (speakerId && Object.keys(personal).length > 0) {
    const users = asRecord(next[USERS_KEY]);
    next[USERS_KEY] = { ...users, [speakerId]: { ...asRecord(users[speakerId]), ...personal } };
  }
  return next;
}
