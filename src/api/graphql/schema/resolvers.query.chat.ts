// chatQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import {
  decryptNodeFields,
  getMemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { chatLocFilter, pickChatNode } from '../../../lib/chatLoc.js';
import { recordNodeUsage, toUsageNodeRefs } from '../../../lib/usageRecorder.js';
import { excludeTeamChat, excludeChannelRoots } from '../../../lib/teamChatLoc.js';
import { teamSpaceAudienceFilter } from '../../../lib/auth/teamSpace.js';
import {
  type Context,
  deriveChatTitle,
  isMemoryReadableCached,
} from './resolvers.helpers.js';

export const chatQueries = {
    myChats: async (
      _: unknown,
      { agentRef, limit, offset }: { agentRef: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // #876 (HIGH): the chat surface authorizes on raw caller identity and
      // deliberately bypasses memoryAccessFilter (see src/lib/chatLoc.ts), so
      // neither the org narrowing nor the personal-class carve-out reaches it.
      // Under impersonation this returned the TARGET's private per-user agent
      // chats (createdBy) plus App chats from their OTHER orgs (the AppMember
      // lookups carry no organizationId filter) — decrypted transcripts, the
      // highest-sensitivity per-user data on the platform. No support case in
      // v1 justifies reading someone's private AI conversations.
      if (ctx.impersonation) throw new Error('Forbidden');
      // 007-entity-id-or-urn: agentRef may be ID, bare URN, or prefixed URN.
      // #1946: an Agent that doesn't exist answers the same empty list as one
      // the caller has no chats with (and can't read), so the list is no
      // existence oracle. A malformed ref still surfaces as the caller's input.
      let resolvedAgentId: string;
      try {
        ({ id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef));
      } catch (e) {
        if (e instanceof AgentNotFoundError) return [];
        throw e;
      }

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
            // #1196 (@copilot round 6) — `class: 'app'` alone listed chats in
            // another user's SESSION or a Worker's casting memory, and the
            // first-message lookup below returns transcript CONTENT with no
            // further memory gate. Pre-existing rather than introduced here,
            // but it is the same missing clause this change fixes everywhere
            // else, so leaving the one instance in a file I am editing would be
            // a choice rather than an oversight. Owner-owned rows are excluded
            // outright: this resolver already refuses impersonation, and a
            // co-member has no claim on the App owner's row.
            ...teamSpaceAudienceFilter,
            ownerUserId: null,
          },
          select: { id: true },
        });
        for (const m of sharedMemories) readableMemoryIds.push(m.id);
      }

      if (readableMemoryIds.length === 0) return [];

      // Top-level chat nodes live at loc "chats:<id>" (depth 2). Message
      // shapes — `chats:<id>:messages` (container) and
      // `chats:<id>:messages:NNN-*` (rows) — both contain ':messages', and
      // chat-root locs do not, so we can filter them out at the DB layer
      // instead of pulling every message body just to discard it.
      //
      // #1030: `chats:` is NOT an agent-chat-only namespace, which the
      // previous version of this comment asserted. Since #939 the team chat
      // lives at `chats:team` in a team App's shared app-class memory — one of
      // the very memories collected above — and it is an agent chat in no
      // respect except its address. `excludeTeamChat` keeps it out; it is
      // read through `teamChatMessages`, which renders its authors and
      // applies the team-membership gate. The exclusion matches the root
      // exactly and its subtree under ':' only, so a user's own
      // `chats:team-retro` still lists.
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
          ...excludeTeamChat,
          // #1196: and every Channel root, whatever its address — the loc rule
          // above only ever knew about `chats:team`.
          ...excludeChannelRoots,
        },
        orderBy: { updatedAt: 'desc' as const },
        take: limit ?? 20,
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
            // #919: `seq` alone is not a total order — chats written before
            // the counter was allocated atomically hold colliding values, and
            // "the first message" must not depend on which row the planner
            // happens to return. `createdAt` then `loc` (unique per memory)
            // make the tiebreak deterministic.
            orderBy: [{ seq: 'asc' as const }, { createdAt: 'asc' as const }, { loc: 'asc' as const }],
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
      { chatId, limit, beforeSeq }: { chatId: string; limit?: number; beforeSeq?: number | null },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // #876 (HIGH): same identity-scoped bypass as myChats above — chatLoc's
      // filter is keyed on createdBy / the caller's AppMember rows with no org
      // constraint, and the site gate admits on `mem.createdBy === ctx.userId`.
      // Impersonated sessions do not read chat transcripts.
      if (ctx.impersonation) throw new Error('Forbidden');
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
      // #1196 — the SHARED node-content gate, replacing a hand-rolled
      // per-class one. `cor:acl:030:01`: a chat has no access layer of its own;
      // read falls through the host memory's per-class rules. This resolver
      // returns node CONTENT, so the gate is `isMemoryReadableCached`, not the
      // record gate (`findings:record-vs-node-content-memory-gate` — the
      // payload decides).
      //
      // What the replaced block got wrong, in the order it mattered:
      //
      //   1. **`let canRead = isAdmin` was an UNCONDITIONAL platform bypass**,
      //      so an operator read a chat in anyone's `personal` or `private`
      //      memory. `cor:acl:010:02` makes those two strict-owner: the
      //      ADMIN/OWNER bypass does not reach them, and the shared gate's
      //      admin branch encodes exactly that carve-out by returning an
      //      explicit id list rather than "no filter".
      //   2. The app-class arm keyed on the **AppMember row alone** — the
      //      re-keying `cor:acl:010:01` names as invalidating. Participation
      //      (org CONTRIBUTOR+, the user-owned App's owner) now admits through
      //      the shared gate's App fold.
      //   3. Every arm was a restatement of a clause the shared predicate
      //      already carries — including the `userMemoryOfAgentId` one, which
      //      IS `findings:chathistory-knowledge-class-auth-gap` folded into
      //      `getAccessibleMemoryIds` as `{ userMemoryOfAgentId: { not: null },
      //      createdBy: ctx.userId }`. The `createdBy` fallback for a
      //      personal-class memory with no binding went with them: the shared
      //      clause keys on the OWNER (`Memory.userId`), which
      //      `chk_personal_visibility_user` makes NOT NULL for that class, so
      //      the fallback guarded a row the database forbids.
      if (!(await isMemoryReadableCached(ctx, chatNode.memoryId))) throw new Error('Forbidden');
      const rows = await ctx.db.node.findMany({
        where: {
          memoryId: chatNode.memoryId,
          loc: { startsWith: `${chatId}:messages:` },
          deletedAt: null,
          // #1116: `beforeSeq` is the backward mirror of `teamChatMessages`'
          // `sinceSeq` — strictly LESS THAN, so a client pages back by passing
          // the oldest seq it holds. It NARROWS the candidate set; the window
          // below then returns the newest `limit` of what remains, which is the
          // page immediately preceding the cursor. The two compose rather than
          // competing, so paging never changes which END a window comes from.
          //
          // A counterless message is included by every cursor, because it is
          // OLDER than every numbered one (cor:cht:050:02) — excluding it here
          // would make the oldest part of a legacy transcript the one part
          // paging could never reach.
          ...(beforeSeq != null
            ? { OR: [{ seq: null }, { seq: { lt: beforeSeq } }] }
            : {}),
        },
        // #1111: `limit` bounds the transcript to its MOST RECENT slice, so the
        // sort is inverted and the take reversed below. An ascending sort with
        // a plain `take` is a HEAD-take — it returned the oldest N, freezing a
        // long chat at its opening while every later message stayed invisible.
        //
        // Inverting all three keys (rather than `seq` alone) is what makes this
        // exactly the tail rather than an approximation of it: `loc` is unique
        // per memory, so (seq, createdAt, loc) is a TOTAL order, and the reverse
        // of a total order taken from the other end is precisely its last N.
        //
        // #919: that tiebreak also has to stay, and stay complete. `seq` is
        // allocated atomically now, but chats written before that hold
        // colliding values, and a tie left to the planner can order two
        // members' messages differently from one read to the next.
        //
        // `nulls: 'last'` is load-bearing and is NOT the Postgres default:
        // `Node.seq` is nullable, and PG sorts NULLs FIRST on DESC (it sorts
        // them last on ASC, which is why the old head-take never met them).
        // Left at the default, a chat holding enough null-seq rows would fill
        // the whole window with them and push out the numbered messages —
        // reproducing this very bug for legacy transcripts. A row with no
        // counter predates the counter, so it sorts as the OLDEST; within that
        // group `createdAt` still orders them. (Codex P2 on PR #1112.)
        orderBy: [
          { seq: { sort: 'desc' as const, nulls: 'last' as const } },
          { createdAt: 'desc' as const },
          { loc: 'desc' as const },
        ],
        take: limit ?? 20,
        // `id` rides along for the #1061 usage attribution; the projection
        // below doesn't use it (a transcript entry is addressed by loc/seq).
        select: { id: true, loc: true, content: true, data: true, seq: true, createdAt: true, memoryId: true, nodeType: true },
      });
      // #1111: back to ascending. The window is the newest N; the ORDER a
      // client renders is still oldest-first, so only the slice moved.
      rows.reverse();
      // Decrypt before reading `data.role` / returning `content` — for
      // encrypted memories `data` is an opaque wrapper until decrypted, so
      // role detection would otherwise always fall through to the loc
      // suffix.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) {
        for (const m of rows) decryptNodeFields(m, memEncInfo);
      }
      // #1061 — a transcript read returns each message's content, so it is one
      // read per message returned. Recorded here, AFTER the decrypt above: an
      // encrypted chat with no live session key throws SESSION_EXPIRED out of
      // `decryptNodeFields`, and the caller then receives no transcript at all
      // (PR #1062 review — Codex P2, Copilot). Impersonated callers threw
      // Forbidden further up, so nothing here can land in a support session.
      recordNodeUsage(ctx.db, 'read', toUsageNodeRefs(rows), ctx);
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

