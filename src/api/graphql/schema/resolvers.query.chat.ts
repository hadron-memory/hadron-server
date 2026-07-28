// chatQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import {
  decryptNodeFields,
  getMemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { chatLocFilter, pickChatNode } from '../../../lib/chatLoc.js';
import {
  type Context,
  deriveChatTitle,
} from './resolvers.helpers.js';

export const chatQueries = {
    myChats: async (
      _: unknown,
      { agentRef, limit, offset }: { agentRef: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // 007-entity-id-or-urn: agentRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);

      // Spec 017 — collect the memories the caller may read chats from:
      //  - the caller's own personal memory for this agent (private chats)
      //  - app-class memories of every App where the caller is an
      //    AppMember and App.agentId == this agent (shared chats)
      //
      // The DB query is filtered by memory id; the visibility rule is
      // enforced at the query layer (no application-side post-filter).
      const readableMemoryIds: string[] = [];

      const personalMemory = await ctx.db.memory.findFirst({
        where: {
          userMemoryOfAgentId: resolvedAgentId,
          createdBy: ctx.userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (personalMemory) readableMemoryIds.push(personalMemory.id);

      // 023-app-shape Phase 2b: App↔Agent moved from `App.agentId` to the
      // N:M `AppAgent` join. Match Apps that have the resolved Agent
      // installed via the join.
      const sharedMemberships = await ctx.db.appMember.findMany({
        where: {
          userId: ctx.userId,
          app: {
            appAgents: { some: { agentId: resolvedAgentId } },
            deletedAt: null,
          },
        },
        select: { app: { select: { id: true } } },
      });
      if (sharedMemberships.length > 0) {
        const sharedMemories = await ctx.db.memory.findMany({
          where: {
            appId: { in: sharedMemberships.map((m) => m.app.id) },
            class: 'app',
            deletedAt: null,
          },
          select: { id: true },
        });
        for (const m of sharedMemories) readableMemoryIds.push(m.id);
      }

      if (readableMemoryIds.length === 0) return [];

      // Top-level chat nodes live at loc "chats:<id>" (depth 2). The only
      // sub-shapes today are `chats:UUID:messages` (container) and
      // `chats:UUID:messages:NNN-*` (message rows) — both contain
      // ':messages', and chat-root locs do not, so we can filter them out
      // at the DB layer instead of pulling every message body just to
      // discard it.
      //
      // Sort by Node.updatedAt (Prisma's @updatedAt) — bumped automatically
      // each time sendChatMessage / processChatResponse writes the new
      // `data.lastMessageAt` back to the chat-root row. That makes the
      // column an exact proxy for the previous "lastMessageAt || createdAt"
      // ordering, sortable at the DB layer with `take`/`skip` — no
      // application-side resort, no JS slice.
      const tops = await ctx.db.node.findMany({
        where: {
          memoryId: { in: readableMemoryIds },
          loc: { startsWith: 'chats:' },
          NOT: { loc: { contains: ':messages' } },
          deletedAt: null,
        },
        orderBy: { updatedAt: 'desc' as const },
        take: limit ?? 100,
        skip: offset ?? 0,
      });
      if (tops.length === 0) return [];

      // First-message lookup, scoped to the visible page only (was: every
      // candidate chat). Parallelized via Promise.all.
      const firstMessageEntries = await Promise.all(
        tops.map(async (top) => {
          const firstMsg = await ctx.db.node.findFirst({
            where: {
              memoryId: top.memoryId,
              loc: { startsWith: `${top.loc}:messages:` },
              deletedAt: null,
            },
            orderBy: { seq: 'asc' as const },
            select: { content: true },
          });
          return [top.loc, firstMsg?.content ?? null] as const;
        }),
      );
      const firstMessagesByChat = new Map<string, string>();
      for (const [loc, content] of firstMessageEntries) {
        if (content) firstMessagesByChat.set(loc, content);
      }

      return tops.map((node) => {
        const data = (node.data as Record<string, unknown>) ?? {};
        const title = deriveChatTitle(node, data, firstMessagesByChat.get(node.loc) ?? null);
        // Spec 017: scope comes from chat-root data.scope, denormalized
        // at chat creation. Legacy chats predating the feature have no
        // scope on disk; they're treated as 'private' (which matches
        // their storage class) until the Phase 6 backfill runs.
        const scope: 'private' | 'shared' =
          data.scope === 'shared' ? 'shared' : 'private';
        return {
          id: node.id,
          loc: node.loc,
          title,
          conversationName: (data.conversationName as string) ?? null,
          stageName: (data.stageName as string) ?? null,
          messageCount: (data.messageCount as number) ?? 0,
          createdAt: node.createdAt,
          lastMessageAt: (data.lastMessageAt as string) ?? null,
          scope,
          createdBy: node.createdBy ?? null,
        };
      });
    },

    chatHistory: async (
      _: unknown,
      { chatId, limit }: { chatId: string; limit?: number },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // #829: narrow to chats this caller is entitled to BEFORE picking one.
      // `loc` is unique per memory, so an attacker who learns a chat id could
      // plant a node at that loc; filtering by entitlement first means it can
      // neither be picked nor block the read. The site's own gate still runs.
      const chatNode = pickChatNode(
        await ctx.db.node.findMany({
          where: await chatLocFilter(ctx.db, chatId, ctx),
          select: { id: true, memoryId: true, createdBy: true },
          // Oldest wins — a planted duplicate is always newer (#829).
          orderBy: { createdAt: 'asc' as const },
          take: 2,
        }),
        chatId,
      );
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);
      // Spec 017 — read-visibility check (FR-007/FR-008):
      //   - shared (app-class memory)         → any AppMember of memory.appId
      //   - per-user agent memory             → memory.createdBy only.
      //     Covers both class='personal' AND class='knowledge': startChat
      //     provisions the chat's holding memory as 'personal' when the
      //     agent has a matching App in the caller's orgs, and downgrades
      //     to 'knowledge' otherwise (see startChat target-memory selection,
      //     and the chk_memory_class_app_id CHECK constraint that forces
      //     personal-class to carry an appId). Both shapes are bound to a
      //     single user via userMemoryOfAgentId — so authorize on
      //     createdBy in either case rather than the class label.
      //   - other classes                     → no chat-read path
      //   - global ADMIN/OWNER bypass remains for ops
      const mem = await ctx.db.memory.findUniqueOrThrow({
        where: { id: chatNode.memoryId },
        select: { createdBy: true, class: true, appId: true, userMemoryOfAgentId: true },
      });
      const isAdmin = !!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'));
      let canRead = isAdmin;
      if (!canRead) {
        if (mem.class === 'app' && mem.appId) {
          const member = await ctx.db.appMember.findFirst({
            where: { appId: mem.appId, userId: ctx.userId },
            select: { userId: true },
          });
          canRead = !!member;
        } else if (mem.userMemoryOfAgentId) {
          canRead = mem.createdBy === ctx.userId;
        } else if (mem.class === 'personal') {
          // Defensive fallback for any pre-spec personal-class chat
          // memory that wasn't bound via userMemoryOfAgentId. Modern
          // chat creation always sets the binding (see startChat).
          canRead = mem.createdBy === ctx.userId;
        }
      }
      if (!canRead) throw new Error('Forbidden');
      const rows = await ctx.db.node.findMany({
        where: {
          memoryId: chatNode.memoryId,
          loc: { startsWith: `${chatId}:messages:` },
          deletedAt: null,
        },
        orderBy: { seq: 'asc' as const },
        take: limit ?? 100,
        select: { loc: true, content: true, data: true, seq: true, createdAt: true, memoryId: true, nodeType: true },
      });
      // Decrypt before reading `data.role` / returning `content` — for
      // encrypted memories `data` is an opaque wrapper until decrypted, so
      // role detection would otherwise always fall through to the loc
      // suffix.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) {
        for (const m of rows) decryptNodeFields(m, memEncInfo);
      }
      return rows.map((m) => {
        // Agent-agnostic role detection (Constitution Invariant #14):
        //   - Primary: data.role on the message node.
        //   - Fallback: deterministic loc suffix from message creation —
        //     assistant messages always end with `-assistant`. Summary
        //     nodes (loc suffix `${NNN}a-summary`, created by
        //     saveChatSummary) and anything else default to 'user',
        //     matching the LLM-facing history builder in sendChatMessage.
        const name = m.loc.split(':').pop() ?? '';
        const data = (m.data as { role?: unknown } | null) ?? null;
        const explicitRole = typeof data?.role === 'string' ? data.role : null;
        const role: 'user' | 'assistant' =
          explicitRole === 'assistant'
            ? 'assistant'
            : explicitRole === 'user'
              ? 'user'
              : name.endsWith('-assistant')
                ? 'assistant'
                : 'user';
        return {
          role,
          content: m.content ?? '',
          seq: m.seq,
          createdAt: m.createdAt,
        };
      });
    },
};

