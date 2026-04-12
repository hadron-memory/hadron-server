import bcrypt from 'bcrypt';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { generateId } from '../../../lib/id.js';
import { parseUrnInput, validateUrnType } from '../../../lib/urn.js';
import { compileTemplate } from '../../../lib/template.js';
import type { InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import type { PrismaClient, Role, StationType, MemoryVisibility, Prisma } from '../../../generated/prisma/index.js';
import { deserializeTags, serializeTags, serializeJson, deserializeJson, searchContains, tagsFilter } from '../../../integrations/db/provider.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { syncGraphFromGithub } from '../../../integrations/github/syncGraphFromGithub.js';
import { createNode } from '../../../controller/operations/createNode.js';
import {
  listInboxMessages,
  replyToMessage,
  moveMessage,
  listFolders,
  extractErrorMessage,
} from '../../../integrations/exchange/exchange.js';

export interface Context {
  db: PrismaClient;
  clientId?: string;       // Station.id or "github:<username>"
  userId?: string;         // User.id — only set for OAuth/JWT users
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  organizationId?: string; // set when the Client is scoped to an organization
}

const ROLE_ORDER: Record<string, number> = { READER: 0, CONTRIBUTOR: 1, ADMIN: 2, OWNER: 3 };

function requireRole(ctx: Context, required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER') {
  const highest = ctx.roles ? Math.max(...ctx.roles.map((r) => ROLE_ORDER[r] ?? -1)) : -1;
  if (highest < ROLE_ORDER[required]) throw new Error('Forbidden');
}

async function requireOrgRole(
  ctx: Context,
  orgId: string,
  required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER',
): Promise<void> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;
  if (!ctx.userId) throw new Error('Forbidden');
  const member = await ctx.db.orgMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
  });
  if (!member || (ROLE_ORDER[member.role] ?? -1) < ROLE_ORDER[required]) {
    throw new Error('Forbidden');
  }
}

// ── Memory access control ──────────────────────────────────────────────

/**
 * Returns the memory IDs accessible to the current caller, or null if the
 * caller has unrestricted access (global ADMIN/OWNER).
 *
 * - Clients: memories from agent subscriptions only
 * - Users: memories from org memberships + cross-org subscriptions + public memories
 * - Unauthenticated: public memories only
 */
async function getAccessibleMemoryIds(ctx: Context): Promise<string[] | null> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return null;

  // API-key client — memories from agent subscriptions
  if (ctx.clientId && !ctx.userId) {
    const subs = await ctx.db.stationAgentSubscription.findMany({
      where: { stationId: ctx.clientId, deletedAt: null },
      include: { agent: { include: { memoryItems: { select: { memoryId: true } } } } },
    });
    const ids: string[] = [];
    for (const sub of subs) {
      for (const item of sub.agent.memoryItems) ids.push(item.memoryId);
    }
    return ids;
  }

  // JWT user — org memories (respecting visibility) + subscribed memories + public memories
  if (ctx.userId) {
    const memberships = await ctx.db.orgMember.findMany({
      where: { userId: ctx.userId, deletedAt: null },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);
    const memories = await ctx.db.memory.findMany({
      where: {
        deletedAt: null,
        OR: [
          // Org memories: ORGANIZATION or PUBLIC visible to all members, PRIVATE only to creator
          ...(orgIds.length > 0
            ? [
                { organizationId: { in: orgIds }, visibility: { not: 'PRIVATE' as any } },
                { organizationId: { in: orgIds }, visibility: 'PRIVATE' as any, createdBy: ctx.userId },
                { subscriptions: { some: { organizationId: { in: orgIds } } } },
              ]
            : []),
          { visibility: 'PUBLIC' as any },
        ],
      },
      select: { id: true },
    });
    return memories.map((g: { id: string }) => g.id);
  }

  // Unauthenticated — public memories only
  const publicMemories = await ctx.db.memory.findMany({
    where: { visibility: 'PUBLIC', deletedAt: null },
    select: { id: true },
  });
  return publicMemories.map((g) => g.id);
}

/** Prisma `where` clause that restricts sessions to the caller's scope. */
async function sessionScopeFilter(ctx: Context): Promise<Record<string, unknown>> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return {};
  if (ctx.clientId && !ctx.userId) return { customerId: ctx.clientId };
  if (ctx.userId) {
    const stations = await ctx.db.station.findMany({
      where: { userId: ctx.userId, deletedAt: null },
      select: { id: true },
    });
    return { customerId: { in: stations.map((s) => s.id) } };
  }
  return { id: '__none__' }; // unauthenticated — no sessions
}

/** Prisma `where` clause that restricts nodes to accessible memories. */
async function memoryAccessFilter(ctx: Context): Promise<Record<string, unknown>> {
  const ids = await getAccessibleMemoryIds(ctx);
  return ids === null ? {} : { memoryId: { in: ids } };
}

/**
 * Deduplicate nodes by loc: when multiple nodes share the same loc across
 * different memories, prefer canonical (isLink=false) over link nodes.
 */
function deduplicateNodes<T extends { loc: string; isLink: boolean }>(nodes: T[]): T[] {
  const byLoc = new Map<string, T>();
  for (const node of nodes) {
    const existing = byLoc.get(node.loc);
    if (!existing || (existing.isLink && !node.isLink)) {
      byLoc.set(node.loc, node);
    }
  }
  return Array.from(byLoc.values());
}

/**
 * Verify the caller has write access to a specific memory.
 *
 * Checks (most restrictive wins):
 * 1. Global ADMIN/OWNER — always allowed
 * 2. Clients: role >= CONTRIBUTOR, bundle subscription is READ_WRITE
 * 3. Users: org member with CONTRIBUTOR+, or cross-org subscription with CONTRIBUTOR role
 */
async function requireMemoryWriteAccess(ctx: Context, memoryId: string): Promise<void> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;

  // API-key client path
  if (ctx.clientId && !ctx.userId) {
    const highestRole = Math.max(...(ctx.roles ?? []).map((r) => ROLE_ORDER[r] ?? -1));
    if (highestRole < ROLE_ORDER['CONTRIBUTOR']) {
      throw new Error('Forbidden: station role insufficient for writes');
    }
    const sub = await ctx.db.stationAgentSubscription.findFirst({
      where: {
        stationId: ctx.clientId,
        deletedAt: null,
        subscriptionType: 'READ_WRITE',
        agent: { memoryItems: { some: { memoryId } } },
      },
    });
    if (!sub) throw new Error('Forbidden: no write access to this memory');
    return;
  }

  // JWT user path
  if (!ctx.userId) throw new Error('Unauthenticated');

  const memory = await ctx.db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: { organizationId: true },
  });

  // Direct org member with CONTRIBUTOR+?
  const member = await ctx.db.orgMember.findUnique({
    where: { organizationId_userId: { organizationId: memory.organizationId, userId: ctx.userId } },
  });
  if (member && (ROLE_ORDER[member.role] ?? -1) >= ROLE_ORDER['CONTRIBUTOR']) return;

  // Cross-org subscription with CONTRIBUTOR role?
  const userOrgs = await ctx.db.orgMember.findMany({
    where: {
      userId: ctx.userId,
      deletedAt: null,
      role: { in: ['CONTRIBUTOR', 'ADMIN', 'OWNER'] as any },
    },
    select: { organizationId: true },
  });
  for (const uo of userOrgs) {
    const memorySub = await ctx.db.memorySubscription.findUnique({
      where: { memoryId_organizationId: { memoryId, organizationId: uo.organizationId } },
    });
    if (memorySub && (ROLE_ORDER[memorySub.role] ?? -1) >= ROLE_ORDER['CONTRIBUTOR']) return;
  }

  throw new Error('Forbidden: no write access to this memory');
}

const MEMORY_INCLUDE = {
  subscriptions: { include: { organization: true }, orderBy: { createdAt: 'asc' as const } },
};

const ORG_INCLUDE = {
  members: { include: { user: true }, orderBy: { createdAt: 'asc' as const } },
  memories: { include: MEMORY_INCLUDE, orderBy: { name: 'asc' as const } },
  agents: { include: { memoryItems: { include: { memory: true } } }, orderBy: { name: 'asc' as const } },
  subscriptions: { include: { memory: true, organization: true }, orderBy: { createdAt: 'asc' as const } },
  exchangeConnections: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' as const } },
};

const AGENT_INCLUDE = {
  memoryItems: { include: { memory: { include: MEMORY_INCLUDE } } },
};

const STATION_INCLUDE = {
  agentSubscriptions: { include: { agent: { include: AGENT_INCLUDE } }, orderBy: { createdAt: 'asc' as const } },
};

const SESSION_INCLUDE = { events: { orderBy: { createdAt: 'desc' as const }, take: 50 } };

const toISO = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

function getEncryptionKey(): Buffer {
  const key = process.env.HADRON_ENCRYPTION_KEY;
  if (!key) throw new Error('HADRON_ENCRYPTION_KEY env var is required');
  return Buffer.from(key, 'hex');
}

function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function getExchangeRefreshToken(
  ctx: Context,
  connectionId: string,
): Promise<{ refreshToken: string; connection: any }> {
  const connection = await ctx.db.exchangeConnection.findUniqueOrThrow({
    where: { id: connectionId },
  });
  if (connection.deletedAt) throw new Error('Connection not found');
  await requireOrgRole(ctx, connection.organizationId, 'READER');
  return {
    refreshToken: decryptToken(connection.refreshTokenEncrypted),
    connection,
  };
}

export const resolvers = {
  Node: {
    tags: (node: { tags: string | string[] }) => deserializeTags(node.tags),
  },
  Memory: {
    lastSyncedAt: (g: { lastSyncedAt?: Date | string | null }) => toISO(g.lastSyncedAt),
    createdAt: (g: { createdAt: Date | string }) => toISO(g.createdAt)!,
    updatedAt: (g: { updatedAt: Date | string }) => toISO(g.updatedAt)!,
    organization: (g: { organizationId: string; organization?: unknown }, _: unknown, ctx: Context) =>
      (g as Record<string, unknown>).organization ??
      ctx.db.organization.findUnique({ where: { id: g.organizationId } }),
  },
  Organization: {
    createdAt: (o: { createdAt: Date | string }) => toISO(o.createdAt)!,
    updatedAt: (o: { updatedAt: Date | string }) => toISO(o.updatedAt)!,
    hasGithubAppPrivateKey: (o: { githubAppPrivateKeyEncrypted?: string | null }) => !!o.githubAppPrivateKeyEncrypted,
    agents: async (org: { id: string }, _: unknown, ctx: Context) => {
      const where: Record<string, unknown> = { organizationId: org.id, deletedAt: null };
      if (ctx.userId) {
        // PRIVATE: only creator; ORGANIZATION + PUBLIC: all org members
        where.OR = [
          { visibility: { not: 'PRIVATE' as MemoryVisibility } },
          { visibility: 'PRIVATE' as MemoryVisibility, createdBy: ctx.userId },
        ];
      } else if (ctx.clientId) {
        // Station access: only ORGANIZATION and PUBLIC agents
        where.visibility = { not: 'PRIVATE' as MemoryVisibility };
      }
      return ctx.db.agent.findMany({
        where,
        include: { memoryItems: { include: { memory: true } } },
        orderBy: { name: 'asc' },
      });
    },
  },
  ExchangeConnection: {
    lastSyncAt: (c: { lastSyncAt?: Date | string | null }) => toISO(c.lastSyncAt),
    createdAt: (c: { createdAt: Date | string }) => toISO(c.createdAt)!,
    updatedAt: (c: { updatedAt: Date | string }) => toISO(c.updatedAt)!,
  },
  Station: {
    createdAt: (c: { createdAt: Date | string }) => toISO(c.createdAt)!,
    lastUsedAt: (c: { lastUsedAt?: Date | string | null }) => toISO(c.lastUsedAt),
    expiresAt: (c: { expiresAt?: Date | string | null }) => toISO(c.expiresAt),
    hasAiApiKey: (c: { aiApiKeyEncrypted?: string | null }) => !!c.aiApiKeyEncrypted,
    user: (station: { userId?: string | null }, _: unknown, ctx: Context) =>
      station.userId ? ctx.db.user.findUnique({ where: { id: station.userId } }) : null,
    agentSubscriptions: (station: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.stationAgentSubscription.findMany({
        where: { stationId: station.id },
        include: { agent: { include: AGENT_INCLUDE } },
        orderBy: { createdAt: 'asc' as const },
      }),
  },
  StationKey: {
    createdAt: (k: { createdAt: Date | string }) => toISO(k.createdAt)!,
    lastUsedAt: (k: { lastUsedAt?: Date | string | null }) => toISO(k.lastUsedAt),
    revokedAt: (k: { revokedAt?: Date | string | null }) => toISO(k.revokedAt),
  },
  Agent: {
    createdAt: (b: { createdAt: Date | string }) => toISO(b.createdAt)!,
  },
  Session: {
    outcomeMeta: (session: { outcomeMeta: unknown }) => deserializeJson(session.outcomeMeta),
  },
  UsageEvent: {
    actionArgs: (event: { actionArgs: unknown }) => deserializeJson(event.actionArgs),
  },

  Query: {
    node: async (_: unknown, { loc: rawLoc, raw }: { loc: string; raw?: boolean }, ctx: Context) => {
      const parsed = parseUrnInput(rawLoc);
      const typeErr = validateUrnType(parsed, 'node');
      if (typeErr) throw new Error(typeErr);
      const loc = parsed.value;

      const access = await memoryAccessFilter(ctx);
      const candidates = await ctx.db.node.findMany({
        where: { loc, ...access },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      if (candidates.length === 0) return null;
      const node = candidates.find((n) => !n.isLink) ?? candidates[0];

      // Compile Mustache templates unless raw: true
      if (!raw && node.content?.includes('{{')) {
        const compiled = await compileTemplate(
          node.content, node.data as Record<string, unknown> | null, node.memoryId, ctx.db, access,
        );
        return { ...node, content: compiled };
      }
      return node;
    },

    nodeById: async (_: unknown, { id, raw }: { id: string; raw?: boolean }, ctx: Context) => {
      const access = await memoryAccessFilter(ctx);
      const node = await ctx.db.node.findUnique({
        where: { id },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      if (!node) return null;
      if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
        if (!(access.memoryId.in as string[]).includes(node.memoryId)) return null;
      }

      if (!raw && node.content?.includes('{{')) {
        const compiled = await compileTemplate(
          node.content, node.data as Record<string, unknown> | null, node.memoryId, ctx.db, access,
        );
        return { ...node, content: compiled };
      }
      return node;
    },

    nodes: async (
      _: unknown,
      { nodeType, tags, search, prefix: rawPrefix, limit, offset }: { nodeType?: string; tags?: string[]; search?: string; prefix?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      const prefix = rawPrefix ? parseUrnInput(rawPrefix).value : undefined;
      const access = await memoryAccessFilter(ctx);
      const results = await ctx.db.node.findMany({
        where: {
          ...access,
          // Exclude system nodes from search by default (unless explicitly requested)
          ...(nodeType ? { nodeType } : search ? { nodeType: { not: 'system' } } : {}),
          ...(tags?.length ? tagsFilter(tags) : {}),
          ...(prefix ? { loc: { startsWith: prefix } } : {}),
          ...(search
            ? {
                OR: [
                  searchContains('name', search),
                  searchContains('description', search),
                  searchContains('content', search),
                ],
              }
            : {}),
        },
        orderBy: { loc: 'asc' },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      // Sort by nodeType priority: abstract first, then info/reference, then record
      const typePriority: Record<string, number> = { abstract: 0, info: 1, reference: 1, record: 2, system: 3 };
      const sorted = deduplicateNodes(results).sort((a, b) =>
        (typePriority[a.nodeType] ?? 1) - (typePriority[b.nodeType] ?? 1)
      );
      return sorted.slice(offset ?? 0, (offset ?? 0) + (limit ?? 100));
    },

    subtree: async (_: unknown, { prefix: rawPrefix }: { prefix: string }, ctx: Context) => {
      const prefix = parseUrnInput(rawPrefix).value;
      const access = await memoryAccessFilter(ctx);
      const results = await ctx.db.node.findMany({
        where: { ...access, loc: { startsWith: prefix } },
        orderBy: { loc: 'asc' },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      return deduplicateNodes(results);
    },

    nodeUsage: async (_: unknown, { loc, limit }: { loc: string; limit?: number }, ctx: Context) => {
      return ctx.db.usageEvent.findMany({
        where: { nodeLoc: loc },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
    },

    memoryUsageSummary: async (_: unknown, { memoryId }: { memoryId: string }, ctx: Context) => {
      // Get all node locs belonging to this memory
      const nodes = await ctx.db.node.findMany({
        where: { memoryId },
        select: { loc: true },
      });
      const locs = nodes.map((n: { loc: string }) => n.loc);
      if (!locs.length) return [];

      const rows = await ctx.db.usageEvent.groupBy({
        by: ['nodeLoc', 'type'],
        where: { nodeLoc: { in: locs } },
        _count: { id: true },
      });
      return rows.map((r: { nodeLoc: string | null; type: string; _count: { id: number } }) => ({
        nodeLoc: r.nodeLoc,
        type: r.type,
        count: r._count.id,
      }));
    },

    nodeVersions: async (_: unknown, { nodeId, limit }: { nodeId: string; limit?: number }, ctx: Context) => {
      return ctx.db.nodeVersion.findMany({
        where: { nodeId },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
    },

    sessions: async (
      _: unknown,
      { type, repo, customerId, limit, offset }: { type?: string; repo?: string; customerId?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      // ADMIN/OWNER see all; stations see their own; users see their stations' sessions
      const scopeFilter = await sessionScopeFilter(ctx);
      return ctx.db.session.findMany({
        where: {
          ...scopeFilter,
          ...(type ? { type: type as any } : {}),
          ...(repo ? { repo } : {}),
          ...(customerId ? { customerId } : {}),
        },
        orderBy: { startedAt: 'desc' },
        take: limit ?? 50,
        skip: offset ?? 0,
        include: SESSION_INCLUDE,
      });
    },

    session: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const session = await ctx.db.session.findUnique({ where: { id }, include: SESSION_INCLUDE });
      if (!session) return null;
      // ADMIN/OWNER can see any session
      if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return session;
      // Station can see its own sessions
      if (ctx.clientId && session.customerId === ctx.clientId) return session;
      // User can see sessions from their stations
      if (ctx.userId) {
        const station = session.customerId ? await ctx.db.station.findUnique({ where: { id: session.customerId } }) : null;
        if (station?.userId === ctx.userId) return session;
      }
      return null;
    },

    usageEvents: async (
      _: unknown,
      { type, nodeLoc, limit, offset }: { type?: string; nodeLoc?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      return ctx.db.usageEvent.findMany({
        where: {
          ...(type ? { type } : {}),
          ...(nodeLoc ? { nodeLoc: { contains: nodeLoc } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
        skip: offset ?? 0,
      });
    },

    stations: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.station.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
    },

    station: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.station.findUnique({ where: { id } });
    },

    myStation: async (_: unknown, __: unknown, ctx: Context) => {
      // Returns the station for the current API key (clientId = station ID)
      if (!ctx.clientId) return null;
      return ctx.db.station.findUnique({
        where: { id: ctx.clientId, deletedAt: null },
        include: STATION_INCLUDE,
      });
    },

    myStations: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return [];
      return ctx.db.station.findMany({
        where: { userId: ctx.userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    },

    stationNodes: async (
      _: unknown,
      { stationId, limit }: { stationId: string; limit?: number },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      // Verify caller owns this station or is ADMIN
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (ctx.clientId && ctx.clientId !== stationId) throw new Error('Forbidden');
        if (ctx.userId) {
          const station = await ctx.db.station.findUnique({ where: { id: stationId } });
          if (!station || station.userId !== ctx.userId) throw new Error('Forbidden');
        }
      }
      // Get all memory IDs accessible by this station
      const subs = await ctx.db.stationAgentSubscription.findMany({
        where: { stationId, deletedAt: null },
        include: { agent: { include: { memoryItems: true } } },
      });
      const memoryIds = [...new Set(subs.flatMap((s: any) => s.agent.memoryItems.map((m: any) => m.memoryId)))];
      if (memoryIds.length === 0) return [];

      return ctx.db.node.findMany({
        where: { memoryId: { in: memoryIds }, deletedAt: null },
        orderBy: { loc: 'asc' },
        take: limit ?? 500,
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
          memory: { select: { id: true, urn: true, name: true, organizationId: true } },
        },
      });
    },

    stationAIConfig: async (_: unknown, { stationId }: { stationId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      const station = await ctx.db.station.findUniqueOrThrow({ where: { id: stationId } });
      if (station.userId !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) throw new Error('Forbidden');
      if (!station.aiProvider || !station.aiModel || !station.aiApiKeyEncrypted) return null;
      return {
        provider: station.aiProvider,
        apiKey: decryptToken(station.aiApiKeyEncrypted),
        model: station.aiModel,
      };
    },

    stationKeys: async (_: unknown, { stationId }: { stationId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      const station = await ctx.db.station.findUniqueOrThrow({ where: { id: stationId } });
      // Owner sees own keys; org admins see all keys
      const isAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      const where: Record<string, unknown> = { stationId, revokedAt: null };
      if (!isAdmin) where.userId = ctx.userId;
      return ctx.db.stationKey.findMany({ where, orderBy: { createdAt: 'desc' as const } });
    },

    users: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
    },

    searchUsers: async (_: unknown, { query }: { query: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return ctx.db.user.findMany({
        where: {
          deletedAt: null,
          OR: [
            searchContains('name', query),
            searchContains('email', query),
            searchContains('githubUsername', query),
          ],
        },
        take: 20,
        orderBy: { name: 'asc' },
      });
    },

    me: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return null;
      return ctx.db.user.findUnique({ where: { id: ctx.userId } });
    },

    organizations: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.organization.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, include: ORG_INCLUDE });
    },

    myOrganizations: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return [];
      const memberships = await ctx.db.orgMember.findMany({
        where: { userId: ctx.userId, deletedAt: null },
        include: { organization: { include: ORG_INCLUDE } },
      });
      return memberships.map((m: any) => m.organization);
    },

    organization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: id, userId: ctx.userId } },
        });
        if (!member) throw new Error('Forbidden');
      }
      return ctx.db.organization.findUnique({ where: { id }, include: ORG_INCLUDE });
    },

    invitation: async (_: unknown, { slug }: { slug: string }, ctx: Context) => {
      const invite = await ctx.db.userInvitation.findUnique({
        where: { slug },
        include: {
          sender: true,
          organization: true,
          activations: true,
        },
      });
      if (!invite || invite.deletedAt) return null;
      return {
        ...invite,
        activationCount: invite.activations.length,
      };
    },

    publicMemories: async (_: unknown, __: unknown, ctx: Context) => {
      return ctx.db.memory.findMany({
        where: { visibility: 'PUBLIC', deletedAt: null },
        orderBy: { name: 'asc' },
        include: MEMORY_INCLUDE,
      });
    },

    myMemories: async (_: unknown, __: unknown, ctx: Context) => {
      // API-key client — return memories from agent subscriptions
      if (ctx.clientId && !ctx.userId) {
        const subs = await ctx.db.stationAgentSubscription.findMany({
          where: { stationId: ctx.clientId, deletedAt: null },
          include: { agent: { include: { memoryItems: { include: { memory: { include: MEMORY_INCLUDE } } } } } },
        });
        const memoryMap = new Map<string, any>();
        for (const sub of subs) {
          for (const item of sub.agent.memoryItems) {
            memoryMap.set(item.memory.id, item.memory);
          }
        }
        return Array.from(memoryMap.values());
      }
      // JWT/OAuth user — union of all org-accessible memories
      if (ctx.userId) {
        const memberships = await ctx.db.orgMember.findMany({
          where: { userId: ctx.userId, deletedAt: null },
          select: { organizationId: true },
        });
        const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);
        if (orgIds.length === 0) return [];
        return ctx.db.memory.findMany({
          where: {
            deletedAt: null,
            OR: [
              { organizationId: { in: orgIds } },
              { subscriptions: { some: { organizationId: { in: orgIds } } } },
            ],
          },
          include: MEMORY_INCLUDE,
          orderBy: { name: 'asc' },
        });
      }
      throw new Error('Unauthenticated');
    },

    // ── Exchange integration queries ────────────────────────────────────

    exchangeConnections: async (_: unknown, { orgId }: { orgId: string }, ctx: Context) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.exchangeConnection.findMany({
        where: { organizationId: orgId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
    },

    exchangeMessages: async (
      _: unknown,
      { connectionId, top, filter }: { connectionId: string; top?: number; filter?: string },
      ctx: Context,
    ) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      const result = await listInboxMessages(refreshToken, { top: top ?? 25, filter: filter ?? undefined });
      return result.data.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from?.emailAddress?.address ?? null,
        receivedDateTime: m.receivedDateTime,
        isRead: m.isRead,
        bodyPreview: m.bodyPreview,
        body: m.body?.content ?? null,
        hasAttachments: m.hasAttachments,
      }));
    },

    exchangeFolders: async (_: unknown, { connectionId }: { connectionId: string }, ctx: Context) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      const result = await listFolders(refreshToken);
      return result.data;
    },
  },

  Mutation: {
    upsertNode: async (_: unknown, { input }: { input: NodeInput }, ctx: Context) => {
      // Resolve memoryId from loc prefix when not provided
      if (!input.memoryId) {
        const memories = await ctx.db.memory.findMany({
          where: { deletedAt: null },
          select: { id: true, urn: true },
        });
        const match = memories
          .filter((m) => m.urn && input.loc.startsWith(m.urn))
          .sort((a, b) => b.urn.length - a.urn.length)[0];
        if (match) {
          input.memoryId = match.id;
          // Strip memory URN prefix from loc — loc should be memory-relative
          const prefix = match.urn + ':';
          if (input.loc.startsWith(prefix)) {
            input.loc = input.loc.slice(prefix.length);
          }
        } else {
          throw new Error(`Cannot resolve memory for loc "${input.loc}". Provide a memoryId or set an active memory.`);
        }
      }
      await requireMemoryWriteAccess(ctx, input.memoryId);

      // Snapshot current state before update (for version history)
      const existing = await ctx.db.node.findUnique({
        where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
      });
      if (existing) {
        await ctx.db.nodeVersion.create({
          data: {
            nodeId: existing.id,
            loc: existing.loc,
            name: existing.name,
            alias: existing.alias,
            description: existing.description,
            content: existing.content,
            tags: existing.tags as string[],
            editedBy: ctx.clientId ?? ctx.userId ?? null,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
        });
      }

      const tags = serializeTags(input.tags ?? []) as string[];
      const id = input.id ?? generateId();
      const { edges, ...nodeFields } = input;
      const createdBy = ctx.userId ?? ctx.clientId ?? null;
      const node = await ctx.db.node.upsert({
        where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
        create: { ...nodeFields, id, tags, createdBy },
        update: { ...nodeFields, tags },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });

      let finalNode = node;
      if (edges !== undefined) {
        await ctx.db.edge.deleteMany({ where: { sourceId: node.id } });
        await ctx.db.pendingEdge.deleteMany({ where: { sourceId: node.id } });
        for (const e of edges) {
          const target = await ctx.db.node.findUnique({ where: { id: e.targetId } });
          if (target) {
            await ctx.db.edge.upsert({
              where: { sourceId_targetId_label: { sourceId: node.id, targetId: target.id, label: e.label ?? '' } },
              create: { sourceId: node.id, targetId: target.id, label: e.label ?? '', createdBy },
              update: {},
            });
          } else {
            await ctx.db.pendingEdge.upsert({
              where: { sourceId_targetId: { sourceId: node.id, targetId: e.targetId } },
              create: { sourceId: node.id, targetId: e.targetId, label: e.label ?? null, createdBy },
              update: { label: e.label ?? null },
            });
          }
        }
        finalNode = (await ctx.db.node.findUnique({
          where: { id: node.id },
          include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
        }))!;
      }

      writeNodeToGit({
        id: finalNode.id,
        loc: finalNode.loc,
        name: finalNode.name,
        alias: finalNode.alias,
        description: finalNode.description,
        content: finalNode.content,
        tags: deserializeTags(finalNode.tags) as string[],
        outgoingEdges: finalNode.outgoingEdges ?? [],
      }, input.ownerRepo ?? '', ctx.clientId, input.memoryId).catch((err) => {
        console.error('[upsertNode] git write error:', err);
      });

      return finalNode;
    },

    deleteNode: async (_: unknown, { loc: rawLoc, memoryId }: { loc: string; memoryId: string }, ctx: Context) => {
      const loc = parseUrnInput(rawLoc).value;
      await requireMemoryWriteAccess(ctx, memoryId);
      await ctx.db.node.delete({ where: { loc_memoryId: { loc, memoryId } } });
      return true;
    },

    moveNode: async (_: unknown, { from: rawFrom, to: rawTo, memoryId, targetMemoryId }: { from: string; to: string; memoryId: string; targetMemoryId?: string }, ctx: Context) => {
      const from = parseUrnInput(rawFrom).value;
      const to = parseUrnInput(rawTo).value;
      await requireMemoryWriteAccess(ctx, memoryId);
      if (targetMemoryId && targetMemoryId !== memoryId) {
        await requireMemoryWriteAccess(ctx, targetMemoryId);
      }
      const destMemoryId = targetMemoryId ?? memoryId;
      return ctx.db.node.update({
        where: { loc_memoryId: { loc: from, memoryId } },
        data: { loc: to, memoryId: destMemoryId },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    replaceSubtree: async (
      _: unknown,
      {
        ownerRepo,
        memoryId,
        nodes,
        edges,
      }: { ownerRepo: string; memoryId: string; nodes: NodeInput[]; edges: EdgeInput[] },
      ctx: Context,
    ) => {
      await requireMemoryWriteAccess(ctx, memoryId);

      await ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.node.deleteMany({ where: { ownerRepo, memoryId } });

        for (const input of nodes) {
          await tx.node.create({
            data: {
              id: input.id ?? generateId(),
              ...input,
              tags: serializeTags(input.tags ?? []) as string[],
            },
          });
        }

        for (const edge of edges) {
          const source = await tx.node.findUnique({ where: { loc_memoryId: { loc: edge.sourceLoc, memoryId } } });
          const target = await tx.node.findFirst({ where: { loc: edge.targetLoc } });
          if (source && target) {
            await tx.edge.upsert({
              where: { sourceId_targetId_label: { sourceId: source.id, targetId: target.id, label: edge.label } },
              create: { sourceId: source.id, targetId: target.id, label: edge.label },
              update: {},
            });
          }
        }
      });

      return nodes.length;
    },

    startSession: async (_: unknown, { input }: { input: SessionInput }, ctx: Context) => {
      return ctx.db.session.create({
        data: {
          id: input.id,
          type: (input.type as any) ?? 'DEVELOPER',
          stationId: ctx.clientId?.startsWith('github:') ? undefined : ctx.clientId,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
          repo: input.repo,
          branch: input.branch,
          prNumber: input.prNumber,
          customerId: input.customerId,
          language: input.language,
          llmModel: input.llmModel,
          parentSessionId: input.parentSessionId,
          prevSessionId: input.prevSessionId,
        },
        include: SESSION_INCLUDE,
      });
    },

    endSession: async (
      _: unknown,
      {
        id,
        summary,
        inputTokens,
        outputTokens,
        turnCount,
        errorCount,
      }: { id: string; summary?: string; inputTokens?: number; outputTokens?: number; turnCount?: number; errorCount?: number },
      ctx: Context,
    ) => {
      return ctx.db.session.update({
        where: { id },
        data: { endedAt: new Date(), summary, inputTokens, outputTokens, turnCount, errorCount },
        include: SESSION_INCLUDE,
      });
    },

    recordUsage: async (_: unknown, { event }: { event: UsageEventInput }, ctx: Context) => {
      const node = event.nodeLoc
        ? await ctx.db.node.findFirst({ where: { loc: event.nodeLoc, isLink: false } })
          ?? await ctx.db.node.findFirst({ where: { loc: event.nodeLoc } })
        : null;

      await ctx.db.usageEvent.create({
        data: {
          type: event.type,
          nodeLoc: event.nodeLoc,
          nodeId: node?.id,
          actionArgs: serializeJson(event.actionArgs) as InputJsonValue | undefined,
          stationId: ctx.clientId?.startsWith('github:') ? undefined : ctx.clientId,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
          sessionId: event.sessionId,
          model: event.model,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
        },
      });
      return true;
    },

    createStation: async (
      _: unknown,
      {
        name,
        stationType,
        role,
        description,
        systemPrompt,
        organizationId,
        userId,
        expiresAt,
        agentTools,
        aiProvider,
        aiModel,
        aiApiKey,
      }: {
        name: string;
        stationType: string;
        role: string;
        description?: string;
        systemPrompt?: string;
        organizationId?: string;
        userId?: string;
        expiresAt?: string;
        agentTools?: string[];
        aiProvider?: string;
        aiModel?: string;
        aiApiKey?: string;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      const rawKey = randomBytes(32).toString('hex');
      const keyHash = await bcrypt.hash(rawKey, 12);

      // Generate URN from org + name
      let urn = name;
      if (organizationId) {
        const org = await ctx.db.organization.findUnique({ where: { id: organizationId }, select: { urn: true } });
        if (org) urn = `${org.urn}:${name}`;
      }

      const station = await ctx.db.station.create({
        data: {
          name,
          urn,
          keyHash,
          stationType: stationType as StationType,
          description: description ?? null,
          systemPrompt: systemPrompt ?? null,
          role: role as Role,
          agentTools: agentTools ?? [],
          aiProvider: aiProvider ?? null,
          aiModel: aiModel ?? null,
          aiApiKeyEncrypted: aiApiKey ? encryptToken(aiApiKey) : null,
          organizationId: organizationId ?? null,
          userId: userId ?? ctx.userId ?? null,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });
      const dateStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const sanitizedName = name.replace(/[^a-zA-Z0-9._:-]/g, '-').replace(/-+/g, '-').toLowerCase();
      const sanitizedUrn = urn.replace(/[^a-zA-Z0-9._:-]/g, '-').replace(/-+/g, '-').toLowerCase();
      const prefixedKey = `${sanitizedUrn}/${sanitizedName}/${dateStamp}/${rawKey}`;
      return { station, rawKey: prefixedKey };
    },

    updateStation: async (
      _: unknown,
      { id, name, urn, stationType, description, systemPrompt, agentTools, aiProvider, aiModel, aiApiKey }: {
        id: string; name?: string; urn?: string; stationType?: string; description?: string; systemPrompt?: string; agentTools?: string[];
        aiProvider?: string; aiModel?: string; aiApiKey?: string;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      const existing = await ctx.db.station.findUniqueOrThrow({ where: { id } });
      if (existing.userId !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) throw new Error('Forbidden');
      return ctx.db.station.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(urn !== undefined ? { urn } : {}),
          ...(stationType !== undefined ? { stationType: stationType as any } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(agentTools !== undefined ? { agentTools } : {}),
          ...(aiProvider !== undefined ? { aiProvider } : {}),
          ...(aiModel !== undefined ? { aiModel } : {}),
          ...(aiApiKey !== undefined ? { aiApiKeyEncrypted: aiApiKey ? encryptToken(aiApiKey) : null } : {}),
        },
      });
    },

    regenerateApiKey: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      const existing = await ctx.db.station.findUniqueOrThrow({ where: { id } });
      if (existing.userId !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) throw new Error('Forbidden');
      const rawKey = randomBytes(32).toString('hex');
      const keyHash = await bcrypt.hash(rawKey, 12);
      const station = await ctx.db.station.update({ where: { id }, data: { keyHash, apiKeyShown: false } });
      const dateStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const sanitizedName = (existing.name ?? 'key').replace(/[^a-zA-Z0-9._:-]/g, '-').replace(/-+/g, '-').toLowerCase();
      const sanitizedUrn = existing.urn.replace(/[^a-zA-Z0-9._:-]/g, '-').replace(/-+/g, '-').toLowerCase();
      const prefixedKey = `${sanitizedUrn}/${sanitizedName}/${dateStamp}/${rawKey}`;
      return { station, rawKey: prefixedKey };
    },

    revokeStation: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      const existing = await ctx.db.station.findUnique({ where: { id } });
      if (!existing) throw new Error('Station not found');
      if (existing.userId !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) throw new Error('Forbidden');
      await ctx.db.station.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },

    // ── Station key management ────────────────────────────────────────

    createStationKey: async (
      _: unknown,
      { stationId, label }: { stationId: string; label?: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      if (!ctx.userId) throw new Error('Unauthenticated');
      const station = await ctx.db.station.findUniqueOrThrow({ where: { id: stationId } });
      if (station.userId !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) throw new Error('Forbidden');

      const rawKey = randomBytes(32).toString('hex');
      const keyHash = await bcrypt.hash(rawKey, 12);
      const keyPreview = rawKey.slice(-4);

      const dateStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const sanitizedLabel = (label ?? 'key').replace(/[^a-zA-Z0-9._:-]/g, '-').replace(/-+/g, '-').toLowerCase();

      const key = await ctx.db.stationKey.create({
        data: {
          stationId,
          userId: ctx.userId,
          keyHash,
          keyPreview,
          label: label ?? null,
          createdBy: ctx.userId,
        },
      });

      const prefixedKey = `${sanitizedLabel}/${dateStamp}/${rawKey}`;
      return { key, rawKey: prefixedKey };
    },

    revokeStationKey: async (_: unknown, { keyId }: { keyId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      if (!ctx.userId) throw new Error('Unauthenticated');
      const key = await ctx.db.stationKey.findUniqueOrThrow({ where: { id: keyId } });
      // Owner of the key or org admin can revoke
      const isAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (key.userId !== ctx.userId && !isAdmin) throw new Error('Forbidden');
      await ctx.db.stationKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
      return true;
    },

    // ── Station agent subscriptions ─────────────────────────────────────

    subscribeStationToAgent: async (
      _: unknown,
      { stationId, agentId, subscriptionType, trainingMode }: { stationId: string; agentId: string; subscriptionType?: string; trainingMode?: boolean },
      ctx: Context,
    ) => {
      const station = await ctx.db.station.findUniqueOrThrow({ where: { id: stationId } });
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });

      if (station.organizationId) {
        await requireOrgRole(ctx, station.organizationId, 'ADMIN');
      } else {
        if (station.userId !== ctx.userId && !ctx.roles?.includes('ADMIN')) throw new Error('Forbidden');
      }

      await ctx.db.stationAgentSubscription.upsert({
        where: { stationId_agentId: { stationId, agentId } },
        create: {
          stationId,
          agentId,
          subscriptionType: (subscriptionType as any) ?? 'READ_ONLY',
          trainingMode: trainingMode ?? false,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        update: {
          ...(subscriptionType ? { subscriptionType: subscriptionType as any } : {}),
          ...(trainingMode !== undefined ? { trainingMode } : {}),
        },
      });
      return ctx.db.station.findUniqueOrThrow({ where: { id: stationId }, include: STATION_INCLUDE });
    },

    unsubscribeStationFromAgent: async (
      _: unknown,
      { stationId, agentId }: { stationId: string; agentId: string },
      ctx: Context,
    ) => {
      const station = await ctx.db.station.findUniqueOrThrow({ where: { id: stationId } });
      if (station.organizationId) {
        await requireOrgRole(ctx, station.organizationId, 'ADMIN');
      } else {
        if (station.userId !== ctx.userId && !ctx.roles?.includes('ADMIN')) throw new Error('Forbidden');
      }

      await ctx.db.stationAgentSubscription.delete({
        where: { stationId_agentId: { stationId, agentId } },
      });
      return ctx.db.station.findUniqueOrThrow({ where: { id: stationId }, include: STATION_INCLUDE });
    },

    updateMyProfile: async (
      _: unknown,
      { name, handle, email }: { name?: string; handle?: string; email?: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return ctx.db.user.update({
        where: { id: ctx.userId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(handle !== undefined ? { handle } : {}),
          ...(email !== undefined ? { email } : {}),
        },
      });
    },

    updateUserRoles: async (
      _: unknown,
      { userId, roles }: { userId: string; roles: Role[] },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.update({ where: { id: userId }, data: { roles } });
    },

    // ── Organization management ─────────────────────────────────────────

    createOrganization: async (
      _: unknown,
      { name, urn }: { name: string; urn: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      const org = await ctx.db.organization.create({
        data: { name, urn, isVisible: true, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: ORG_INCLUDE,
      });
      if (ctx.userId) {
        await ctx.db.orgMember.create({
          data: { organizationId: org.id, userId: ctx.userId, role: 'OWNER', canInvite: true, createdBy: ctx.userId },
        });
      }
      return ctx.db.organization.findUniqueOrThrow({ where: { id: org.id }, include: ORG_INCLUDE });
    },

    updateOrganization: async (
      _: unknown,
      { id, name, urn, isVisible }: { id: string; name?: string; urn?: string; isVisible?: boolean },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, id, 'ADMIN');
      return ctx.db.organization.update({
        where: { id },
        data: {
          ...(name ? { name } : {}),
          ...(urn ? { urn } : {}),
          ...(isVisible !== undefined ? { isVisible } : {}),
        },
        include: ORG_INCLUDE,
      });
    },

    deleteOrganization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      await ctx.db.organization.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },

    linkGithubApp: async (
      _: unknown,
      { orgId, installationId }: { orgId: string; installationId: number },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.organization.update({
        where: { id: orgId },
        data: { githubInstallationId: installationId },
        include: ORG_INCLUDE,
      });
    },

    updateOrgGithubApp: async (
      _: unknown,
      { orgId, appId, privateKey }: { orgId: string; appId: string; privateKey: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      const encrypted = encryptToken(privateKey);
      return ctx.db.organization.update({
        where: { id: orgId },
        data: { githubAppId: appId, githubAppPrivateKeyEncrypted: encrypted },
        include: ORG_INCLUDE,
      });
    },

    unlinkGithubApp: async (
      _: unknown,
      { orgId }: { orgId: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.organization.update({
        where: { id: orgId },
        data: {
          githubInstallationId: null,
          githubAppId: null,
          githubAppPrivateKeyEncrypted: null,
        },
        include: ORG_INCLUDE,
      });
    },

    // ── User invitations ────────────────────────────────────────────────

    createUserInvitation: async (
      _: unknown,
      {
        orgId,
        memberRole,
        name,
        email,
        githubUsername,
        maxActivations,
        expiresInDays,
      }: {
        orgId: string; memberRole: string;
        name?: string; email?: string; githubUsername?: string;
        maxActivations?: number; expiresInDays?: number;
      },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      const slug = generateId().slice(0, 16);
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      const invite = await ctx.db.userInvitation.create({
        data: {
          id: generateId(),
          slug,
          senderUserId: ctx.userId ?? null,
          organizationId: orgId,
          memberRole: (memberRole as Role) ?? 'READER',
          name: name ?? null,
          email: email ?? null,
          githubUsername: githubUsername ?? null,
          maxActivations: maxActivations ?? 1,
          expiresAt,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: { sender: true, organization: true, activations: true },
      });
      return { ...invite, activationCount: invite.activations.length };
    },

    inviteUser: async (
      _: unknown,
      { name, email, githubUsername, maxActivations, expiresInDays }: {
        name?: string; email?: string; githubUsername?: string;
        maxActivations?: number; expiresInDays?: number;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const slug = generateId().slice(0, 16);
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      const invite = await ctx.db.userInvitation.create({
        data: {
          id: generateId(),
          slug,
          senderUserId: ctx.userId,
          organizationId: null,
          memberRole: 'READER',
          name: name ?? null,
          email: email ?? null,
          githubUsername: githubUsername ?? null,
          maxActivations: maxActivations ?? 1,
          expiresAt,
          createdBy: ctx.userId,
        },
        include: { sender: true, organization: true, activations: true },
      });
      return { ...invite, activationCount: invite.activations.length };
    },

    acceptInvitation: async (
      _: unknown,
      { slug }: { slug: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('You must be signed in to accept an invitation');

      const invite = await ctx.db.userInvitation.findUnique({
        where: { slug },
        include: { activations: true },
      });
      if (!invite || invite.deletedAt) throw new Error('Invitation not found');
      if (invite.expiresAt && invite.expiresAt < new Date()) throw new Error('Invitation has expired');
      if (invite.maxActivations && invite.activations.length >= invite.maxActivations) {
        throw new Error('Invitation has reached its maximum number of uses');
      }

      // Check if user already activated this invite
      if (invite.activations.some((a: any) => a.userId === ctx.userId)) {
        throw new Error('You have already accepted this invitation');
      }

      // Create activation record
      await ctx.db.userInvitationActivation.create({
        data: {
          id: generateId(),
          invitationId: invite.id,
          userId: ctx.userId!,
          createdBy: ctx.userId ?? null,
        },
      });

      // Add user to org if not already a member
      if (invite.organizationId) {
        const existing = await ctx.db.orgMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId: invite.organizationId,
              userId: ctx.userId!,
            },
          },
        });
        if (!existing) {
          await ctx.db.orgMember.create({
            data: {
              id: generateId(),
              organizationId: invite.organizationId,
              userId: ctx.userId!,
              role: invite.memberRole as Role,
              createdBy: ctx.userId ?? null,
            },
          });
        }
      }

      return true;
    },

    // ── Organization membership ─────────────────────────────────────────

    addOrgMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.orgMember.create({
        data: { id: generateId(), organizationId: orgId, userId, role: role as Role, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: { user: true },
      });
    },

    updateOrgMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.orgMember.update({
        where: { organizationId_userId: { organizationId: orgId, userId } },
        data: { role: role as Role },
        include: { user: true },
      });
    },

    removeOrgMember: async (
      _: unknown,
      { orgId, userId }: { orgId: string; userId: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      // Cannot remove the last OWNER
      const owners = await ctx.db.orgMember.findMany({
        where: { organizationId: orgId, role: 'OWNER', deletedAt: null },
      });
      const member = await ctx.db.orgMember.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: orgId, userId } },
      });
      if (member.role === 'OWNER' && owners.length <= 1) {
        throw new Error('Cannot remove the last owner of an organization');
      }
      await ctx.db.orgMember.delete({
        where: { organizationId_userId: { organizationId: orgId, userId } },
      });
      return true;
    },

    // ── Memory management ────────────────────────────────────────────────

    createMemory: async (
      _: unknown,
      {
        orgId,
        name,
        shortDescription,
        description,
        tags,
        license,
        category0,
        category1,
        category2,
        iconUrl,
        heroUrl,
        homeUrl,
        source,
        readBranch,
        writeBranch,
        visibility,
      }: {
        orgId: string; name: string;
        shortDescription?: string; description?: string; tags?: string[];
        license?: string; category0?: string; category1?: string; category2?: string;
        iconUrl?: string; heroUrl?: string; homeUrl?: string;
        source?: string | null; readBranch?: string; writeBranch?: string; visibility?: string;
      },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      // Generate memory URN from org + name
      const memOrg = await ctx.db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { urn: true } });
      const memoryUrn = `${memOrg.urn}:${name}`;
      const memory = await ctx.db.memory.create({
        data: {
          id: generateId(),
          organizationId: orgId,
          urn: memoryUrn,
          name,
          shortDescription,
          description,
          tags: tags ?? [],
          license,
          category0,
          category1,
          category2,
          iconUrl,
          heroUrl,
          homeUrl,
          source,
          readBranch,
          writeBranch,
          visibility: (visibility as MemoryVisibility) ?? 'PRIVATE',
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: MEMORY_INCLUDE,
      });

      // Create the root node for this memory
      const rootName = name.split(':').pop() ?? name;
      await createNode({
        memoryId: memory.id,
        loc: name,
        name: rootName,
      });

      return memory;
    },

    updateMemory: async (
      _: unknown,
      {
        id,
        name,
        urn,
        organizationId: newOrgId,
        shortDescription,
        description,
        tags,
        license,
        category0,
        category1,
        category2,
        iconUrl,
        heroUrl,
        homeUrl,
        source,
        readBranch,
        writeBranch,
        visibility,
      }: {
        id: string; name?: string; urn?: string; organizationId?: string;
        shortDescription?: string; description?: string; tags?: string[];
        license?: string; category0?: string; category1?: string; category2?: string;
        iconUrl?: string; heroUrl?: string; homeUrl?: string;
        source?: string; readBranch?: string; writeBranch?: string; visibility?: string;
      },
      ctx: Context,
    ) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      // If transferring to a new org, require ADMIN on the target org too
      if (newOrgId && newOrgId !== memory.organizationId) {
        await requireOrgRole(ctx, newOrgId, 'ADMIN');
      }
      // Rebuild URN if slug or org changed
      const effectiveOrgId = newOrgId ?? memory.organizationId;
      let newUrn: string | undefined;
      if (urn !== undefined || (newOrgId && newOrgId !== memory.organizationId)) {
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: effectiveOrgId }, select: { urn: true } });
        const slug = urn ?? memory.urn.split(':').slice(1).join(':');
        newUrn = `${org.urn}:${slug}`;
      }
      return ctx.db.memory.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(newOrgId ? { organizationId: newOrgId } : {}),
          ...(newUrn !== undefined ? { urn: newUrn } : {}),
          ...(shortDescription !== undefined ? { shortDescription } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(license !== undefined ? { license } : {}),
          ...(category0 !== undefined ? { category0 } : {}),
          ...(category1 !== undefined ? { category1 } : {}),
          ...(category2 !== undefined ? { category2 } : {}),
          ...(iconUrl !== undefined ? { iconUrl } : {}),
          ...(heroUrl !== undefined ? { heroUrl } : {}),
          ...(homeUrl !== undefined ? { homeUrl } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(readBranch !== undefined ? { readBranch } : {}),
          ...(writeBranch !== undefined ? { writeBranch } : {}),
          ...(visibility !== undefined ? { visibility: visibility as MemoryVisibility } : {}),
        },
        include: MEMORY_INCLUDE,
      });
    },

    deleteMemory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      await ctx.db.memory.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },

    setMemorySourceToken: async (
      _: unknown,
      { id, token, expiresAt }: { id: string; token: string; expiresAt?: string },
      ctx: Context,
    ) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      const encrypted = encryptToken(token);
      return ctx.db.memory.update({
        where: { id },
        data: {
          sourceTokenEncrypted: encrypted,
          sourceTokenExpiresAt: expiresAt ? new Date(expiresAt) : null,
        },
        include: MEMORY_INCLUDE,
      });
    },

    // ── Agent management ──────────────────────────────────────────────────

    createAgent: async (
      _: unknown,
      { orgId, name, description, systemPrompt, systemMemoryId, visibility }: { orgId: string; name: string; description?: string; systemPrompt?: string; systemMemoryId?: string; visibility?: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      // Generate agent URN from org + name
      const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { urn: true } });
      const agentUrn = `${org.urn}:${name}`;
      return ctx.db.agent.create({
        data: {
          organizationId: orgId, urn: agentUrn, name, description, systemPrompt, systemMemoryId: systemMemoryId ?? null,
          visibility: (visibility as MemoryVisibility) ?? 'PRIVATE',
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: AGENT_INCLUDE,
      });
    },

    updateAgent: async (
      _: unknown,
      { id, name, urn, description, systemPrompt, systemMemoryId, visibility }: { id: string; name?: string; urn?: string; description?: string; systemPrompt?: string; systemMemoryId?: string; visibility?: string },
      ctx: Context,
    ) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      let newUrn: string | undefined;
      if (urn !== undefined) {
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: agent.organizationId }, select: { urn: true } });
        newUrn = `${org.urn}:${urn}`;
      }
      return ctx.db.agent.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(newUrn !== undefined ? { urn: newUrn } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(systemMemoryId !== undefined ? { systemMemoryId } : {}),
          ...(visibility !== undefined ? { visibility: visibility as MemoryVisibility } : {}),
        },
        include: AGENT_INCLUDE,
      });
    },

    deleteAgent: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      await ctx.db.agent.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },

    addMemoryToAgent: async (
      _: unknown,
      { agentId, memoryId, role }: { agentId: string; memoryId: string; role?: string },
      ctx: Context,
    ) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      await ctx.db.agentMemoryItem.create({ data: { agentId, memoryId, role: role ?? 'read', createdBy: ctx.userId ?? ctx.clientId ?? null } });
      return ctx.db.agent.findUniqueOrThrow({ where: { id: agentId }, include: AGENT_INCLUDE });
    },

    updateAgentMemoryRole: async (
      _: unknown,
      { agentId, memoryId, role }: { agentId: string; memoryId: string; role: string },
      ctx: Context,
    ) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      await ctx.db.agentMemoryItem.update({
        where: { agentId_memoryId: { agentId, memoryId } },
        data: { role },
      });
      return ctx.db.agent.findUniqueOrThrow({ where: { id: agentId }, include: AGENT_INCLUDE });
    },

    removeMemoryFromAgent: async (
      _: unknown,
      { agentId, memoryId }: { agentId: string; memoryId: string },
      ctx: Context,
    ) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      await ctx.db.agentMemoryItem.delete({
        where: { agentId_memoryId: { agentId, memoryId } },
      });
      return ctx.db.agent.findUniqueOrThrow({ where: { id: agentId }, include: AGENT_INCLUDE });
    },

    // ── Memory subscriptions ─────────────────────────────────────────────

    createMemorySubscription: async (
      _: unknown,
      { memoryId, orgId, role }: { memoryId: string; orgId: string; role: string },
      ctx: Context,
    ) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId } });

      if (memory.visibility === 'ORGANIZATION' || memory.visibility === 'PRIVATE') {
        throw new Error('Only public memories can be subscribed to by other organizations');
      }

      if (memory.visibility === 'PUBLIC') {
        await requireOrgRole(ctx, orgId, 'ADMIN');
      } else {
        await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      }

      if (memory.organizationId === orgId) {
        throw new Error('Owner organization has implicit access and cannot subscribe');
      }

      return ctx.db.memorySubscription.create({
        data: { id: generateId(), memoryId, organizationId: orgId, role: role as Role, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: { memory: { include: MEMORY_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
    },

    updateMemorySubscription: async (
      _: unknown,
      { memoryId, orgId, role }: { memoryId: string; orgId: string; role: string },
      ctx: Context,
    ) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      return ctx.db.memorySubscription.update({
        where: { memoryId_organizationId: { memoryId, organizationId: orgId } },
        data: { role: role as Role },
        include: { memory: { include: MEMORY_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
    },

    deleteMemorySubscription: async (
      _: unknown,
      { memoryId, orgId }: { memoryId: string; orgId: string },
      ctx: Context,
    ) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      const isOwnerAdmin = async () => {
        if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return true;
        if (!ctx.userId) return false;
        const m = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: memory.organizationId, userId: ctx.userId } },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      const isSubscriberAdmin = async () => {
        if (!ctx.userId) return false;
        const m = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      if (!(await isOwnerAdmin()) && !(await isSubscriberAdmin())) {
        throw new Error('Forbidden');
      }
      await ctx.db.memorySubscription.delete({
        where: { memoryId_organizationId: { memoryId, organizationId: orgId } },
      });
      return true;
    },

    syncMemory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({
        where: { id },
        include: { organization: true },
      });
      await requireOrgRole(ctx, memory.organizationId, 'CONTRIBUTOR');

      const result = await syncGraphFromGithub(memory);
      if (result.error) throw new Error(result.error);

      return ctx.db.memory.findUniqueOrThrow({ where: { id }, include: MEMORY_INCLUDE });
    },

    pushMemoryToGit: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');

      const { pushMemoryToGit: push } = await import('../../../integrations/github/pushMemoryToGit.js');
      const result = await push(id);
      if (result.error) throw new Error(result.error);
      return true;
    },

    restoreNodeVersion: async (_: unknown, { versionId }: { versionId: string }, ctx: Context) => {
      const version = await ctx.db.nodeVersion.findUniqueOrThrow({ where: { id: versionId } });
      const node = await ctx.db.node.findUniqueOrThrow({ where: { id: version.nodeId } });
      await requireMemoryWriteAccess(ctx, node.memoryId);

      // Snapshot current state before restoring
      await ctx.db.nodeVersion.create({
        data: {
          id: generateId(),
          nodeId: node.id,
          loc: node.loc,
          name: node.name,
          alias: node.alias,
          description: node.description,
          content: node.content,
          tags: node.tags as string[],
          editedBy: ctx.clientId ?? ctx.userId ?? null,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });

      // Restore the node to the version's state
      return ctx.db.node.update({
        where: { id: node.id },
        data: {
          name: version.name,
          alias: version.alias,
          description: version.description,
          content: version.content,
          tags: version.tags as string[],
        },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    addToMyMemories: async (_: unknown, { memoryId }: { memoryId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      if (!ctx.userId) throw new Error('Authentication required');

      // Verify the memory is public
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId } });
      if (memory.visibility !== 'PUBLIC') throw new Error('Memory is not public');

      // Find user's personal org
      const membership = await ctx.db.orgMember.findFirst({
        where: {
          userId: ctx.userId,
          organization: { isVisible: { not: true } },
        },
        include: { organization: { include: { agents: true } } },
      });
      if (!membership) throw new Error('No personal workspace found');

      const org = membership.organization;
      const agent = org.agents[0];
      if (!agent) throw new Error('No default agent found');

      // Create memory subscription (personal org subscribes to the memory)
      await ctx.db.memorySubscription.upsert({
        where: { memoryId_organizationId: { memoryId, organizationId: org.id } },
        create: {
          id: generateId(),
          memoryId,
          organizationId: org.id,
          role: 'READER',
          activated: true,
          createdBy: ctx.userId ?? null,
        },
        update: {},
      });

      // Add memory to the default agent
      await ctx.db.agentMemoryItem.upsert({
        where: { agentId_memoryId: { agentId: agent.id, memoryId } },
        create: { id: generateId(), agentId: agent.id, memoryId, createdBy: ctx.userId ?? null },
        update: {},
      });

      return true;
    },

    // ── Exchange integration mutations ──────────────────────────────────
    // Connection is created via OAuth at /auth/microsoft (no GraphQL mutation needed)

    deleteExchangeConnection: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const connection = await ctx.db.exchangeConnection.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, connection.organizationId, 'ADMIN');
      await ctx.db.exchangeConnection.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null },
      });
      return true;
    },

    testExchangeConnection: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, id);
      try {
        await listInboxMessages(refreshToken, { top: 1 });
        await ctx.db.exchangeConnection.update({
          where: { id },
          data: { syncStatus: 'OK', lastError: null, lastSyncAt: new Date() },
        });
        return true;
      } catch (err: unknown) {
        const errMsg = extractErrorMessage(err);
        await ctx.db.exchangeConnection.update({
          where: { id },
          data: { syncStatus: 'ERROR', lastError: errMsg },
        });
        throw new Error(`Exchange connection test failed: ${errMsg}`);
      }
    },

    exchangeReply: async (
      _: unknown,
      { connectionId, messageId, body }: { connectionId: string; messageId: string; body: string },
      ctx: Context,
    ) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      await replyToMessage(refreshToken, messageId, body);
      return true;
    },

    exchangeMoveMessage: async (
      _: unknown,
      { connectionId, messageId, folderId }: { connectionId: string; messageId: string; folderId: string },
      ctx: Context,
    ) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      await moveMessage(refreshToken, messageId, folderId);
      return true;
    },

    joinWaitingList: async (
      _: unknown,
      { email, requestedFeatures }: { email: string; requestedFeatures?: string },
      ctx: Context,
    ) => {
      await ctx.db.waitingListItem.create({
        data: { email: email.trim().toLowerCase(), requestedFeatures: requestedFeatures ?? null },
      });
      return true;
    },

    sendContactMessage: async (
      _: unknown,
      { name, email, message }: { name: string; email: string; message: string },
    ) => {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error('Email service not configured');
      const contactEmail = process.env.CONTACT_EMAIL ?? 'info@baragaun.com';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: 'Hadron <noreply@hadronmemory.com>',
          to: contactEmail,
          subject: `Contact from ${name}`,
          text: `New contact form submission:\n\nFrom: ${name} <${email}>\n\n${message}`,
        }),
      });
      return true;
    },

    // ── Chat API ────────────────────────────────────────────────────────

    startChat: async (
      _: unknown,
      { agentId, userId, conversationName }: { agentId: string; userId: string; conversationName?: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // Load agent with system memory
      const agent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: agentId },
        include: { memoryItems: { include: { memory: true } } },
      });

      const systemMemoryId = (agent as any).systemMemoryId as string | null;
      if (!systemMemoryId) throw new Error('Agent has no system memory configured');

      // Find the conversation (default to 'setup' if no name provided)
      const convName = conversationName ?? 'setup';
      const convNode = await ctx.db.node.findFirst({
        where: { memoryId: systemMemoryId, loc: `conversations:${convName}`, deletedAt: null },
      });
      if (!convNode) throw new Error(`Conversation "${convName}" not found in agent's system memory`);

      const convData = (convNode.data as Record<string, unknown>) ?? {};
      const stageOrder = (convData.stageOrder as string[]) ?? [];
      const firstStage = stageOrder[0];
      if (!firstStage) throw new Error(`Conversation "${convName}" has no stages`);

      // Load the first stage
      const stageNode = await ctx.db.node.findFirst({
        where: { memoryId: systemMemoryId, loc: `conversations:${convName}:${firstStage}`, deletedAt: null },
      });
      const stageData = (stageNode?.data as Record<string, unknown>) ?? {};

      // Load the prompt
      const promptRef = stageData.promptRef as string | undefined;
      let promptContent = '';
      if (promptRef) {
        const promptNode = await ctx.db.node.findFirst({
          where: { memoryId: systemMemoryId, loc: promptRef, deletedAt: null },
        });
        promptContent = promptNode?.content ?? '';
      } else if (stageNode?.content) {
        promptContent = stageNode.content;
      }

      // Compile the prompt with Mustache (using agent's writable memory data)
      const writableMemory = agent.memoryItems.find((m) => m.role === 'read-write');
      const writableMemoryId = writableMemory?.memory.id;
      let systemMessage = promptContent;
      if (promptContent.includes('{{') && writableMemoryId) {
        const access = await memoryAccessFilter(ctx);
        systemMessage = await compileTemplate(promptContent, null, writableMemoryId, ctx.db, access);
      }

      // Build tool schema from extraction spec
      const extractionSpec = stageData.extractionSpec as Array<{ field: string; description?: string; shape?: string }> | undefined;
      let tools = null;
      if (extractionSpec?.length) {
        const dataProps: Record<string, unknown> = {};
        for (const spec of extractionSpec) {
          const fieldName = spec.field.split('.').pop() ?? spec.field;
          dataProps[fieldName] = { type: spec.shape ?? 'string', description: spec.description ?? fieldName };
        }
        tools = [{
          name: 'respond',
          description: 'Respond to the user and extract data',
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'Your response to the user' },
              data: { type: 'object', properties: dataProps },
              next_stage: { type: 'string', description: 'Stage to transition to (null to stay)' },
            },
            required: ['message'],
          },
        }];
      }

      // Create chat node in writable memory
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const chatName = `${ts}-${userId}-${convName}`;
      const chatLoc = `chats:${chatName}`;

      if (writableMemoryId) {
        // Ensure chats parent
        try {
          await ctx.db.node.upsert({
            where: { loc_memoryId: { loc: 'chats', memoryId: writableMemoryId } },
            create: { id: generateId(), memoryId: writableMemoryId, loc: 'chats', name: 'chats', nodeType: 'record' },
            update: {},
          });
        } catch { /* exists */ }

        // Create chat node
        await ctx.db.node.create({
          data: {
            id: generateId(), memoryId: writableMemoryId, loc: chatLoc, name: chatName,
            nodeType: 'record', description: `Chat: ${convName}`,
            data: { conversationName: convName, stageName: firstStage, userId, messageCount: 0 },
          },
        });

        // Create messages parent
        await ctx.db.node.create({
          data: {
            id: generateId(), memoryId: writableMemoryId, loc: `${chatLoc}:messages`, name: 'messages', nodeType: 'record',
          },
        });
      }

      // Prepend agent system prompt
      if (agent.systemPrompt) {
        systemMessage = agent.systemPrompt + '\n\n' + systemMessage;
      }

      return { chatId: chatLoc, systemMessage, tools, conversationName: convName, stageName: firstStage };
    },

    sendChatMessage: async (
      _: unknown,
      { chatId, userMessage }: { chatId: string; userMessage: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // Find the chat node
      const chatNode = await ctx.db.node.findFirst({
        where: { loc: chatId, deletedAt: null },
      });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);

      const chatData = (chatNode.data as Record<string, unknown>) ?? {};
      const messageCount = ((chatData.messageCount as number) ?? 0) + 1;
      const convName = chatData.conversationName as string;
      const stageName = chatData.stageName as string;

      // Save user message
      const msgNum = String(messageCount).padStart(3, '0');
      const userId = chatData.userId as string ?? 'user';
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${msgNum}-${userId}`, name: `${msgNum}-${userId}`,
          nodeType: 'record', content: userMessage, seq: messageCount,
        },
      });

      // Update message count
      await ctx.db.node.update({
        where: { id: chatNode.id },
        data: { data: { ...(chatData as any), messageCount } },
      });

      // Load the agent to get system memory
      // Find the agent via the writable memory's subscriptions
      const memory = await ctx.db.memory.findUnique({ where: { id: chatNode.memoryId } });
      if (!memory) throw new Error('Memory not found');

      // Find agent with systemMemoryId
      const agents = await ctx.db.agent.findMany({
        where: { deletedAt: null, memoryItems: { some: { memoryId: chatNode.memoryId } } },
      });
      const agent = agents.find((a) => (a as any).systemMemoryId);
      const systemMemoryId = agent ? (agent as any).systemMemoryId as string : null;

      // Load current stage
      let systemMessage = '';
      let tools = null;

      if (systemMemoryId && convName && stageName) {
        const stageNode = await ctx.db.node.findFirst({
          where: { memoryId: systemMemoryId, loc: `conversations:${convName}:${stageName}`, deletedAt: null },
        });
        const stageData = (stageNode?.data as Record<string, unknown>) ?? {};

        // Load prompt
        const promptRef = stageData.promptRef as string | undefined;
        let promptContent = '';
        if (promptRef) {
          const promptNode = await ctx.db.node.findFirst({
            where: { memoryId: systemMemoryId, loc: promptRef, deletedAt: null },
          });
          promptContent = promptNode?.content ?? '';
        } else if (stageNode?.content) {
          promptContent = stageNode.content;
        }

        // Compile with data
        const access = await memoryAccessFilter(ctx);
        if (promptContent.includes('{{')) {
          systemMessage = await compileTemplate(promptContent, null, chatNode.memoryId, ctx.db, access);
        } else {
          systemMessage = promptContent;
        }

        // Prepend agent system prompt
        if (agent?.systemPrompt) {
          systemMessage = agent.systemPrompt + '\n\n' + systemMessage;
        }

        // Build tools from extraction spec
        const extractionSpec = stageData.extractionSpec as Array<{ field: string; description?: string; shape?: string }> | undefined;
        if (extractionSpec?.length) {
          const dataProps: Record<string, unknown> = {};
          for (const spec of extractionSpec) {
            const fieldName = spec.field.split('.').pop() ?? spec.field;
            dataProps[fieldName] = { type: spec.shape ?? 'string', description: spec.description ?? fieldName };
          }
          tools = [{
            name: 'respond',
            description: 'Respond to the user and extract data',
            parameters: {
              type: 'object', properties: {
                message: { type: 'string', description: 'Your response to the user' },
                data: { type: 'object', properties: dataProps },
                next_stage: { type: 'string', description: 'Stage to transition to (null to stay)' },
              },
              required: ['message'],
            },
          }];
        }
      }

      // Build message history (recent messages)
      const messages = await ctx.db.node.findMany({
        where: { loc: { startsWith: `${chatId}:messages:` }, memoryId: chatNode.memoryId, deletedAt: null },
        orderBy: { seq: 'asc' },
        take: 50,
        select: { loc: true, content: true, seq: true, nodeType: true },
      });

      const messageHistory = messages.map((m) => {
        const name = m.loc.split(':').pop() ?? '';
        const isUser = !name.includes('assistant') && !name.includes('juno') && !name.includes('ai');
        return { role: isUser ? 'user' : 'assistant', content: m.content ?? '' };
      });

      return { systemMessage, tools, messageHistory, summarizationNeeded: null };
    },

    processChatResponse: async (
      _: unknown,
      { chatId, toolResponse }: { chatId: string; toolResponse: Record<string, unknown> },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      const chatNode = await ctx.db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);

      const chatData = (chatNode.data as Record<string, unknown>) ?? {};
      const messageCount = ((chatData.messageCount as number) ?? 0) + 1;

      const message = (toolResponse.message as string) ?? '';
      const data = toolResponse.data as Record<string, unknown> | undefined;
      const nextStage = toolResponse.next_stage as string | undefined;

      // Save assistant message
      const msgNum = String(messageCount).padStart(3, '0');
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${msgNum}-assistant`, name: `${msgNum}-assistant`,
          nodeType: 'record', content: message, seq: messageCount,
        },
      });

      // Save extracted data to memory's default data node
      if (data && Object.keys(data).length > 0) {
        const dataNode = await ctx.db.node.findFirst({
          where: { loc: 'data', memoryId: chatNode.memoryId, deletedAt: null },
        });
        if (dataNode) {
          const existingData = (dataNode.data as Record<string, unknown>) ?? {};
          await ctx.db.node.update({
            where: { id: dataNode.id },
            data: { data: { ...existingData, ...data } as any },
          });
        } else {
          await ctx.db.node.create({
            data: {
              id: generateId(), memoryId: chatNode.memoryId,
              loc: 'data', name: 'data', nodeType: 'info', data: data as any,
            },
          });
        }
      }

      // Handle stage transition
      let stageTransitioned = false;
      let newStageName: string | null = null;
      const updatedData: Record<string, unknown> = { ...(chatData as any), messageCount };

      if (nextStage && nextStage !== chatData.stageName) {
        updatedData.stageName = nextStage;
        stageTransitioned = true;
        newStageName = nextStage;
      }

      await ctx.db.node.update({ where: { id: chatNode.id }, data: { data: updatedData as any } });

      return {
        displayMessage: message,
        stageTransitioned,
        newStageName,
        conversationHandoff: null,
        chatEnded: false,
      };
    },

    saveChatSummary: async (
      _: unknown,
      { chatId, summary }: { chatId: string; summary: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      const chatNode = await ctx.db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);

      const chatData = (chatNode.data as Record<string, unknown>) ?? {};
      const messageCount = (chatData.messageCount as number) ?? 0;
      const summaryName = `${String(messageCount).padStart(3, '0')}a-summary`;

      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${summaryName}`, name: summaryName,
          nodeType: 'abstract', content: summary, seq: messageCount + 1,
          tags: ['summary'],
        },
      });

      return true;
    },
  },
};

interface NodeEdgeInput {
  targetId: string;
  label?: string;
}

interface NodeInput {
  id?: string;
  memoryId: string;
  loc: string;
  name: string;
  alias?: string;
  description?: string;
  content?: string;
  seq?: number;
  tags?: string[];
  ownerRepo?: string;
  edges?: NodeEdgeInput[];
}

interface EdgeInput {
  sourceLoc: string;
  targetLoc: string;
  label: string;
}

interface SessionInput {
  id: string;
  type?: string;
  repo?: string;
  branch?: string;
  prNumber?: number;
  customerId?: string;
  language?: string;
  llmModel?: string;
  parentSessionId?: string;
  prevSessionId?: string;
}

interface UsageEventInput {
  type: string;
  nodeLoc?: string;
  actionArgs?: Record<string, unknown>;
  sessionId?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}
