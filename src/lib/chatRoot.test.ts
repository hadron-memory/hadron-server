/**
 * Serialized chat-root writes (#919).
 *
 * The regression this file exists for: `messageCount` was read off the chat
 * root, incremented in memory, used as the new message's `seq`, and written
 * back at the end of the turn. Two concurrent sends both read N and both used
 * N+1 — colliding `seq` (so transcript order between them was arbitrary, and
 * could differ between reads) and a permanently under-counted root.
 *
 * Real concurrency does not reliably reproduce that through the resolvers: the
 * calls' round-trips tend to serialize on their own, so a Promise.all test
 * passes with or without a fix. These tests instead hold the first
 * transaction OPEN — the second allocator is provably still waiting while the
 * first has neither committed nor released — which pins the property that
 * actually matters: the counter is read after the lock is granted, so an
 * allocation can never be based on a value another allocation has already
 * consumed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import {
  appendChatMessage,
  updateChatRootData,
  withChatRootLock,
  type ChatRootRef,
} from './chatRoot.js';

const CHAT_LOC = 'chats:202608091200-abcd1234-research';

let chat: ChatRootRef;
let memEnc: { id: string; isEncrypted: boolean };

/** Insert a message the way the resolvers do — on the allocator's tx. */
function insertMessage(suffix: string) {
  return async ({ tx, seq, msgNum }: {
    tx: Prisma.TransactionClient;
    seq: number;
    msgNum: string;
  }) => {
    await tx.node.create({
      data: {
        id: generateId(), memoryId: chat.memoryId,
        loc: `${chat.loc}:messages:${msgNum}-${suffix}`,
        name: `${msgNum}-${suffix}`,
        nodeType: 'record', content: `message ${msgNum}`, seq,
      },
    });
  };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'cr-org', urn: `cr-org-${generateId()}` },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `cr-mem-${generateId()}`,
      name: 'cr-mem', class: 'knowledge',
    },
  });
  memEnc = { id: memory.id, isEncrypted: false };
  const root = await db.node.create({
    data: {
      id: generateId(), memoryId: memory.id, loc: CHAT_LOC, name: 'chat',
      nodeType: 'record', data: { messageCount: 0, conversationName: 'research' },
    },
  });
  await db.node.create({
    data: {
      id: generateId(), memoryId: memory.id, loc: `${CHAT_LOC}:messages`,
      name: 'messages', nodeType: 'record',
    },
  });
  chat = { id: root.id, memoryId: memory.id, loc: CHAT_LOC };
});

async function storedChatData(): Promise<Record<string, unknown>> {
  const row = await db.node.findUniqueOrThrow({ where: { id: chat.id } });
  return (row.data as Record<string, unknown>) ?? {};
}

describe('appendChatMessage — the counter is allocated under the lock', () => {
  it('gives sequential senders distinct, contiguous numbers', async () => {
    const first = await appendChatMessage(db, chat, memEnc, insertMessage('user'));
    const second = await appendChatMessage(db, chat, memEnc, insertMessage('assistant'));
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect((await storedChatData()).messageCount).toBe(2);
  });

  it('makes a second allocator WAIT for an in-flight one, then read its result', async () => {
    // Hold the first allocation open inside its transaction. It has inserted
    // its message and holds the chat lock, but has not committed.
    let firstDone = false;
    let releaseFirst: () => void = () => {};
    let announceReached: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const firstReachedInsert = new Promise<void>((r) => { announceReached = r; });
    const first = appendChatMessage(db, chat, memEnc, async (args) => {
      await insertMessage('user')(args);
      announceReached();
      await gate;
    }).then((r) => { firstDone = true; return r; });
    await firstReachedInsert;

    // A second allocation starts while the first still holds the lock. Under
    // the pre-#919 code it would read `messageCount: 0` straight off the row
    // and allocate 1 — the collision. Here it blocks.
    let secondSeq: number | null = null;
    const second = appendChatMessage(db, chat, memEnc, insertMessage('assistant'))
      .then((r) => { secondSeq = r.seq; return r; });

    // Give it every chance to run ahead: it cannot.
    await new Promise((r) => setTimeout(r, 150));
    expect(secondSeq).toBeNull();
    expect(firstDone).toBe(false);

    releaseFirst();
    expect((await first).seq).toBe(1);
    const { seq } = await second;
    expect(seq).toBe(2);
    expect((await storedChatData()).messageCount).toBe(2);

    const messages = await db.node.findMany({
      where: { memoryId: chat.memoryId, loc: { startsWith: `${chat.loc}:messages:` } },
      orderBy: { seq: 'asc' },
    });
    expect(messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('rolls the number back with the insert — a failed turn consumes nothing', async () => {
    await appendChatMessage(db, chat, memEnc, insertMessage('user'));
    await expect(
      appendChatMessage(db, chat, memEnc, async () => {
        throw new Error('turn blew up');
      }),
    ).rejects.toThrow('turn blew up');
    // The failed allocation is not a hole in the sequence: the next message
    // takes the number it would have used.
    const next = await appendChatMessage(db, chat, memEnc, insertMessage('assistant'));
    expect(next.seq).toBe(2);
    expect((await storedChatData()).messageCount).toBe(2);
  });

  it('preserves the rest of the blob it did not touch', async () => {
    await appendChatMessage(db, chat, memEnc, insertMessage('user'));
    const data = await storedChatData();
    expect(data.conversationName).toBe('research');
    expect(data.lastMessageAt).toEqual(expect.any(String));
  });
});

describe('updateChatRootData — a late write applies to fresh data', () => {
  it('does not roll back a count that committed while the turn ran', async () => {
    // A turn allocates message 1 …
    const turn = await appendChatMessage(db, chat, memEnc, insertMessage('assistant'));
    expect(turn.seq).toBe(1);
    // … a send lands while that turn is still evaluating edges …
    await appendChatMessage(db, chat, memEnc, insertMessage('user'));
    // … and only then does the turn write its stage transition.
    await updateChatRootData(db, chat, memEnc, (fresh) => ({
      ...fresh,
      stageName: 'analysis',
    }));

    const data = await storedChatData();
    expect(data.stageName).toBe('analysis');
    // Pre-#919 the turn wrote back the blob it read at its start, silently
    // reverting the count to 1 — and the NEXT message would then reuse seq 2.
    expect(data.messageCount).toBe(2);
  });

  it('serializes two concurrent read-modify-writes so neither is lost', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        updateChatRootData(db, chat, memEnc, (fresh) => ({
          ...fresh,
          edits: ((fresh.edits as number) ?? 0) + 1,
        })),
      ),
    );
    expect((await storedChatData()).edits).toBe(5);
  });
});

describe('withChatRootLock', () => {
  it('leaves the chat root untouched when the body returns no data', async () => {
    const before = await storedChatData();
    const value = await withChatRootLock(db, chat, memEnc, async ({ chatData }) => ({
      value: chatData.conversationName,
    }));
    expect(value).toBe('research');
    expect(await storedChatData()).toEqual(before);
  });

  it('throws when the chat root is gone', async () => {
    await expect(
      withChatRootLock(db, { ...chat, id: generateId() }, memEnc, async () => ({ value: null })),
    ).rejects.toThrow(/not found/);
  });
});

describe('#992 — allocation is self-healing against direct message writes', () => {
  /** Write a message node the way a bulk import / `node clone` does: directly,
   *  at a chosen seq, without going through the allocator. */
  async function directMessage(seq: number, nodeType = 'chat-message') {
    await db.node.create({
      data: {
        id: generateId(), memoryId: chat.memoryId,
        loc: `${chat.loc}:messages:${String(seq).padStart(3, '0')}-imported`,
        name: `${String(seq).padStart(3, '0')}-imported`,
        nodeType, content: `imported ${seq}`, seq,
      },
    });
  }

  it('does not reissue a seq an imported message already occupies', async () => {
    // The reported repro, minimised: counter says 2, an archive occupies 1..142.
    await appendChatMessage(db, chat, memEnc, insertMessage('a'));
    await appendChatMessage(db, chat, memEnc, insertMessage('b'));
    expect((await storedChatData()).messageCount).toBe(2);
    for (const n of [3, 4, 5, 142]) await directMessage(n);

    const next = await appendChatMessage(db, chat, memEnc, insertMessage('after-import'));
    expect(next.seq).toBe(143);
  });

  it('heals the counter, so the jump happens once and not on every post', async () => {
    await directMessage(142);
    const first = await appendChatMessage(db, chat, memEnc, insertMessage('x'));
    const second = await appendChatMessage(db, chat, memEnc, insertMessage('y'));
    expect([first.seq, second.seq]).toEqual([143, 144]);
    expect((await storedChatData()).messageCount).toBe(144);
  });

  it('never reuses a SOFT-DELETED message\'s seq', async () => {
    // Monotonicity: a citation to seq N must mean one thing forever, which is
    // also why the counter deliberately does not decrement on delete.
    await appendChatMessage(db, chat, memEnc, insertMessage('doomed'));
    await db.node.updateMany({
      where: { memoryId: chat.memoryId, loc: { startsWith: `${chat.loc}:messages:` } },
      data: { deletedAt: new Date() },
    });
    const next = await appendChatMessage(db, chat, memEnc, insertMessage('after-delete'));
    expect(next.seq).toBe(2);
  });

  it('does NOT count an auto-summary — it would inflate the routing counter', async () => {
    // saveChatSummary writes an `abstract` node under the same :messages:
    // prefix at seq = messageCount + 1, and deliberately leaves the counter
    // alone because a summary is not a message. Counting it would absorb that
    // slot into messageCount on the next post, and messageCount drives the
    // summarization trigger and the chat.message_count edge condition — so the
    // drift changes routing, not just numbering (PR #998 review, Codex P1).
    await appendChatMessage(db, chat, memEnc, insertMessage('a'));
    await directMessage(2, 'abstract'); // the summary's slot
    const next = await appendChatMessage(db, chat, memEnc, insertMessage('b'));
    expect(next.seq).toBe(2);
    expect((await storedChatData()).messageCount).toBe(2);
  });

  it('does not count an off-road non-message nodeType', async () => {
    // Same rule, generalized: only actual message types occupy a number.
    await directMessage(9, 'note');
    const next = await appendChatMessage(db, chat, memEnc, insertMessage('z'));
    expect(next.seq).toBe(1);
  });

  it('counts BOTH message nodeTypes — team chat and the chatbot path', async () => {
    await directMessage(4, 'chat-message');
    await directMessage(7, 'record');
    const next = await appendChatMessage(db, chat, memEnc, insertMessage('z'));
    expect(next.seq).toBe(8);
  });

  it('ignores a node OUTSIDE the messages container', async () => {
    // Sibling branches of the chat root must not inflate the allocator.
    await db.node.create({
      data: {
        id: generateId(), memoryId: chat.memoryId,
        loc: `${chat.loc}:summary`, name: 'summary', nodeType: 'record', seq: 500,
      },
    });
    const next = await appendChatMessage(db, chat, memEnc, insertMessage('q'));
    expect(next.seq).toBe(1);
  });

  it('is unaffected by another chat in the same memory', async () => {
    const otherLoc = 'chats:202608091200-ffff9999-other';
    await db.node.create({
      data: {
        id: generateId(), memoryId: chat.memoryId,
        loc: `${otherLoc}:messages:900-x`, name: '900-x',
        nodeType: 'chat-message', seq: 900,
      },
    });
    const next = await appendChatMessage(db, chat, memEnc, insertMessage('r'));
    expect(next.seq).toBe(1);
  });
});
