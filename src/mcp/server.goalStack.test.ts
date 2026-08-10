/**
 * hadron_chatbot_push_goal / hadron_chatbot_pop_goal (#919).
 *
 * Both tools read the chat root, edit the goal stack in memory, and write the
 * whole blob back. The chat root is ALSO where `messageCount` lives — the value
 * a chat turn allocates its message `seq` from — so a read-modify-write here
 * that spans a turn silently reverts it. And both used to write `data` without
 * decrypting it first, which on an encrypted memory means writing a goal stack
 * next to the ciphertext wrapper, where the next decrypt drops it.
 *
 * These tools had no test at all. These pin the two properties that make the
 * shared serializer the right home for them: whatever else is in the blob
 * survives a goal edit, and an encrypted chat root round-trips.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const CHAT_LOC = 'chats:202608091200-abcd1234-research';
const PASS = 'goal stack passphrase';

let owner: { id: string };
let memoryId: string;
let memoryUrn: string;
let appId: string;

/** An App-scoped principal — these tools are spec-026 strict tools. */
const ownerAuth = (): AuthContext => ({
  userId: owner.id,
  roles: ['ADMIN'],
  clientId: `user:${owner.id}`,
  appId,
});

function mcp(auth: AuthContext = ownerAuth()) {
  return createTestableMcpServer(auth, { sessionId: 'gs-sess' });
}

async function makeChatRoot(data: Record<string, unknown>) {
  return db.node.create({
    data: {
      id: generateId(), memoryId, loc: CHAT_LOC, name: 'chat',
      nodeType: 'record', createdBy: owner.id, data: data as never,
    },
  });
}

async function storedData(id: string): Promise<Record<string, unknown>> {
  const row = await db.node.findUniqueOrThrow({ where: { id } });
  return (row.data as Record<string, unknown>) ?? {};
}

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const org = await db.organization.create({
    data: { id: generateId(), name: 'gs-org', urn: `gs-org-${generateId()}` },
  });
  owner = await db.user.create({
    data: { githubId: 9801, githubUsername: 'gs-owner', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' },
  });
  const app = await db.app.create({
    data: {
      id: generateId(), name: 'gs-app', urn: `gs-app-${generateId()}`,
      organizationId: org.id,
    },
  });
  appId = app.id;
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `gs-mem-${generateId()}`,
      name: 'gs-mem', class: 'private', userId: owner.id, createdBy: owner.id,
    },
  });
  memoryId = memory.id;
  memoryUrn = memory.urn;
});

afterEach(() => sessionKeyCache.clear());

describe('hadron_chatbot_push_goal / pop_goal', () => {
  it('pushes and pops without disturbing the rest of the chat root', async () => {
    const chat = await makeChatRoot({
      messageCount: 7,
      conversationName: 'research',
      stageName: 'scope',
    });
    const srv = mcp();

    expect(await srv.callToolText('hadron_chatbot_push_goal', {
      chatId: CHAT_LOC,
      description: 'check the sources',
    })).toContain('Goal pushed');

    let data = await storedData(chat.id);
    const stack = data.goalStack as Array<Record<string, unknown>>;
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({
      description: 'check the sources',
      createdBy: 'ASSISTANT',
      status: 'ACTIVE',
      conversationUrn: 'conversations:research',
      nodeUrn: 'conversations:research:scope',
    });
    // The counter a chat turn allocates its `seq` from is untouched by a goal
    // edit — this write no longer replays a whole stale blob over it.
    expect(data.messageCount).toBe(7);

    expect(await srv.callToolText('hadron_chatbot_pop_goal', { chatId: CHAT_LOC }))
      .toContain('Goal completed');

    data = await storedData(chat.id);
    const after = data.goalStack as Array<Record<string, unknown>>;
    expect(after[0].status).toBe('COMPLETED');
    expect(after[0].completedAt).toEqual(expect.any(String));
    expect(data.messageCount).toBe(7);
    expect(data.conversationName).toBe('research');
  });

  it('reports when there is nothing to pop', async () => {
    await makeChatRoot({ messageCount: 0 });
    expect(await mcp().callToolText('hadron_chatbot_pop_goal', { chatId: CHAT_LOC }))
      .toContain('No active goals');
  });

  it('round-trips an ENCRYPTED chat root instead of writing past the ciphertext', async () => {
    const chat = await makeChatRoot({ messageCount: 3, conversationName: 'research' });
    // Encrypt through the real conversion path so the envelope is exactly what
    // production writes, then unlock the way a session does.
    await resolvers.Mutation.encryptMemory(
      {},
      { memoryId, passphrase: PASS },
      { db, roles: ['ADMIN'], userId: owner.id } as Context,
    );
    const srv = mcp();
    expect(await srv.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS }))
      .toContain('unlocked');

    expect(await srv.callToolText('hadron_chatbot_push_goal', {
      chatId: CHAT_LOC, description: 'encrypted goal',
    })).toContain('Goal pushed');

    // On disk it is still one opaque envelope — no plaintext goal alongside it.
    expect(Object.keys(await storedData(chat.id))).toEqual(['__enc']);

    // And the push wrote the pre-existing fields back inside the envelope: the
    // pop can only find the goal if it survived the round trip.
    expect(await srv.callToolText('hadron_chatbot_pop_goal', { chatId: CHAT_LOC }))
      .toContain('encrypted goal');
  });
});
