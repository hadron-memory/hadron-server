import { Prisma } from '../generated/prisma/index.js';
import { GraphQLError } from 'graphql';

/**
 * #1688: Prisma messages contain query arguments and schema internals, so none
 * may reach a client. One predicate for every surface that redacts them — the
 * GraphQL formatter, and a wrapper that would otherwise copy the message into
 * an error of its own (#1691: the partial-merge wrapper).
 */
export function isPrismaClientError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientValidationError ||
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError;
}

/** What a client is told in place of a Prisma message. */
export const REDACTED_DB_ERROR_MESSAGE = 'Unable to complete this request. Please try again.';

/** `meta.target` spellings of the Node `@@unique([loc, memoryId])` (the engine emits either mapping). */
const NODE_LOC_UNIQUE_COLUMNS = [['loc', 'memory_id'], ['loc', 'memoryId']] as const;
const NODE_LOC_UNIQUE_NAME = 'nodes_loc_memory_id_key';

/**
 * #2476: true only for a P2002 on the Node `(loc, memory_id)` unique — the
 * cold-path loss of an `update: {}` ensure-upsert, where "the row exists" is
 * the promised post-condition (hrn:node:hadronmemory.com:dev:findings:prisma-upsert-not-race-safe).
 * Any other unique, a missing target, or a non-Prisma error is not that race.
 */
export function isNodeLocUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (target === NODE_LOC_UNIQUE_NAME) return true;
  if (!Array.isArray(target) || target.length !== 2) return false;
  return NODE_LOC_UNIQUE_COLUMNS.some((cols) => cols.every((c) => target.includes(c)));
}

/** The #992 per-chat message-seq partial unique index (raw SQL — see prisma/chat-seq-invariants.sql). */
const CHAT_SEQ_UNIQUE_NAME = 'nodes_chat_message_seq_unique_idx';

/**
 * The index's target as Prisma actually reports it (#2622, Gene P3-1): Prisma
 * splits the expression index's column list on commas, so the key
 * `(memory_id, split_part(loc, ':messages:', 1), seq)` arrives as these five
 * fragments — probed on a real P2002 from this index, not derived from
 * Prisma's docs. Spelled out so the detector can demand it EXACTLY.
 */
const CHAT_SEQ_UNIQUE_TARGET = [
  'memory_id', 'split_part(loc', `':messages:'::text`, '1)', 'seq',
] as const;

/** The refusal's human text, shared by the GraphQL mapping and the MCP refusal lines. */
export const CHAT_SEQ_CONFLICT_MESSAGE =
  'A chat message with this sequence number already exists in this chat.';

/**
 * #992 (cor:agt:020:04): true only for a P2002 on the per-chat message-seq
 * partial unique index — a canonical `chat-message` row whose (memory,
 * loc-derived chat, seq) is already taken, live OR soft-deleted. Prisma names
 * a raw partial index by its name or its real columns depending on the path,
 * so both spellings are accepted (same shape as the comments' one-open-thread
 * index). Any other unique, a missing target or a non-Prisma error is not it.
 */
export function isChatSeqUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = err.meta?.target;
    // Name spelling: some paths report a raw-SQL index by name.
    if (target === CHAT_SEQ_UNIQUE_NAME) return true;
    // Column spelling: the exact five fragments above — a plain
    // (memory_id, seq) pair is some OTHER unique and must not type as this
    // one (#2622: breadth here turns an unrelated failure into a misleading
    // CHAT_MESSAGE_SEQ_CONFLICT).
    if (Array.isArray(target)) {
      return target.length === CHAT_SEQ_UNIQUE_TARGET.length
        && CHAT_SEQ_UNIQUE_TARGET.every((c, i) => target[i] === c);
    }
    return JSON.stringify(target ?? {}).includes(CHAT_SEQ_UNIQUE_NAME);
  }
  // Raw PostgreSQL fallback (an error that lost its Prisma class): the name
  // alone is not enough — it must also read as a unique violation, so an
  // unrelated failure that merely MENTIONS the index does not match.
  return err instanceof Error
    && err.message.includes(CHAT_SEQ_UNIQUE_NAME)
    && /duplicate key value|unique constraint/i.test(err.message);
}

/**
 * The typed refusal for #992's uniqueness (#992's security rule: a
 * caller-visible refusal is a named surface and never leaks raw database
 * diagnostics). The message names the conflict without echoing any row.
 */
export function chatSeqConflictError(): GraphQLError {
  return new GraphQLError(
    CHAT_SEQ_CONFLICT_MESSAGE,
    { extensions: { code: 'CHAT_MESSAGE_SEQ_CONFLICT' } },
  );
}

/** Run a node/message write, surfacing #992's uniqueness violation as its typed refusal. */
export async function mapChatSeqConflict<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isChatSeqUniqueViolation(e)) throw chatSeqConflictError();
    throw e;
  }
}
