// typeResolvers — GraphQL type-level field resolvers extracted from resolvers.ts
// (split step 3). No behavior change.
import { isLifecycleActive } from '@hadron-memory/access-control';
import {
  getPrimaryAgent,
  getPrimaryAgentId,
} from '../../../lib/appAgent.js';
import {
  composeInstalledAgentUrn,
  composeNodeUrn,
  composeEdgeUrn,
  legacyMemoryUrnToCanonical,
} from '../../../lib/urn.js';
import { userUrn } from '../../../lib/userHandle.js';
import { isId } from '../../../lib/entityRef/shape.js';
import {
  canSeeUserPersonalFields,
  canSeeOrgMemberRole,
} from '../../../lib/auth/userVisibility.js';
import { type AgentVisibility } from '../../../generated/prisma/index.js';
import {
  deserializeTags,
  deserializeJson,
} from '../../../integrations/db/provider.js';
import {
  type Context,
  loadEdgeEndpointNode,
  loadMemoryUrn,
  defaultAiConfigOf,
  isOrgMemberOrAdmin,
  safeCanonicalUrn,
  AGENT_INCLUDE,
  APP_INCLUDE,
  toISO,
  readPrimaryAgentIdFromEager,
  readPrimaryAgentRecordFromEager,
  readAllAgentRecordsFromEager,
  readPrimaryAgentField,
  assetUrn,
} from './resolvers.helpers.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';

// #481 (Codex review): normalize a STORED memory urn to canonical form before
// composing node/edge URNs. Legacy single-colon role-marker urns (e.g.
// `org:agent:app-user:<id>`) would otherwise be rejected by composeNodeUrn's
// canonicalizer (it can't know the marker:id boundary), dropping those nodes
// to the non-parseable raw fallback. Mirrors Memory.urn's two-branch logic.
const canonicalStoredMemoryUrn = (urn: string): string =>
  urn.includes('::') ? urn : legacyMemoryUrnToCanonical(urn);

/**
 * Resolve one editor/approver candidate string to public identifiers:
 * 'github:<login>' matches the linked GitHub username case-insensitively;
 * 'email:<addr>' matches the account email case-insensitively; 'app:<id>'
 * is a non-user principal by construction (zero I/O); 'user:<id>' and a
 * bare ID-shaped value (isId — legacy reasons/commit messages never match)
 * look up the User PK. Returns { handle, urn } — never name/email/any PII.
 */
async function lookupRevisionEditorCandidate(
  ctx: Context,
  cand: string,
): Promise<{ handle: string; urn: string | null } | null> {
  let user: { handle: string | null } | null = null;
  if (cand.startsWith('app:')) {
    return null; // App-key principal — can never be a user.
  } else if (cand.startsWith('github:')) {
    const login = cand.slice('github:'.length);
    if (!login) return null;
    user = await ctx.db.user.findFirst({
      where: { githubUsername: { equals: login, mode: 'insensitive' }, deletedAt: null },
      select: { handle: true },
    });
  } else if (cand.startsWith('email:')) {
    const addr = cand.slice('email:'.length);
    if (!addr) return null;
    user = await ctx.db.user.findFirst({
      where: { email: { equals: addr, mode: 'insensitive' }, deletedAt: null },
      select: { handle: true },
    });
  } else {
    const id = cand.startsWith('user:') ? cand.slice('user:'.length) : cand;
    if (!isId(id)) return null; // shared ID-shape predicate (entityRef/shape)
    user = await ctx.db.user.findFirst({
      where: { id, deletedAt: null },
      select: { handle: true },
    });
  }
  if (!user?.handle) return null;
  return { handle: user.handle, urn: userUrn(user.handle) };
}

/**
 * Resolve a revision editor/approver candidate list (#617/#619/#620): first
 * candidate that resolves to a live, handle-bearing user wins. A node's
 * history overwhelmingly repeats the same few editor strings, so lookups are
 * memoized per request on the Context (same pattern as loadMemoryUrn /
 * loadEdgeEndpointNode) — a 50-row history costs one query per DISTINCT
 * candidate, negative results included.
 */
function resolveRevisionEditor(
  ctx: Context,
  candidates: Array<string | null | undefined>,
): Promise<{ handle: string; urn: string | null } | null> {
  const cache = (ctx.revisionEditorCache ??= new Map<
    string,
    Promise<{ handle: string; urn: string | null } | null>
  >());
  const lookup = (cand: string) => {
    let pending = cache.get(cand);
    if (!pending) {
      pending = lookupRevisionEditorCandidate(ctx, cand);
      cache.set(cand, pending);
    }
    return pending;
  };
  return (async () => {
    for (const cand of candidates) {
      if (!cand) continue;
      const hit = await lookup(cand);
      if (hit) return hit;
    }
    return null;
  })();
}

export const typeResolvers = {
  McpServer: {
    // headersEncrypted is not in the GraphQL type at all; readers get only
    // this boolean (write-only secret posture, same as tool-held tokens).
    hasHeaders: (s: { headersEncrypted?: string | null }) => s.headersEncrypted != null,
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    updatedAt: (s: { updatedAt: Date | string }) => toISO(s.updatedAt)!,
  },
  HomeAssistantInstance: {
    // tokenEncrypted is not in the GraphQL type at all (write-only secret
    // posture) — nothing to derive, just date serialization.
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    updatedAt: (s: { updatedAt: Date | string }) => toISO(s.updatedAt)!,
  },
  ResendSender: {
    hasApiKey: (s: { apiKeyEncrypted?: string | null }) => s.apiKeyEncrypted != null,
    from: (s: { fromAddress: string }) => s.fromAddress,
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    updatedAt: (s: { updatedAt: Date | string }) => toISO(s.updatedAt)!,
  },
  Node: {
    tags: (node: { tags: string | string[] }) => deserializeTags(node.tags),
    createdAt: (n: { createdAt: Date | string }) => toISO(n.createdAt)!,
    updatedAt: (n: { updatedAt: Date | string }) => toISO(n.updatedAt)!,
    // `node { memory { urn … } }` powers full-URN rendering in clients
    // (the portal composes `<memory.urn>::<loc>`). The generic `nodes`
    // query doesn't `include` the relation, so resolve it lazily by
    // memoryId — use the preloaded relation when a resolver already
    // included it (e.g. appNodes). Same pattern as MemoryShare.memory.
    memory: async (n: { memoryId: string; memory?: unknown }, _: unknown, ctx: Context) =>
      n.memory ?? ctx.db.memory.findUnique({ where: { id: n.memoryId } }),
    // #481 — the fully-qualified node URN, composed server-side so every
    // Node-returning surface carries it (the extension's URN chip + run-via-
    // URN light up without a client release). Uses the preloaded relation's
    // urn when a resolver already included it (guarding against partial
    // selects that omit urn), else the request-memoized memory-urn loader.
    urn: async (
      n: { loc: string; memoryId: string; memory?: { urn?: string } | null },
      _: unknown,
      ctx: Context,
    ) => {
      const memUrn =
        (typeof n.memory?.urn === 'string' ? n.memory.urn : null) ??
        (await loadMemoryUrn(ctx, n.memoryId));
      // The field is String! — never null it. A missing memory row is corrupt
      // data; a canonicalization failure falls back to a raw compose (same
      // serve-and-log posture as safeCanonicalUrn).
      if (!memUrn) return `hrn:node:unknown::${n.loc}`;
      const canonicalMem = canonicalStoredMemoryUrn(memUrn);
      try {
        return composeNodeUrn(canonicalMem, n.loc);
      } catch (err) {
        console.warn(`[Node.urn] failed to canonicalize memory urn "${memUrn}":`, err);
        return `hrn:node:${canonicalMem}::${n.loc}`;
      }
    },
    // Spec 033 embedding-state DateTime fields — Prisma returns Date,
    // portal (and any other GraphQL consumer) needs ISO strings.
    embeddingPendingAt: (n: { embeddingPendingAt?: Date | string | null }) =>
      toISO(n.embeddingPendingAt),
    embeddingFailedAt: (n: { embeddingFailedAt?: Date | string | null }) =>
      toISO(n.embeddingFailedAt),
  },
  Edge: {
    // `Edge.source` / `Edge.target` are non-null (`Node!`) in the schema, but
    // callers preload only the relevant endpoint per direction (e.g. nodeById
    // does `outgoingEdges: { include: { target: true } }` — source is NOT
    // loaded — and the mirror for incomingEdges). A client selecting the
    // unloaded side would otherwise resolve to null, violate the non-null
    // field, and bubble up to error the WHOLE query (e.g. the portal edge
    // detail page selecting `source` on an outgoing edge → 500). Lazily load
    // the endpoint by FK when it wasn't preloaded — same pattern as
    // Node.memory. The fast path (preloaded) returns the relation unchanged.
    //
    // The lazy path runs once per Edge in a list, and edges commonly SHARE an
    // endpoint — e.g. `nodeById { outgoingEdges { source } }`, where every
    // edge's source is the same parent node. `loadEdgeEndpointNode` memoizes
    // the fetch in a request-scoped cache on the Context so each node is read
    // at most once per request (no N+1 of identical findUnique). PR #381 review.
    source: (e: { sourceId: string; source?: unknown }, _: unknown, ctx: Context) =>
      e.source ?? loadEdgeEndpointNode(ctx, e.sourceId),
    target: (e: { targetId: string; target?: unknown }, _: unknown, ctx: Context) =>
      e.target ?? loadEdgeEndpointNode(ctx, e.targetId),
    // #481 parity — edges are loc-addressed peers of nodes (spec 037), so
    // they carry their fully-qualified URN the same way. Edge.memoryId is the
    // denormalized SOURCE-side memory, which is exactly the URN's memory.
    urn: async (e: { loc: string; memoryId: string }, _: unknown, ctx: Context) => {
      const memUrn = await loadMemoryUrn(ctx, e.memoryId);
      if (!memUrn) return `hrn:edge:unknown::${e.loc}`;
      const canonicalMem = canonicalStoredMemoryUrn(memUrn);
      try {
        return composeEdgeUrn(canonicalMem, e.loc);
      } catch (err) {
        console.warn(`[Edge.urn] failed to canonicalize memory urn "${memUrn}":`, err);
        return `hrn:edge:${canonicalMem}::${e.loc}`;
      }
    },
  },
  NodeRevision: {
    createdAt: (nv: { createdAt: Date | string }) => toISO(nv.createdAt)!,
    // Prisma reads a NULL scalar list as [] already; belt-and-suspenders for
    // rows that arrive from raw queries (#620 legacy rows).
    changes: (nv: { changes?: string[] | null }) => nv.changes ?? [],
    // #617/#619/#620 — resolve the revision's editor to PUBLIC identifiers
    // only: handle + urn, never name/email. Candidates in preference order:
    //   1. editedBy — post-#620 this holds ONLY a User id;
    //   2. createdBy — legacy rows captured `userId ?? clientId` here (user
    //      preferred), which resolves history the #620 migration couldn't
    //      backfill (#619);
    //   3. editedByInfo — identity-string forms: 'github:<login>' resolves
    //      via the linked GitHub username (case-insensitive), 'email:<addr>'
    //      via the account email, 'user:<id>' by PK (#619).
    // A non-resolving principal, a deleted user, or a handle-less user all
    // yield null (the portal falls back to the raw strings). handle/urn are
    // the same public identifiers the `users` search exposes, so no
    // per-caller visibility gate is needed (and no PII can leak — none is
    // returned).
    editedByUser: async (
      nv: { editedBy?: string | null; createdBy?: string | null; editedByInfo?: string | null },
      _: unknown,
      ctx: Context,
    ) => resolveRevisionEditor(ctx, [nv.editedBy, nv.createdBy, nv.editedByInfo]),
    // #620 — same public-identifier resolution for the (reserved) approver.
    approvedByUser: async (nv: { approvedBy?: string | null }, _: unknown, ctx: Context) =>
      resolveRevisionEditor(ctx, [nv.approvedBy]),
  },
  Asset: {
    uploadedAt: (a: { uploadedAt: Date | string }) => toISO(a.uploadedAt)!,
    deletedAt: (a: { deletedAt?: Date | string | null }) => toISO(a.deletedAt),
    urn: async (a: { id: string; memoryId: string }, _: unknown, ctx: Context) => {
      const memory = await ctx.db.memory.findUnique({
        where: { id: a.memoryId },
        select: { urn: true },
      });
      return memory ? assetUrn(memory.urn, a.id) : `unknown:assets:${a.id}`;
    },
  },
  Memory: {
    lastSyncedAt: (g: { lastSyncedAt?: Date | string | null }) => toISO(g.lastSyncedAt),
    createdAt: (g: { createdAt: Date | string }) => toISO(g.createdAt)!,
    updatedAt: (g: { updatedAt: Date | string }) => toISO(g.updatedAt)!,
    // Spec 033 FR-026 — readback for the encrypted-memory vector-
    // inversion disclosure ack.
    vectorIndexEncryptedAckAt: (g: {
      vectorIndexEncryptedAckAt?: Date | string | null;
    }) => toISO(g.vectorIndexEncryptedAckAt),
    organization: (g: { organizationId: string; organization?: unknown }, _: unknown, ctx: Context) =>
      (g as Record<string, unknown>).organization ??
      ctx.db.organization.findUnique({ where: { id: g.organizationId } }),
    // 008-agent-installation: app pivot for app/personal-class memories.
    app: async (g: { appId?: string | null; app?: unknown }, _: unknown, ctx: Context) => {
      if (g.app !== undefined) return g.app ?? null;
      if (!g.appId) return null;
      return ctx.db.app.findUnique({ where: { id: g.appId } });
    },
    // 005-agent-subscription FR-024: userId is gated. Resolves to the
    // actual User.id only for the memory owner or ADMIN/OWNER of the
    // memory's organization. End users querying other users' memories
    // get null even when the underlying value is non-null.
    userId: (
      g: { userId?: string | null; organizationId: string },
      _: unknown,
      ctx: Context,
    ) => {
      if (!g.userId) return null;
      // Memory owner can always see
      if (ctx.userId === g.userId) return g.userId;
      // ADMIN/OWNER of the memory's org can see (for governance)
      if (
        ctx.organizationId === g.organizationId &&
        (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'))
      ) {
        return g.userId;
      }
      // Platform ADMIN/OWNER also see
      if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) {
        return g.userId;
      }
      return null;
    },
    // For system-class memories, find the agent that owns this memory.
    // Returns null for regular knowledge memories. We use a findFirst because
    // there's no FK from Memory → Agent — the relationship is expressed on
    // the Agent side via Agent.systemMemoryId.
    agent: async (g: { id: string; class?: string }, _: unknown, ctx: Context) => {
      if (g.class !== 'system') return null;
      return ctx.db.agent.findFirst({
        where: { systemMemoryId: g.id, deletedAt: null },
        include: AGENT_INCLUDE,
      });
    },
    // 023-app-shape US3: cross-user grants on this Memory. Empty for
    // non-personal-class memories. Visible to (a) the principal
    // (memory.userId), (b) an OrgMember of the memory's owning org
    // with ADMIN/OWNER role, or (c) a platform ADMIN/OWNER.
    // Grantees can read their own shares via User.memorySharesGranted
    // (out of scope here; can be added if a portal page needs it).
    shares: async (
      g: { id: string; class?: string; userId?: string | null; organizationId?: string | null },
      _: unknown,
      ctx: Context,
    ) => {
      // Fast path: a loaded, non-personal class has no shares and needs no
      // scoping fields — skip the fallback fetch entirely.
      if (g.class !== undefined && g.class !== 'personal') return [];
      // Partial-select-safe: some query paths select Memory with only a subset
      // of fields. Fetch the missing scoping fields rather than silently
      // returning `[]` for a real personal memory (mirrors `members` above).
      let cls = g.class;
      let uId = g.userId;
      let orgId = g.organizationId;
      if (cls === undefined || uId === undefined || orgId === undefined) {
        const m = await ctx.db.memory.findUnique({
          where: { id: g.id },
          select: { class: true, userId: true, organizationId: true },
        });
        if (!m) return [];
        cls = m.class;
        uId = m.userId;
        orgId = m.organizationId;
      }
      if (cls !== 'personal') return [];
      const isPrincipal = ctx.userId !== undefined && ctx.userId === uId;
      const isPlatformAdmin =
        ctx.roles?.includes('ADMIN') === true || ctx.roles?.includes('OWNER') === true;
      if (!isPrincipal && !isPlatformAdmin) {
        // Verify the caller is an ADMIN/OWNER of the memory's owning
        // org. The earlier `ctx.organizationId === g.organizationId`
        // shortcut was incomplete — most callers don't have
        // organizationId scoped per-request, which would have made
        // non-platform org admins fall through to an empty list.
        if (!ctx.userId) return [];
        // A user-owned memory (no organizationId) has no org-admin fallback —
        // only the principal (checked above) can read its shares.
        if (!orgId) return [];
        const member = await ctx.db.orgMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId: orgId,
              userId: ctx.userId,
            },
          },
          select: { role: true, deletedAt: true },
        });
        if (
          !member ||
          member.deletedAt ||
          (member.role !== 'ADMIN' && member.role !== 'OWNER')
        ) {
          return [];
        }
      }
      return ctx.db.memoryShare.findMany({
        where: { memoryId: g.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    // 023-app-shape US4: team membership rows on this memory. Empty
    // for non-group-class memories. Visible to current members (any
    // role), ADMIN/OWNER of the memory's owning org, and platform
    // ADMIN/OWNER. Non-members of a group memory get an empty list
    // even if they happen to be in the org but not on the team.
    members: async (
      g: { id: string; class?: string; organizationId?: string | null },
      _: unknown,
      ctx: Context,
    ) => {
      // Partial-select-safe: some query paths (e.g. `appNodes`)
      // select Memory with only { id, urn, name, organizationId }
      // or even less. Fetch the missing scoping fields rather than
      // silently returning `[]` for a real group memory.
      let cls = g.class;
      let orgId = g.organizationId;
      if (cls === undefined || orgId === undefined) {
        const m = await ctx.db.memory.findUnique({
          where: { id: g.id },
          select: { class: true, organizationId: true },
        });
        if (!m) return [];
        cls = m.class;
        orgId = m.organizationId;
      }
      if (cls !== 'group') return [];
      const isPlatformAdmin =
        ctx.roles?.includes('ADMIN') === true || ctx.roles?.includes('OWNER') === true;
      if (!isPlatformAdmin) {
        if (!ctx.userId) return [];
        // Self-membership check (any role).
        const selfMember = await ctx.db.memoryMember.findUnique({
          where: { memoryId_userId: { memoryId: g.id, userId: ctx.userId } },
          select: { userId: true },
        });
        if (!selfMember) {
          // A user-owned memory (no organizationId) has no org-admin
          // fallback — only an existing member (checked above) can read.
          if (!orgId) return [];
          // Fall back to org admin.
          const orgMember = await ctx.db.orgMember.findUnique({
            where: {
              organizationId_userId: {
                organizationId: orgId,
                userId: ctx.userId,
              },
            },
            select: { role: true, deletedAt: true },
          });
          if (
            !orgMember ||
            orgMember.deletedAt ||
            (orgMember.role !== 'ADMIN' && orgMember.role !== 'OWNER')
          ) {
            return [];
          }
        }
      }
      return ctx.db.memoryMember.findMany({
        where: { memoryId: g.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    // 298/318/352: Canonicalize URN on read. Converts legacy single-colon
    // hierarchy (e.g. `org:slug`) to canonical spec-021 double-colon form
    // (`org::slug`) for both legacy and migrated rows. For install-shape
    // memories with role markers (system, app-mem, app-user, group-mem, priv,
    // anon), `legacyMemoryUrnToCanonical` preserves the marker:id boundary so
    // the canonical form round-trips through `parseUrn`
    // (e.g. `org:agent:app-user:id` → `org::agent::app-user:id`, NOT
    // `…::app-user::id`). #352: the marker set is now the single source of
    // truth in urn.ts — `user` (a reserved type word) and `anon` used to
    // bypass the inline list here and serve non-canonical.
    urn: (g: { urn?: string | null }) => {
      const urn = g.urn;
      if (!urn) throw new Error('Memory URN is required but not found (partial query?)');

      // Already canonical (contains `::`) — pass through
      if (urn.includes('::')) return safeCanonicalUrn('memory', urn);

      // Legacy single-colon form — promote hierarchy to `::` while preserving
      // any role-marker:id boundary.
      return safeCanonicalUrn('memory', legacyMemoryUrnToCanonical(urn));
    },
  },
  App: {
    createdAt: (a: { createdAt: Date | string }) => toISO(a.createdAt)!,
    updatedAt: (a: { updatedAt?: Date | string | null }) => toISO(a.updatedAt ?? null),
    expiresAt: (a: { expiresAt?: Date | string | null }) => toISO(a.expiresAt ?? null),
    // 036-ai-service-config: registry-backed reads of the App's
    // 'default' config (legacy ai_* columns dropped).
    aiProvider: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'appId', ctx))?.provider ?? null,
    aiModel: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'appId', ctx))?.model ?? null,
    hasAiApiKey: async (a: { id: string }, _: unknown, ctx: Context) =>
      !!(await defaultAiConfigOf(a, 'appId', ctx))?.apiKeyEncrypted,
    organization: (a: { organizationId: string; organization?: unknown }, _: unknown, ctx: Context) =>
      (a as Record<string, unknown>).organization ??
      ctx.db.organization.findUnique({ where: { id: a.organizationId } }),
    // Spec 021 US1: R2 canonical install URN combining App + Agent URNs.
    // 023-app-shape Phase 2b: read the primary installed Agent's URN via
    // the eager-loaded `appAgents` (preferred — APP_INCLUDE / ORG_INCLUDE
    // both surface it), with a fallback to `getPrimaryAgent`. Returns
    // null when no Agent is installed.
    installedAgentUrn: async (
      a: { id: string; urn: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      const agentUrn = await readPrimaryAgentField(a, ctx, 'urn');
      if (!agentUrn) return null;
      // #520 — fail soft: composeInstalledAgentUrn throws on a malformed app
      // or agent URN (not exactly <org>::<slug>), and a thrown resolver adds
      // an errors[] entry that makes graphql-request reject the WHOLE app(ref:)
      // / apps read — one bad row 404s the portal's app-detail page. This field
      // is nullable, so serve-and-log instead (same posture as Node.urn /
      // Edge.urn above): warn the offending URNs and return null.
      try {
        return composeInstalledAgentUrn(a.urn, agentUrn);
      } catch (err) {
        console.warn(
          `[App.installedAgentUrn] failed to compose from appUrn "${a.urn}" + agentUrn "${agentUrn}":`,
          err,
        );
        return null;
      }
    },
    // 023-app-shape Phase 2b: `App.agent` and `App.agents` are
    // soft-deprecated convenience fields that resolve via the AppAgent
    // join. `App.agent` returns the first installed Agent (orderBy
    // createdAt asc); `App.agents` returns every installed Agent.
    //
    // Agent.memoryItems is non-null in the schema, so the resolved
    // value must include AGENT_INCLUDE — `appAgents` from APP_INCLUDE /
    // ORG_INCLUDE already does, and the fallback re-fetch via
    // `getPrimaryAgent({ include: AGENT_INCLUDE })` does too.
    agentId: async (
      a: { id: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ): Promise<string | null> => {
      const id = readPrimaryAgentIdFromEager(a);
      if (id !== undefined) return id;
      return getPrimaryAgentId(ctx.db, a.id);
    },
    agent: async (
      a: { id: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      const eager = readPrimaryAgentRecordFromEager(a);
      if (eager !== undefined) return eager;
      return getPrimaryAgent(ctx.db, a.id, { include: AGENT_INCLUDE });
    },
    agents: async (
      a: { id: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      const eagerAll = readAllAgentRecordsFromEager(a);
      if (eagerAll !== undefined) {
        return eagerAll.filter((ag): ag is { deletedAt: Date | null } & object =>
          ag !== null && !(ag as { deletedAt?: Date | null }).deletedAt,
        );
      }
      const rows = await ctx.db.appAgent.findMany({
        where: { appId: a.id },
        orderBy: { createdAt: 'asc' },
        include: { agent: { include: AGENT_INCLUDE } },
      });
      return rows.map((r) => r.agent).filter((ag) => ag && !ag.deletedAt);
    },
    members: async (a: { id: string }, _: unknown, ctx: Context) => {
      return ctx.db.appMember.findMany({
        where: { appId: a.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    memberCount: async (a: { id: string }, _: unknown, ctx: Context) => {
      return ctx.db.appMember.count({ where: { appId: a.id } });
    },
    keys: async (a: { id: string; keys?: unknown[] }, _: unknown, ctx: Context) => {
      if (a.keys) return a.keys;
      return ctx.db.appKey.findMany({
        where: { appId: a.id, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    },
    // 023-app-shape US1: AppAgent join rows for this App. Filters out
    // join rows whose Agent is soft-deleted, keeping App.appAgents
    // and App.agents in sync (App.agents already filters deletedAt;
    // App.appAgents.map(aa => aa.agent) should return the same set).
    //
    // The eager-loaded rows from APP_INCLUDE don't carry `aa.app`
    // (it would be redundant — the parent IS that App). Attach the
    // parent App onto each row so `AppAgent.app` resolves without an
    // N+1 DB lookup per row.
    appAgents: async (a: { id: string; appAgents?: unknown } & Record<string, unknown>, _: unknown, ctx: Context) => {
      if (Array.isArray(a.appAgents)) {
        return a.appAgents
          .filter((aa) => {
            const agent = (aa as { agent?: { deletedAt?: Date | null } | null }).agent;
            return agent != null && !agent.deletedAt;
          })
          .map((aa) => ({ ...(aa as object), app: a }));
      }
      return ctx.db.appAgent.findMany({
        where: { appId: a.id, agent: { deletedAt: null } },
        orderBy: { createdAt: 'asc' },
        include: { app: true, agent: { include: AGENT_INCLUDE } },
      });
    },
    // 298: Canonicalize URN on read. Converts legacy single-colon hierarchy
    // to canonical spec-021 double-colon form for both legacy and migrated rows.
    urn: (a: { urn?: string | null }) => {
      if (!a.urn) throw new Error('App URN is required but not found (partial query?)');
      return safeCanonicalUrn('app', a.urn);
    },
  },
  // 023-app-shape US1: the App↔Agent N:M join.
  AppAgent: {
    createdAt: (aa: { createdAt: Date | string }) => toISO(aa.createdAt)!,
    updatedAt: (aa: { updatedAt?: Date | string | null }) => toISO(aa.updatedAt ?? null),
    app: async (aa: { appId: string; app?: unknown }, _: unknown, ctx: Context) =>
      aa.app ?? ctx.db.app.findUniqueOrThrow({ where: { id: aa.appId } }),
    agent: async (aa: { agentId: string; agent?: unknown }, _: unknown, ctx: Context) =>
      aa.agent ??
      ctx.db.agent.findUniqueOrThrow({
        where: { id: aa.agentId },
        include: AGENT_INCLUDE,
      }),
  },
  AgentSubscription: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    activatedAt: (s: { activatedAt?: Date | string | null }) => toISO(s.activatedAt ?? null),
    expiresAt: (s: { expiresAt?: Date | string | null }) => toISO(s.expiresAt ?? null),
    revokedAt: (s: { revokedAt?: Date | string | null }) => toISO(s.revokedAt ?? null),
    isActive: (s: { activatedAt?: Date | null; revokedAt?: Date | null; expiresAt?: Date | null }) =>
      isLifecycleActive({
        activatedAt: s.activatedAt ?? null,
        revokedAt: s.revokedAt ?? null,
        expiresAt: s.expiresAt ?? null,
      }),
    user: async (s: { userId: string; user?: unknown }, _: unknown, ctx: Context) =>
      s.user ?? ctx.db.user.findUnique({ where: { id: s.userId } }),
    agent: async (s: { agentId: string; agent?: unknown }, _: unknown, ctx: Context) =>
      s.agent ?? ctx.db.agent.findUnique({ where: { id: s.agentId } }),
  },
  // 008-agent-installation: User↔App membership join.
  AppMember: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    updatedAt: (s: { updatedAt?: Date | string | null }) => toISO(s.updatedAt ?? null),
    app: async (s: { appId: string; app?: unknown }, _: unknown, ctx: Context) =>
      s.app ?? ctx.db.app.findUnique({ where: { id: s.appId } }),
    user: async (s: { userId: string; user?: unknown }, _: unknown, ctx: Context) =>
      s.user ?? ctx.db.user.findUnique({ where: { id: s.userId } }),
    // 023-app-shape US2 / FR-011: derived from the absence of an
    // OrgMember row in the App's owning Organization. No `appOnly`
    // column on AppMember.
    //
    // The parent is ALREADY an AppMember row by GraphQL contract, so
    // the resolver bypasses the wrapper helper's AppMember-existence
    // check (which would be wasted work — pure N+1 on list fields
    // like Organization.appMembers). The wrapper's contract still
    // matters for auth-side callers that may not have a parent row.
    isOrgExternal: async (
      s: { appId: string; userId: string; app?: { organizationId?: string } | null },
      _: unknown,
      ctx: Context,
    ) => {
      // Prefer the eager-loaded organizationId from APP_INCLUDE; fall
      // back to a re-fetch otherwise.
      const organizationId =
        s.app?.organizationId ??
        (
          await ctx.db.app.findUnique({
            where: { id: s.appId },
            select: { organizationId: true },
          })
        )?.organizationId;
      // spec 047: a user-owned App has no owning org, so an AppMember is
      // vacuously org-external (NOT an OrgMember of a nonexistent org). Kept in
      // sync with isOrgExternalAppMember (src/lib/auth/isOrgExternalAppMember.ts).
      if (!organizationId) return true;
      const orgMember = await ctx.db.orgMember.findFirst({
        where: { userId: s.userId, organizationId, deletedAt: null },
        select: { userId: true },
      });
      return orgMember === null;
    },
  },
  // 023-app-shape US3: asymmetric cross-user grant on personal-class memory.
  MemoryShare: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    updatedAt: (s: { updatedAt?: Date | string | null }) => toISO(s.updatedAt ?? null),
    memory: async (s: { memoryId: string; memory?: unknown }, _: unknown, ctx: Context) =>
      s.memory ?? ctx.db.memory.findUnique({ where: { id: s.memoryId } }),
    grantee: async (s: { granteeId: string; grantee?: unknown }, _: unknown, ctx: Context) =>
      s.grantee ?? ctx.db.user.findUnique({ where: { id: s.granteeId } }),
    grantor: async (s: { grantorId: string; grantor?: unknown }, _: unknown, ctx: Context) =>
      s.grantor ?? ctx.db.user.findUnique({ where: { id: s.grantorId } }),
  },
  // 023-app-shape US4: symmetric team membership on group-class memory.
  MemoryMember: {
    createdAt: (m: { createdAt: Date | string }) => toISO(m.createdAt)!,
    updatedAt: (m: { updatedAt?: Date | string | null }) => toISO(m.updatedAt ?? null),
    memory: async (m: { memoryId: string; memory?: unknown }, _: unknown, ctx: Context) =>
      m.memory ?? ctx.db.memory.findUnique({ where: { id: m.memoryId } }),
    user: async (m: { userId: string; user?: unknown }, _: unknown, ctx: Context) =>
      m.user ?? ctx.db.user.findUnique({ where: { id: m.userId } }),
  },
  // 008-agent-installation: Agent dependency edge.
  AgentImport: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    parentAgent: async (s: { parentAgentId: string }, _: unknown, ctx: Context) =>
      ctx.db.agent.findUnique({ where: { id: s.parentAgentId } }),
    importedAgent: async (s: { importedAgentId: string }, _: unknown, ctx: Context) =>
      ctx.db.agent.findUnique({ where: { id: s.importedAgentId } }),
  },
  // 008-agent-installation: Org↔Agent license — sibling to AgentSubscription.
  AgentOrgGrant: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    activatedAt: (s: { activatedAt?: Date | string | null }) => toISO(s.activatedAt ?? null),
    expiresAt: (s: { expiresAt?: Date | string | null }) => toISO(s.expiresAt ?? null),
    revokedAt: (s: { revokedAt?: Date | string | null }) => toISO(s.revokedAt ?? null),
    isActive: (s: { activatedAt?: Date | null; revokedAt?: Date | null; expiresAt?: Date | null }) =>
      isLifecycleActive({
        activatedAt: s.activatedAt ?? null,
        revokedAt: s.revokedAt ?? null,
        expiresAt: s.expiresAt ?? null,
      }),
    organization: async (s: { orgId: string }, _: unknown, ctx: Context) =>
      ctx.db.organization.findUnique({ where: { id: s.orgId } }),
    agent: async (s: { agentId: string }, _: unknown, ctx: Context) =>
      ctx.db.agent.findUnique({ where: { id: s.agentId } }),
  },
  // 008-agent-installation: Agent declarative knobs are stored as JSON on
  // the row; the type resolvers pluck the known keys for ergonomic client
  // access. Both come back from `Agent.findUnique` already shaped — these
  // resolvers exist so GraphQL knows MemoryProvisioning/InstallationPolicy
  // are passthrough types, not auto-resolved scalars.
  MemoryProvisioning: {
    appMemory: (p: { appMemory: 'shared' | 'user' | 'none' }) => p.appMemory,
  },
  InstallationPolicy: {
    maxMembers: (p: { maxMembers: number | 'unlimited' }) => String(p.maxMembers),
    memberRoles: (p: { memberRoles: string[] }) => p.memberRoles,
  },
  AppKey: {
    createdAt: (k: { createdAt: Date | string }) => toISO(k.createdAt)!,
    lastUsedAt: (k: { lastUsedAt?: Date | string | null }) => toISO(k.lastUsedAt ?? null),
    revokedAt: (k: { revokedAt?: Date | string | null }) => toISO(k.revokedAt ?? null),
  },
  // 025-oauth-for-mcp: serialize timestamp fields the same way AppKey
  // does. `userId` is intentionally NOT exposed (PR-137 delta D1).
  UserApiKey: {
    createdAt: (k: { createdAt: Date | string }) => toISO(k.createdAt)!,
    lastUsedAt: (k: { lastUsedAt?: Date | string | null }) => toISO(k.lastUsedAt ?? null),
    revokedAt: (k: { revokedAt?: Date | string | null }) => toISO(k.revokedAt ?? null),
  },
  // #562: the current request's principal. `principalType`/`appId`/`agentId`
  // resolve from the source object the Query.authContext resolver returns;
  // `user` and `apiKey` are loaded lazily from the ids it threaded so the
  // fields cost nothing when the client doesn't select them. `user` is the
  // full User type, so it inherits the same PII field-gating as `me` (the
  // viewer IS the user here, so name/email are visible to them).
  AuthContext: {
    user: (
      src: { userId: string | null },
      _: unknown,
      ctx: Context,
    ) => (src.userId ? ctx.db.user.findUnique({ where: { id: src.userId } }) : null),
    apiKey: (
      src: { apiKeyId: string | null },
      _: unknown,
      ctx: Context,
    ) => (src.apiKeyId ? ctx.db.userApiKey.findUnique({ where: { id: src.apiKeyId } }) : null),
  },
  // #384: a member's org role is itself gated. Visible only to the member
  // themselves, platform admins, and co-members whose own role in that org is
  // ADMIN/OWNER. Withheld (null) otherwise — so a READER/CONTRIBUTOR member
  // can't read everyone else's role off the member list. Other OrgMember
  // fields keep default resolution.
  OrgMember: {
    role: async (
      m: { userId: string; organizationId: string; role: string },
      _: unknown,
      ctx: Context,
    ) => ((await canSeeOrgMemberRole(ctx, m)) ? m.role : null),
  },
  User: {
    linkedAt: (u: { linkedAt?: Date | string | null }) => toISO(u.linkedAt ?? null),
    // Canonical hrn:user:<handle> URN (spec cor:urn:010:01) — lowercase, and
    // null for a handle-less or not-URN-legal (grandfathered) handle.
    urn: (u: { handle?: string | null }) => userUrn(u.handle),
    // #384: field-level visibility. name/email are PII — withheld (null)
    // from any viewer who isn't the user themselves, a platform admin, or a
    // co-member of one of the user's orgs. Applied here so EVERY surface that
    // returns a User (searchUsers, me, OrgMember.user, MemoryShare.*, the
    // public invitation.sender, …) gets the same guarantee server-side.
    name: async (u: { id: string; name?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.name ?? null) : null,
    email: async (u: { id: string; email?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.email ?? null) : null,
    // 008-agent-installation: User↔App memberships. Resolves to a non-empty
    // list only when the queried User is the authenticated user (mirrors
    // 005's User.agentSubscriptions resolver-side gate).
    appMemberships: async (u: { id: string }, _: unknown, ctx: Context) => {
      if (ctx.userId !== u.id) return [];
      return ctx.db.appMember.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: 'asc' },
      });
    },
  },
  Session: {
    startedAt: (s: { startedAt: Date | string }) => toISO(s.startedAt)!,
    endedAt: (s: { endedAt?: Date | string | null }) => toISO(s.endedAt ?? null),
    expiresAt: (s: { expiresAt?: Date | string | null }) => toISO(s.expiresAt ?? null),
    autoExpiredAt: (s: { autoExpiredAt?: Date | string | null }) => toISO(s.autoExpiredAt ?? null),
    outcomeMeta: (session: { outcomeMeta: unknown }) => deserializeJson(session.outcomeMeta),
  },
  Organization: {
    createdAt: (o: { createdAt: Date | string }) => toISO(o.createdAt)!,
    updatedAt: (o: { updatedAt: Date | string }) => toISO(o.updatedAt)!,
    hasGithubAppPrivateKey: (o: { githubAppPrivateKeyEncrypted?: string | null }) => !!o.githubAppPrivateKeyEncrypted,
    apps: async (org: { id: string; apps?: unknown[] }, _: unknown, ctx: Context) => {
      if (org.apps) return org.apps;
      return ctx.db.app.findMany({
        where: { organizationId: org.id, deletedAt: null },
        include: APP_INCLUDE,
        orderBy: { name: 'asc' },
      });
    },
    agents: async (org: { id: string }, _: unknown, ctx: Context) => {
      const where: Record<string, unknown> = { organizationId: org.id, deletedAt: null };
      if (ctx.userId) {
        // PERSONAL: only creator; ORGANIZATION + PUBLIC: all org members.
        // 035-visibility-enum-cleanup: agents use AgentVisibility now; the
        // creator-only draft value is PERSONAL (was PRIVATE).
        where.OR = [
          { visibility: { not: 'PERSONAL' as AgentVisibility } },
          { visibility: 'PERSONAL' as AgentVisibility, createdBy: ctx.userId },
        ];
      } else {
        // No user (App Key / unauthenticated): never expose PERSONAL
        // (creator-only draft) agents.
        where.visibility = { not: 'PERSONAL' as AgentVisibility };
      }
      return ctx.db.agent.findMany({
        where,
        include: { memoryItems: { where: { deletedAt: null, memory: { deletedAt: null } }, include: { memory: true } } },
        orderBy: { name: 'asc' },
      });
    },
    // 008-agent-installation: list grants for this Org. Resolvable only to
    // ADMIN/OWNER of the org. Non-admins get an empty list (silent rather
    // than erroring — same shape as User.appMemberships).
    agentOrgGrants: async (org: { id: string }, _: unknown, ctx: Context) => {
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin && ctx.organizationId !== org.id) return [];
      if (!isPlatformAdmin) {
        const member = await ctx.db.orgMember.findFirst({
          where: {
            organizationId: org.id,
            userId: ctx.userId ?? '',
            deletedAt: null,
            role: { in: ['ADMIN', 'OWNER'] },
          },
        });
        if (!member) return [];
      }
      return ctx.db.agentOrgGrant.findMany({
        where: { orgId: org.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    // 298: Canonicalize URN on read. Converts legacy single-colon hierarchy
    // to canonical spec-021 double-colon form for both legacy and migrated rows.
    urn: (o: { urn?: string | null }) => {
      if (!o.urn) throw new Error('Organization URN is required but not found (partial query?)');
      return safeCanonicalUrn('org', o.urn);
    },
  },
  ExchangeConnection: {
    lastSyncAt: (c: { lastSyncAt?: Date | string | null }) => toISO(c.lastSyncAt),
    createdAt: (c: { createdAt: Date | string }) => toISO(c.createdAt)!,
    updatedAt: (c: { updatedAt: Date | string }) => toISO(c.updatedAt)!,
  },
  SlackConnection: {
    createdAt: (c: { createdAt: Date | string }) => toISO(c.createdAt)!,
    updatedAt: (c: { updatedAt: Date | string }) => toISO(c.updatedAt)!,
  },
  Agent: {
    createdAt: (b: { createdAt: Date | string }) => toISO(b.createdAt)!,
    // 036-ai-service-config: registry-backed reads of the Agent's
    // 'default' config (legacy ai_* columns dropped). Never return the
    // encrypted key itself — only whether one exists + the preview.
    aiProvider: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'agentId', ctx))?.provider ?? null,
    aiModel: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'agentId', ctx))?.model ?? null,
    hasAiApiKey: async (a: { id: string }, _: unknown, ctx: Context) =>
      !!(await defaultAiConfigOf(a, 'agentId', ctx))?.apiKeyEncrypted,
    aiApiKeyPreview: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'agentId', ctx))?.apiKeyPreview ?? null,
    // 008-agent-installation: declarative knobs come back from Prisma as
    // JSON columns. Pass through with sensible defaults (the column has a
    // schema-level DEFAULT, so this is belt-and-braces against partial
    // selects that omit the column).
    memoryProvisioning: (a: { memoryProvisioning?: unknown }) =>
      (a.memoryProvisioning as { appMemory: 'shared' | 'user' | 'none' } | undefined) ??
      { appMemory: 'shared' },
    installationPolicy: (a: { installationPolicy?: unknown }) =>
      (a.installationPolicy as { maxMembers: number | 'unlimited'; memberRoles: string[] } | undefined) ??
      { maxMembers: 'unlimited', memberRoles: ['owner'] },
    imports: async (a: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.agentImport.findMany({
        where: { parentAgentId: a.id },
        orderBy: { position: 'asc' },
      }),
    importedBy: async (a: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.agentImport.findMany({
        where: { importedAgentId: a.id },
        orderBy: { position: 'asc' },
      }),
    // #551 — the Agent's OWN definition (systemPrompt / systemMemoryId /
    // memoryItems / imports / importedBy, above) is public on a PUBLIC agent:
    // reaching the Agent object means the object-level read gate already
    // admitted the caller (PUBLIC → anyone; non-public → members), and the
    // agent's own content is what a marketplace listing publishes.
    //
    // The "who USES this agent" fields below are different: they surface OTHER
    // tenants' data, so they are NOT public. `apps` / `appAgents` return full
    // `App` objects whose own field resolvers (App.keys / App.members) assume
    // the outer org gate already ran — so returning a foreign org's App here
    // would leak its key previews + member list (PR #552 review). Scope them to
    // Apps in orgs the CALLER belongs to (platform ADMIN/OWNER → all): a
    // non-member gets [], and no cross-org App object is ever exposed.
    apps: async (a: { id: string }, _: unknown, ctx: Context) => {
      const where: Record<string, unknown> = {
        appAgents: { some: { agentId: a.id } },
        deletedAt: null,
      };
      if (!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'))) {
        const orgIds = ctx.userId ? await getMemberOrgIds(ctx.db, ctx.userId) : [];
        if (orgIds.length === 0) return [];
        where.organizationId = { in: orgIds };
      }
      return ctx.db.app.findMany({ where, orderBy: { createdAt: 'asc' } });
    },
    // Adoption count — the agent's owning-org view only (a bare number, but
    // still "who uses this"); non-members get 0.
    appCount: async (a: { id: string; organizationId: string }, _: unknown, ctx: Context) => {
      if (!(await isOrgMemberOrAdmin(ctx, a.organizationId))) return 0;
      return ctx.db.app.count({
        where: { appAgents: { some: { agentId: a.id } }, deletedAt: null },
      });
    },
    // 023-app-shape US1: the AppAgent join rows where this Agent is installed.
    // Same caller-org scope as `apps` (each join row eager-loads its `app`).
    appAgents: async (a: { id: string }, _: unknown, ctx: Context) => {
      const appWhere: Record<string, unknown> = { deletedAt: null };
      if (!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'))) {
        const orgIds = ctx.userId ? await getMemberOrgIds(ctx.db, ctx.userId) : [];
        if (orgIds.length === 0) return [];
        appWhere.organizationId = { in: orgIds };
      }
      return ctx.db.appAgent.findMany({
        where: { agentId: a.id, app: appWhere, agent: { deletedAt: null } },
        orderBy: { createdAt: 'asc' },
        include: { app: true, agent: { include: AGENT_INCLUDE } },
      });
    },
    // The agent's customer list (which orgs were granted it) — owning-org view
    // only; non-members get [].
    orgGrants: async (a: { id: string; organizationId: string }, _: unknown, ctx: Context) => {
      if (!(await isOrgMemberOrAdmin(ctx, a.organizationId))) return [];
      return ctx.db.agentOrgGrant.findMany({
        where: { agentId: a.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    // 298: Canonicalize URN on read. Converts legacy single-colon hierarchy
    // to canonical spec-021 double-colon form for both legacy and migrated rows.
    urn: (a: { urn?: string | null }) => {
      if (!a.urn) throw new Error('Agent URN is required but not found (partial query?)');
      return safeCanonicalUrn('agent', a.urn);
    },
  },
  UsageEvent: {
    actionArgs: (event: { actionArgs: unknown }) => deserializeJson(event.actionArgs),
    createdAt: (ue: { createdAt: Date | string }) => toISO(ue.createdAt)!,
    // 046-usage-metering: bigint travels as a base-10 integer String
    // (graphql-js does not serialize bigint to GraphQLString by itself).
    costMicroCents: (ue: { costMicroCents: bigint | null }) =>
      ue.costMicroCents != null ? ue.costMicroCents.toString() : null,
  },

};
