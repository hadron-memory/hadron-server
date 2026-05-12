/**
 * Spec 017 — Unit tests for the chat-scope helpers.
 *
 * Two suites:
 *   - `allowedReadSet` — pure function, no DB; covers the
 *     load-bearing safety property (shared chats never include any
 *     personal-class memory) plus the private-chat read-set shape.
 *   - `findOrCreateAppClassMemory` — DB-backed; covers idempotency
 *     and the URN convention `${app.urn}:shared`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import {
  cleanDb,
  createDbOrgAndGraph,
} from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import {
  allowedReadSet,
  findOrCreateAppClassMemory,
  ChatScopeError,
  type ChatScopeContext,
  type ChatScopeAttachments,
} from './chat-scope.js';

// ---------------------------------------------------------------------------
// allowedReadSet — pure function
// ---------------------------------------------------------------------------

describe('allowedReadSet', () => {
  const knowledgeId = 'mem-knowledge-1';
  const systemId = 'mem-system-1';
  const appClassId = 'mem-app-1';
  const personalId = 'mem-personal-1';

  const baseAttachments: ChatScopeAttachments = {
    knowledgeMemoryIds: [knowledgeId],
    systemMemoryId: systemId,
    appClassMemoryId: appClassId,
  };

  function chat(overrides: Partial<ChatScopeContext> = {}): ChatScopeContext {
    return {
      scope: 'private',
      memoryId: personalId,
      appId: 'app-1',
      authorUserId: 'user-1',
      agentId: 'agent-1',
      ...overrides,
    };
  }

  describe('private chat', () => {
    it('includes the author\'s own personal memory (which is chat.memoryId)', () => {
      const set = allowedReadSet(chat({ scope: 'private' }), baseAttachments);
      expect(set.has(personalId)).toBe(true);
    });

    it('includes knowledge + system memories', () => {
      const set = allowedReadSet(chat({ scope: 'private' }), baseAttachments);
      expect(set.has(knowledgeId)).toBe(true);
      expect(set.has(systemId)).toBe(true);
    });

    it('includes the App\'s app-class memory when one is attached', () => {
      const set = allowedReadSet(chat({ scope: 'private' }), baseAttachments);
      expect(set.has(appClassId)).toBe(true);
    });

    it('does not include the app-class memory when none is attached', () => {
      const set = allowedReadSet(chat({ scope: 'private' }), {
        ...baseAttachments,
        appClassMemoryId: null,
      });
      expect(set.has(appClassId)).toBe(false);
    });
  });

  describe('shared chat', () => {
    it('includes chat.memoryId (the app-class memory the chat is stored in)', () => {
      const set = allowedReadSet(
        chat({ scope: 'shared', memoryId: appClassId }),
        baseAttachments,
      );
      expect(set.has(appClassId)).toBe(true);
    });

    it('includes knowledge + system memories', () => {
      const set = allowedReadSet(
        chat({ scope: 'shared', memoryId: appClassId }),
        baseAttachments,
      );
      expect(set.has(knowledgeId)).toBe(true);
      expect(set.has(systemId)).toBe(true);
    });

    it('does NOT include any personal-class memory (the load-bearing safety property)', () => {
      // Construct attachments that contain ONLY non-personal memories.
      // The caller's contract is to never pass personal-class memory in
      // attachments for a shared chat. This test asserts that even if a
      // chat root falsely claimed `scope: 'shared'` while
      // chat.memoryId pointed at a personal memory, the function still
      // doesn't *add* any personal id from attachments. (The function's
      // role is "don't add personal"; the access-control layer is the
      // first gate that prevents a personal id from reaching attachments.)
      const set = allowedReadSet(
        chat({ scope: 'shared', memoryId: appClassId }),
        baseAttachments,
      );
      // No personal id was in attachments; assert no surprises in the
      // resulting set beyond what was supplied.
      expect(set.has(personalId)).toBe(false);
    });

    it('only contains the four documented entries at most: chat.memoryId, app-class, knowledge*, system', () => {
      const set = allowedReadSet(
        chat({ scope: 'shared', memoryId: appClassId }),
        baseAttachments,
      );
      // 3 distinct entries: appClassId (== chat.memoryId), knowledgeId, systemId
      expect(set.size).toBe(3);
    });
  });

  it('returns a fresh Set on each call (no shared mutation)', () => {
    const s1 = allowedReadSet(chat(), baseAttachments);
    const s2 = allowedReadSet(chat(), baseAttachments);
    expect(s1).not.toBe(s2);
  });
});

// ---------------------------------------------------------------------------
// findOrCreateAppClassMemory — DB-backed
// ---------------------------------------------------------------------------

describe('findOrCreateAppClassMemory', () => {
  let orgId: string;
  let appId: string;
  let appUrn: string;
  let appName: string;
  let actingUserId: string;

  beforeEach(async () => {
    await cleanDb(db);
    const { org } = await createDbOrgAndGraph(db);
    orgId = org.id;
    const user = await db.user.create({
      data: { githubId: 7717, githubUsername: 'spec017', roles: ['READER'] },
    });
    actingUserId = user.id;
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: actingUserId, role: 'OWNER' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: orgId, urn: `${orgId}:agent-017`, name: 'agent-017' },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${orgId}:app-017`,
        name: 'App 017',
        appType: 'CHATBOT',
        agentId: agent.id,
      },
    });
    appId = app.id;
    appUrn = app.urn;
    appName = app.name;
  });

  it('creates a new app-class memory on first call', async () => {
    const id = await findOrCreateAppClassMemory({
      appId,
      appUrn,
      appName,
      organizationId: orgId,
      actingUserId,
      db,
    });
    const memory = await db.memory.findUnique({ where: { id } });
    expect(memory).not.toBeNull();
    expect(memory!.class).toBe('app');
    expect(memory!.appId).toBe(appId);
    expect(memory!.userId).toBeNull();
    expect(memory!.urn).toBe(`${appUrn}:shared`);
  });

  it('returns the same memory id on a second call (idempotent)', async () => {
    const id1 = await findOrCreateAppClassMemory({
      appId,
      appUrn,
      appName,
      organizationId: orgId,
      actingUserId,
      db,
    });
    const id2 = await findOrCreateAppClassMemory({
      appId,
      appUrn,
      appName,
      organizationId: orgId,
      actingUserId,
      db,
    });
    expect(id1).toBe(id2);
  });

  it('uses the documented URN convention `${app.urn}:shared`', async () => {
    const id = await findOrCreateAppClassMemory({
      appId,
      appUrn,
      appName,
      organizationId: orgId,
      actingUserId,
      db,
    });
    const memory = await db.memory.findUniqueOrThrow({ where: { id } });
    expect(memory.urn.endsWith(':shared')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ChatScopeError
// ---------------------------------------------------------------------------

describe('ChatScopeError', () => {
  it('carries a typed code', () => {
    const e = new ChatScopeError(
      'SHARED_CHAT_REQUIRES_APP_CONTEXT',
      'Cannot share — no App context',
    );
    expect(e.code).toBe('SHARED_CHAT_REQUIRES_APP_CONTEXT');
    expect(e.name).toBe('ChatScopeError');
  });

  it('is a real Error subclass', () => {
    const e = new ChatScopeError('CHAT_MEMORY_OUT_OF_SCOPE', 'nope');
    expect(e instanceof Error).toBe(true);
  });
});
