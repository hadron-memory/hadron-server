/**
 * Serialized read-modify-write of a chat's root `data` blob (#919).
 *
 * A chat root carries `messageCount`, and every message node's `seq` — the
 * ordering key every transcript reader sorts on — is derived from it. That made
 * the counter a classic non-atomic read-modify-write: each send read `N` off the
 * root, derived `N+1` in memory, used it for the insert, and wrote it back at
 * the end of the turn. Two concurrent sends both read `N`, so both messages got
 * the same `seq` (arbitrary, and inconsistent-between-reads transcript order)
 * and the count settled at `N+1` instead of `N+2`, permanently. That mattered
 * once a chat in a multi-human memory became a genuine group chat — participation
 * follows the host memory, so several members post into one chat
 * (`cor:acl:030:01`). The count is not cosmetic either: it drives the
 * summarization trigger and the `chat.message_count` edge-condition operand, so
 * drift changes routing.
 *
 * The fix is to allocate under a lock the write already takes. A message create
 * locks its ancestor path (#664/#752 — so a concurrent ancestor delete can't
 * orphan it), and the chat root IS one of those ancestors. That lock therefore
 * already serializes every message write on a chat against every other; it just
 * ran too late to protect the counter, which was read before the transaction
 * opened. Moving the read inside — and writing the count back in the same
 * transaction — makes allocation atomic without introducing a second lock
 * ordering, and per-chat serialization is the natural granularity: turns in one
 * conversation are one-at-a-time in practice, and chats never contend with each
 * other.
 *
 * This narrows WHEN a member may post, never WHO may: the lock is held for one
 * insert, and nothing here consults the caller's identity. Restricting sends to
 * one member at a time is fine; restricting them to one member would be a
 * contract change (`cor:acl:030:01`).
 *
 * A second, subtler way to lose the count: the blob is written whole. A turn
 * that read the root at its start and writes it back at its end rolls back
 * anything that committed in between — so `updateChatRootData` re-reads under
 * the lock and hands the caller the FRESH blob to apply its changes to, rather
 * than letting a stale in-memory copy win. Callers must therefore express a turn
 * as changes-to-apply, not as a finished object built from a pre-turn read.
 *
 * Every function here runs at READ COMMITTED (Prisma's default): the lock-then-
 * read pattern needs a snapshot taken AFTER the lock is granted, which a frozen
 * REPEATABLE READ / SERIALIZABLE snapshot would not give.
 */
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import type { InputJsonValue } from '../generated/prisma/runtime/library.js';
import {
  decryptNodeFields,
  encryptNodeFields,
  type MemoryEncryptionInfo,
} from './nodeCrypto.js';
import { lockPathForCreateUnder } from './nodeSubtreeLock.js';

/** The chat-root node a write is serialized against. */
export interface ChatRootRef {
  id: string;
  memoryId: string;
  /** The chat's loc — the "chatId" its messages hang under. */
  loc: string;
}

/**
 * What {@link withChatRootLock} should do once `body` returns: write `chatData`
 * back to the chat root (encrypted when the memory is), or leave the root
 * untouched when it is omitted. `value` is returned to the caller.
 */
export interface ChatRootOutcome<T> {
  chatData?: Record<string, unknown>;
  value: T;
}

/**
 * Run `body` in one transaction with the chat's write lock held and the chat
 * root's decrypted `data` freshly read under it.
 *
 * The lock is the ancestor-path lock a create under `<chat>:messages` takes, so
 * this contends with every chat-message insert — and with every other holder of
 * this lock — exactly as intended.
 */
export async function withChatRootLock<T>(
  db: PrismaClient,
  chat: ChatRootRef,
  memEncInfo: MemoryEncryptionInfo,
  body: (args: {
    tx: Prisma.TransactionClient;
    chatData: Record<string, unknown>;
  }) => Promise<ChatRootOutcome<T>>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await lockPathForCreateUnder(tx, chat.memoryId, `${chat.loc}:messages`);
    // Read AFTER the lock: at READ COMMITTED this statement takes a fresh
    // snapshot, so it sees whatever committed while we waited to be granted it.
    const row = await tx.node.findUnique({
      where: { id: chat.id },
      select: { data: true },
    });
    if (!row) throw new Error(`Chat "${chat.loc}" not found`);
    const decrypted = decryptNodeFields({ data: row.data }, memEncInfo);
    const chatData = (decrypted.data as Record<string, unknown> | null) ?? {};

    const outcome = await body({ tx, chatData });

    if (outcome.chatData) {
      const enc = encryptNodeFields(
        { content: null, data: outcome.chatData },
        memEncInfo,
      );
      await tx.node.update({
        where: { id: chat.id },
        data: { data: (enc.data ?? null) as InputJsonValue },
      });
    }
    return outcome.value;
  });
}

/**
 * Allocate the next message number for a chat and insert the message in the
 * same transaction — the ONLY way a chat message should be written.
 *
 * `insert` receives the allocated `seq`, its zero-padded `msgNum` (the numeric
 * prefix of the message's name), the freshly-read `chatData`, and the
 * transaction to insert on. It must use that `tx`: an insert on `db` would land
 * outside the lock and outside the allocation's atomicity.
 *
 * On commit the chat root carries the new `messageCount` and `lastMessageAt`,
 * so the next allocator reads a count that already includes this message.
 */
export async function appendChatMessage<T>(
  db: PrismaClient,
  chat: ChatRootRef,
  memEncInfo: MemoryEncryptionInfo,
  insert: (args: {
    tx: Prisma.TransactionClient;
    seq: number;
    msgNum: string;
    chatData: Record<string, unknown>;
  }) => Promise<T>,
): Promise<{ seq: number; chatData: Record<string, unknown>; inserted: T }> {
  return withChatRootLock(db, chat, memEncInfo, async ({ tx, chatData }) => {
    const seq = ((chatData.messageCount as number) ?? 0) + 1;
    const inserted = await insert({
      tx,
      seq,
      msgNum: String(seq).padStart(3, '0'),
      chatData,
    });
    const next = {
      ...chatData,
      messageCount: seq,
      lastMessageAt: new Date().toISOString(),
    };
    return { chatData: next, value: { seq, chatData: next, inserted } };
  });
}

/**
 * Apply changes to a chat root's `data` under the lock, against a freshly read
 * blob.
 *
 * `apply` receives the current data and returns what to store — so a turn that
 * began minutes ago contributes its CHANGES rather than replaying a stale
 * snapshot over whatever committed since. Returns the stored object.
 */
export async function updateChatRootData(
  db: PrismaClient,
  chat: ChatRootRef,
  memEncInfo: MemoryEncryptionInfo,
  apply: (chatData: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withChatRootLock(db, chat, memEncInfo, async ({ chatData }) => {
    const next = apply(chatData);
    return { chatData: next, value: next };
  });
}
