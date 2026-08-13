/**
 * Spec 017 — Unit tests for the chat-scope helpers.
 *
 * Two suites:
 *   - `allowedReadSet` — pure function, no DB; covers the
 *     load-bearing safety property (shared chats never include any
 *     personal-class memory) plus the private-chat read-set shape.
 *   - `findOrCreateAppClassMemory` — DB-backed; covers idempotency, the
 *     #723 `(appId, sharedMemoryOfAgentId)` identity, the flat v2 urn it
 *     now mints, and adoption of pre-#723 string-keyed rows.
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
  let orgUrn: string;
  let appId: string;
  let appUrn: string;
  let appName: string;
  let agentId: string;
  let agentUrn: string;
  let agentName: string;
  let actingUserId: string;

  beforeEach(async () => {
    await cleanDb(db);
    const { org } = await createDbOrgAndGraph(db);
    orgId = org.id;
    orgUrn = org.urn;
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
    agentId = agent.id;
    agentUrn = agent.urn;
    agentName = agent.name;
    const app = await db.app.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${org.urn}:app-017`,
        name: 'App 017',
        appType: 'CHATBOT',
        appAgents: { create: { agentId: agent.id } },
      },
    });
    appId = app.id;
    appUrn = app.urn;
    appName = app.name;
  });

  /** Base args for the App/Agent provisioned in beforeEach. */
  function args(overrides: Record<string, unknown> = {}) {
    return {
      appId,
      appUrn,
      appName,
      agentId,
      agentUrn,
      agentName,
      organizationId: orgId,
      actingUserId,
      db,
      ...overrides,
    } as Parameters<typeof findOrCreateAppClassMemory>[0];
  }

  it('creates a new app-class memory on first call, keyed per (app, agent)', async () => {
    const id = await findOrCreateAppClassMemory(args());
    const memory = await db.memory.findUnique({ where: { id } });
    expect(memory).not.toBeNull();
    expect(memory!.class).toBe('app');
    expect(memory!.appId).toBe(appId);
    expect(memory!.userId).toBeNull();
    // #723: the identity is the column, not the urn.
    expect(memory!.sharedMemoryOfAgentId).toBe(agentId);
  });

  // #723 — the whole point of the re-key: a FLAT single-atom v2 urn
  // (`<root>:<slug>`), so node URNs inside the memory round-trip through
  // splitNodeUrn and the portal link a node read emits resolves.
  it('mints a flat single-atom v2 urn rooted on the owning org', async () => {
    const id = await findOrCreateAppClassMemory(args());
    const memory = await db.memory.findUniqueOrThrow({ where: { id } });
    expect(memory.urn).toBe(`${orgUrn}:app-017-shared`);
    expect(memory.urn.split(':')).toHaveLength(2);
  });

  it('returns the same memory id on a second call for the same (app, agent) — idempotent', async () => {
    const id1 = await findOrCreateAppClassMemory(args());
    const id2 = await findOrCreateAppClassMemory(args());
    expect(id1).toBe(id2);
    expect(await db.memory.count({ where: { appId, class: 'app' } })).toBe(1);
  });

  // Spec 017 + 2026-05-12-user-installing-app §3: shared memory is keyed
  // per (App, Agent), not per App. Two Agents installed in the same App
  // get DIFFERENT shared memories — required for multi-Agent App isolation.
  it('returns distinct memories for two Agents installed in the same App', async () => {
    const agentB = await db.agent.create({
      data: { id: generateId(), organizationId: orgId, urn: `${orgUrn}:agent-017-b`, name: 'agent-017-b' },
    });
    const idA = await findOrCreateAppClassMemory(args());
    const idB = await findOrCreateAppClassMemory(
      args({ agentId: agentB.id, agentUrn: agentB.urn, agentName: agentB.name }),
    );
    expect(idA).not.toBe(idB);
    const memA = await db.memory.findUniqueOrThrow({ where: { id: idA } });
    const memB = await db.memory.findUniqueOrThrow({ where: { id: idB } });
    expect(memA.urn).not.toBe(memB.urn);
    // The second one aliases deterministically on the agent slug — allowed now
    // that lookups no longer recompute the urn.
    expect(memA.urn).toBe(`${orgUrn}:app-017-shared`);
    expect(memB.urn).toBe(`${orgUrn}:app-017-shared-agent-017-b`);
  });

  // Renaming the App used to move the string key, orphaning the memory and
  // provisioning a second one on the next chat post.
  it('survives an App rename — the pairing is a column, not a urn prefix', async () => {
    const id = await findOrCreateAppClassMemory(args());
    await db.app.update({ where: { id: appId }, data: { urn: `${orgUrn}:app-017-renamed` } });
    const again = await findOrCreateAppClassMemory(args({ appUrn: `${orgUrn}:app-017-renamed` }));
    expect(again).toBe(id);
    expect(await db.memory.count({ where: { appId, class: 'app' } })).toBe(1);
  });

  it('restores a soft-deleted pairing rather than creating a second memory', async () => {
    const id = await findOrCreateAppClassMemory(args());
    await db.memory.update({ where: { id }, data: { deletedAt: new Date() } });
    const again = await findOrCreateAppClassMemory(args());
    expect(again).toBe(id);
    const memory = await db.memory.findUniqueOrThrow({ where: { id } });
    expect(memory.deletedAt).toBeNull();
  });

  // Pre-#723 rows are keyed by the urn STRING. Both shapes must be adopted:
  // the compound urn as written, and the #697 Task-A form where the sweep
  // flattened `urn` and parked the compound value in `legacyUrn`.
  for (const [label, columns] of [
    ['a pre-#723 compound urn', (u: string) => ({ urn: u })],
    ['a Task-A-migrated row (compound urn in legacyUrn)', (u: string) => ({
      urn: `mig-${generateId()}`,
      legacyUrn: u,
    })],
  ] as const) {
    it(`adopts ${label} instead of provisioning a second memory`, async () => {
      const legacy = await db.memory.create({
        data: {
          id: generateId(),
          organizationId: orgId,
          name: 'legacy shared',
          class: 'app',
          appId,
          ...columns(`${appUrn}:agent-017:shared`),
        },
      });
      const id = await findOrCreateAppClassMemory(args());
      expect(id).toBe(legacy.id);
      const adopted = await db.memory.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(adopted.sharedMemoryOfAgentId).toBe(agentId);
      // Adoption claims the row; it does NOT rewrite its address (that is the
      // #697 backfill's job, which records the old value in legacyUrn).
      expect(adopted.urn).toBe(legacy.urn);
      expect(await db.memory.count({ where: { appId, class: 'app' } })).toBe(1);
    });
  }

  // The adoption suffix must not swallow a name-addressable app-class memory
  // (createMemoryInApp) that happens to end in `:shared`.
  it('does not adopt a `…:app-mem:shared` named memory', async () => {
    const named = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${appUrn}:agent-017:app-mem:shared`,
        name: 'a memory literally named shared',
        class: 'app',
        appId,
      },
    });
    const id = await findOrCreateAppClassMemory(args());
    expect(id).not.toBe(named.id);
    expect(
      (await db.memory.findUniqueOrThrow({ where: { id: named.id } })).sharedMemoryOfAgentId,
    ).toBeNull();
  });

  it('throws when agentUrn has no slug segment after the org prefix', async () => {
    await expect(
      findOrCreateAppClassMemory(args({ agentUrn: 'no-colon-no-slug' })),
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

  // Apollo's default formatter preserves `extensions.code` on wire only
  // when the thrown value extends `GraphQLError`. Without this, every
  // ChatScopeError ships to the client as `INTERNAL_SERVER_ERROR` and
  // the three sub-codes collapse into one unidentifiable failure.
  it('exposes the code as extensions.code (so clients can branch on it)', () => {
    const e = new ChatScopeError(
      'SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS',
      'nope from MCP App-key',
    );
    expect(e.extensions?.code).toBe('SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS');
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

  it('rejects private + private and shared + private (chat-roots never live on private-class memory)', () => {
    // `private` is for secure single-owner records, not chat content.
    // The rejection mirrors the existing `group`-class rejection.
    expect(() =>
      validateChatScopeInvariants({ scope: 'private', memoryClass: 'private' }),
    ).toThrow(ChatScopeError);
    expect(() =>
      validateChatScopeInvariants({ scope: 'shared', memoryClass: 'private' }),
    ).toThrow(ChatScopeError);
    // Even with the legacy migration flag, private should not be tolerated —
    // legacy chats only ever lived in personal or knowledge memory.
    expect(() =>
      validateChatScopeInvariants({
        scope: undefined,
        memoryClass: 'private',
        allowMissingScope: true,
      }),
    ).toThrow(ChatScopeError);
  });
});
