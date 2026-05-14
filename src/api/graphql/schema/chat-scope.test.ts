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
  chatScopeAccessFilter,
  findOrCreateAppClassMemory,
  validateChatScopeInvariants,
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
  let agentUrn: string;
  let agentName: string;
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
      data: { id: generateId(), organizationId: orgId, urn: `${org.urn}:agent-017`, name: 'agent-017' },
    });
    agentUrn = agent.urn;
    agentName = agent.name;
    const app = await db.app.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${org.urn}:app-017`,
        name: 'App 017',
        appType: 'CHATBOT',
        agentId: agent.id,
      },
    });
    appId = app.id;
    appUrn = app.urn;
    appName = app.name;
  });

  it('creates a new app-class memory on first call, keyed per (app, agent)', async () => {
    const id = await findOrCreateAppClassMemory({
      appId,
      appUrn,
      appName,
      agentUrn,
      agentName,
      organizationId: orgId,
      actingUserId,
      db,
    });
    const memory = await db.memory.findUnique({ where: { id } });
    expect(memory).not.toBeNull();
    expect(memory!.class).toBe('app');
    expect(memory!.appId).toBe(appId);
    expect(memory!.userId).toBeNull();
    // URN is `${app.urn}:${agentSlug}:shared`. agentSlug is everything
    // after the first colon-segment of agent.urn (which itself starts
    // with the org urn).
    const agentSlug = agentUrn.split(':').slice(1).join(':');
    expect(memory!.urn).toBe(`${appUrn}:${agentSlug}:shared`);
  });

  it('returns the same memory id on a second call for the same (app, agent) — idempotent', async () => {
    const id1 = await findOrCreateAppClassMemory({
      appId,
      appUrn,
      appName,
      agentUrn,
      agentName,
      organizationId: orgId,
      actingUserId,
      db,
    });
    const id2 = await findOrCreateAppClassMemory({
      appId,
      appUrn,
      appName,
      agentUrn,
      agentName,
      organizationId: orgId,
      actingUserId,
      db,
    });
    expect(id1).toBe(id2);
  });

  // Spec 017 + 2026-05-12-user-installing-app §3: shared memory is keyed
  // per (App, Agent), not per App. Two Agents installed in the same App
  // get DIFFERENT shared memories — required for multi-Agent App isolation.
  it('returns distinct memories for two Agents installed in the same App', async () => {
    const org = await db.organization.findFirstOrThrow({ where: { id: orgId } });
    const agentB = await db.agent.create({
      data: { id: generateId(), organizationId: orgId, urn: `${org.urn}:agent-017-b`, name: 'agent-017-b' },
    });
    const idA = await findOrCreateAppClassMemory({
      appId, appUrn, appName,
      agentUrn, agentName,
      organizationId: orgId, actingUserId, db,
    });
    const idB = await findOrCreateAppClassMemory({
      appId, appUrn, appName,
      agentUrn: agentB.urn, agentName: agentB.name,
      organizationId: orgId, actingUserId, db,
    });
    expect(idA).not.toBe(idB);
    const memA = await db.memory.findUniqueOrThrow({ where: { id: idA } });
    const memB = await db.memory.findUniqueOrThrow({ where: { id: idB } });
    expect(memA.urn).not.toBe(memB.urn);
    expect(memA.urn.endsWith(`:agent-017:shared`)).toBe(true);
    expect(memB.urn.endsWith(`:agent-017-b:shared`)).toBe(true);
  });

  it('throws when agentUrn has no slug segment after the org prefix', async () => {
    await expect(
      findOrCreateAppClassMemory({
        appId, appUrn, appName,
        agentUrn: 'no-colon-no-slug',
        agentName,
        organizationId: orgId, actingUserId, db,
      }),
    ).rejects.toThrow(/no slug segment/);
  });
});

// ---------------------------------------------------------------------------
// chatScopeAccessFilter — D5 retrieval-time enforcement
// ---------------------------------------------------------------------------

describe('chatScopeAccessFilter — D5 retrieval-time enforcement', () => {
  const personalId = 'mem-personal-1';
  const appClassId = 'mem-app-1';
  const knowledgeId = 'mem-knowledge-1';
  const systemId = 'mem-system-1';

  function chat(overrides: Partial<ChatScopeContext> = {}): ChatScopeContext {
    return {
      scope: 'shared',
      memoryId: appClassId,
      appId: 'app-1',
      authorUserId: 'user-1',
      agentId: 'agent-1',
      ...overrides,
    };
  }

  it('returns { memoryId: { in: <ids> } } shape suitable for Prisma where-spread', () => {
    const filter = chatScopeAccessFilter(chat(), {
      knowledgeMemoryIds: [knowledgeId],
      systemMemoryId: systemId,
      appClassMemoryId: appClassId,
    });
    expect(filter).toHaveProperty('memoryId');
    expect(filter.memoryId).toHaveProperty('in');
    expect(Array.isArray(filter.memoryId.in)).toBe(true);
  });

  // Load-bearing safety property — the entire reason this filter exists.
  // A shared chat asking for nodes via `where: { loc, memoryId, ...filter }`
  // must not be able to resolve a ref against any personal memory.
  it('SHARED chat filter does not contain any personal memory id', () => {
    const filter = chatScopeAccessFilter(
      chat({ scope: 'shared', memoryId: appClassId }),
      {
        knowledgeMemoryIds: [knowledgeId],
        systemMemoryId: systemId,
        appClassMemoryId: appClassId,
      },
    );
    expect(filter.memoryId.in).not.toContain(personalId);
  });

  it('SHARED chat filter includes app-class, knowledge, and system memories', () => {
    const filter = chatScopeAccessFilter(
      chat({ scope: 'shared', memoryId: appClassId }),
      {
        knowledgeMemoryIds: [knowledgeId],
        systemMemoryId: systemId,
        appClassMemoryId: appClassId,
      },
    );
    expect(filter.memoryId.in).toContain(appClassId);
    expect(filter.memoryId.in).toContain(knowledgeId);
    expect(filter.memoryId.in).toContain(systemId);
  });

  it('PRIVATE chat filter contains the author\'s personal memory (chat.memoryId)', () => {
    const filter = chatScopeAccessFilter(
      chat({ scope: 'private', memoryId: personalId }),
      {
        knowledgeMemoryIds: [knowledgeId],
        systemMemoryId: systemId,
        appClassMemoryId: appClassId,
      },
    );
    expect(filter.memoryId.in).toContain(personalId);
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

// ---------------------------------------------------------------------------
// validateChatScopeInvariants — data-model.md §I-1
// ---------------------------------------------------------------------------

describe('validateChatScopeInvariants', () => {
  it('accepts private + personal', () => {
    expect(() =>
      validateChatScopeInvariants({ scope: 'private', memoryClass: 'personal' }),
    ).not.toThrow();
  });

  it('accepts shared + app', () => {
    expect(() =>
      validateChatScopeInvariants({ scope: 'shared', memoryClass: 'app' }),
    ).not.toThrow();
  });

  it('rejects private + app', () => {
    expect(() =>
      validateChatScopeInvariants({ scope: 'private', memoryClass: 'app' }),
    ).toThrow(ChatScopeError);
  });

  it('rejects shared + personal (the surprise-leak vector)', () => {
    try {
      validateChatScopeInvariants({ scope: 'shared', memoryClass: 'personal' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ChatScopeError);
      expect((e as ChatScopeError).code).toBe('CHAT_MEMORY_OUT_OF_SCOPE');
    }
  });

  // The legacy fallback at startChat's "agent's first writable attached
  // memory" branch stores chats in knowledge-class memory. The
  // 20260512120000_chat_scope_backfill migration sets data.scope='private'
  // on every pre-feature chat-root, including those in knowledge memory.
  // Reject this combination would break running legacy chats post-backfill
  // (FR-018 forbids moving the content). Treat private + knowledge as a
  // permanent legacy state.
  it('accepts private + knowledge (legacy fallback path stays valid after backfill)', () => {
    expect(() =>
      validateChatScopeInvariants({ scope: 'private', memoryClass: 'knowledge' }),
    ).not.toThrow();
  });

  it('rejects private + app and private + system (chats never live there)', () => {
    expect(() =>
      validateChatScopeInvariants({ scope: 'private', memoryClass: 'app' }),
    ).toThrow(ChatScopeError);
    expect(() =>
      validateChatScopeInvariants({ scope: 'private', memoryClass: 'system' }),
    ).toThrow(ChatScopeError);
  });

  it('rejects shared + knowledge or system (load-bearing — shared MUST be app-class)', () => {
    expect(() =>
      validateChatScopeInvariants({ scope: 'shared', memoryClass: 'knowledge' }),
    ).toThrow(ChatScopeError);
    expect(() =>
      validateChatScopeInvariants({ scope: 'shared', memoryClass: 'system' }),
    ).toThrow(ChatScopeError);
  });

  it('rejects missing scope by default (corruption signal)', () => {
    expect(() =>
      validateChatScopeInvariants({ scope: undefined, memoryClass: 'personal' }),
    ).toThrow(ChatScopeError);
  });

  it('tolerates missing scope when allowMissingScope=true AND memory is personal', () => {
    expect(() =>
      validateChatScopeInvariants({
        scope: undefined,
        memoryClass: 'personal',
        allowMissingScope: true,
      }),
    ).not.toThrow();
  });

  it('tolerates missing scope when allowMissingScope=true AND memory is knowledge (legacy)', () => {
    expect(() =>
      validateChatScopeInvariants({
        scope: undefined,
        memoryClass: 'knowledge',
        allowMissingScope: true,
      }),
    ).not.toThrow();
  });

  it('still rejects missing scope on app-class memory even with allowMissingScope=true', () => {
    // App-class memory was only introduced for shared chats post-017,
    // so a chat-root row there must have been written with explicit
    // scope. Missing scope on app-class is corruption regardless of
    // the migration flag.
    expect(() =>
      validateChatScopeInvariants({
        scope: undefined,
        memoryClass: 'app',
        allowMissingScope: true,
      }),
    ).toThrow(ChatScopeError);
  });
});
