import bcrypt from 'bcrypt';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'crypto';
import type { InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import type { PrismaClient, Role, ClientType, Visibility, Prisma } from '../../../generated/prisma/index.js';
import { deserializeTags, serializeTags, serializeJson, deserializeJson, searchContains, tagsFilter } from '../../../integrations/db/provider.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { syncGraphFromGithub } from '../../../integrations/github/syncGraphFromGithub.js';

export interface Context {
  db: PrismaClient;
  clientId?: string;       // Client.id or "github:<username>"
  userId?: string;         // User.id — only set for OAuth/JWT users
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  namespace?: string;      // contributor's writable namespace
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
  const member = await ctx.db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
  });
  if (!member || (ROLE_ORDER[member.role] ?? -1) < ROLE_ORDER[required]) {
    throw new Error('Forbidden');
  }
}

// ── Graph access control ──────────────────────────────────────────────

/**
 * Returns the graph IDs accessible to the current caller, or null if the
 * caller has unrestricted access (global ADMIN/OWNER).
 *
 * - Clients: graphs from bundle subscriptions only
 * - Users: graphs from org memberships + cross-org subscriptions + public graphs
 * - Unauthenticated: public graphs only
 */
async function getAccessibleGraphIds(ctx: Context): Promise<string[] | null> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return null;

  // API-key client — graphs from bundle subscriptions
  if (ctx.clientId && !ctx.userId) {
    const subs = await ctx.db.clientBundleSubscription.findMany({
      where: { clientId: ctx.clientId, deletedAt: null },
      include: { bundle: { include: { graphs: { select: { graphId: true } } } } },
    });
    const ids: string[] = [];
    for (const sub of subs) {
      for (const bg of sub.bundle.graphs) ids.push(bg.graphId);
    }
    return ids;
  }

  // JWT user — org graphs + subscribed graphs + public graphs
  if (ctx.userId) {
    const memberships = await ctx.db.organizationMember.findMany({
      where: { userId: ctx.userId, deletedAt: null },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m) => m.organizationId);
    const graphs = await ctx.db.graph.findMany({
      where: {
        deletedAt: null,
        OR: [
          ...(orgIds.length > 0
            ? [
                { organizationId: { in: orgIds } },
                { subscriptions: { some: { organizationId: { in: orgIds } } } },
              ]
            : []),
          { visibility: 'PUBLIC' as any },
        ],
      },
      select: { id: true },
    });
    return graphs.map((g) => g.id);
  }

  // Unauthenticated — public graphs only
  const publicGraphs = await ctx.db.graph.findMany({
    where: { visibility: 'PUBLIC', deletedAt: null },
    select: { id: true },
  });
  return publicGraphs.map((g) => g.id);
}

/** Prisma `where` clause that restricts nodes to accessible graphs. */
async function graphAccessFilter(ctx: Context): Promise<Record<string, unknown>> {
  const ids = await getAccessibleGraphIds(ctx);
  return ids === null ? {} : { graphId: { in: ids } };
}

/**
 * Verify the caller has write access to a specific graph.
 *
 * Checks (most restrictive wins):
 * 1. Global ADMIN/OWNER — always allowed
 * 2. Clients: role >= CONTRIBUTOR, bundle subscription is READ_WRITE, namespace match
 * 3. Users: org member with CONTRIBUTOR+, or cross-org subscription with CONTRIBUTOR role
 */
async function requireGraphWriteAccess(ctx: Context, graphId: string): Promise<void> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;

  // API-key client path
  if (ctx.clientId && !ctx.userId) {
    const highestRole = Math.max(...(ctx.roles ?? []).map((r) => ROLE_ORDER[r] ?? -1));
    if (highestRole < ROLE_ORDER['CONTRIBUTOR']) {
      throw new Error('Forbidden: client role insufficient for writes');
    }
    const sub = await ctx.db.clientBundleSubscription.findFirst({
      where: {
        clientId: ctx.clientId,
        deletedAt: null,
        subscriptionType: 'READ_WRITE',
        bundle: { graphs: { some: { graphId } } },
      },
    });
    if (!sub) throw new Error('Forbidden: no write access to this graph');
    return;
  }

  // JWT user path
  if (!ctx.userId) throw new Error('Unauthenticated');

  const graph = await ctx.db.graph.findUniqueOrThrow({
    where: { id: graphId },
    select: { organizationId: true },
  });

  // Direct org member with CONTRIBUTOR+?
  const member = await ctx.db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: graph.organizationId, userId: ctx.userId } },
  });
  if (member && (ROLE_ORDER[member.role] ?? -1) >= ROLE_ORDER['CONTRIBUTOR']) return;

  // Cross-org subscription with CONTRIBUTOR role?
  const userOrgs = await ctx.db.organizationMember.findMany({
    where: {
      userId: ctx.userId,
      deletedAt: null,
      role: { in: ['CONTRIBUTOR', 'ADMIN', 'OWNER'] as any },
    },
    select: { organizationId: true },
  });
  for (const uo of userOrgs) {
    const graphSub = await ctx.db.graphSubscription.findUnique({
      where: { graphId_organizationId: { graphId, organizationId: uo.organizationId } },
    });
    if (graphSub && (ROLE_ORDER[graphSub.role] ?? -1) >= ROLE_ORDER['CONTRIBUTOR']) return;
  }

  throw new Error('Forbidden: no write access to this graph');
}

const GRAPH_INCLUDE = {
  subscriptions: { include: { organization: true }, orderBy: { createdAt: 'asc' as const } },
};

const ORG_INCLUDE = {
  members: { include: { user: true }, orderBy: { createdAt: 'asc' as const } },
  graphs: { include: GRAPH_INCLUDE, orderBy: { name: 'asc' as const } },
  graphBundles: { include: { graphs: { include: { graph: true } } }, orderBy: { name: 'asc' as const } },
  subscriptions: { include: { graph: true }, orderBy: { createdAt: 'asc' as const } },
};

const BUNDLE_INCLUDE = {
  graphs: { include: { graph: { include: GRAPH_INCLUDE } } },
};

const CLIENT_INCLUDE = {
  bundleSubscriptions: { include: { bundle: { include: BUNDLE_INCLUDE } }, orderBy: { createdAt: 'asc' as const } },
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

export const resolvers = {
  Node: {
    tags: (node: { tags: string | string[] }) => deserializeTags(node.tags),
  },
  Graph: {
    lastSyncedAt: (g: { lastSyncedAt?: Date | string | null }) => toISO(g.lastSyncedAt),
    createdAt: (g: { createdAt: Date | string }) => toISO(g.createdAt)!,
    updatedAt: (g: { updatedAt: Date | string }) => toISO(g.updatedAt)!,
  },
  Organization: {
    createdAt: (o: { createdAt: Date | string }) => toISO(o.createdAt)!,
    updatedAt: (o: { updatedAt: Date | string }) => toISO(o.updatedAt)!,
    hasGithubAppPrivateKey: (o: { githubAppPrivateKeyEncrypted?: string | null }) => !!o.githubAppPrivateKeyEncrypted,
  },
  Client: {
    createdAt: (c: { createdAt: Date | string }) => toISO(c.createdAt)!,
    lastUsedAt: (c: { lastUsedAt?: Date | string | null }) => toISO(c.lastUsedAt),
    expiresAt: (c: { expiresAt?: Date | string | null }) => toISO(c.expiresAt),
    user: (client: { userId?: string | null }, _: unknown, ctx: Context) =>
      client.userId ? ctx.db.user.findUnique({ where: { id: client.userId } }) : null,
    bundleSubscriptions: (client: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.clientBundleSubscription.findMany({
        where: { clientId: client.id },
        include: { bundle: { include: BUNDLE_INCLUDE } },
        orderBy: { createdAt: 'asc' as const },
      }),
  },
  GraphBundle: {
    createdAt: (b: { createdAt: Date | string }) => toISO(b.createdAt)!,
  },
  Session: {
    outcomeMeta: (session: { outcomeMeta: unknown }) => deserializeJson(session.outcomeMeta),
  },
  UsageEvent: {
    actionArgs: (event: { actionArgs: unknown }) => deserializeJson(event.actionArgs),
  },

  Query: {
    node: async (_: unknown, { loc }: { loc: string }, ctx: Context) => {
      const access = await graphAccessFilter(ctx);
      const node = await ctx.db.node.findUnique({
        where: { loc },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      if (node && access.graphId) {
        const allowed = (access.graphId as { in: string[] }).in;
        if (!allowed.includes(node.graphId)) return null;
      }
      return node;
    },

    nodes: async (
      _: unknown,
      { namespace, tags, search, limit }: { namespace?: string; tags?: string[]; search?: string; limit?: number },
      ctx: Context,
    ) => {
      const access = await graphAccessFilter(ctx);
      return ctx.db.node.findMany({
        where: {
          ...access,
          ...(namespace ? { namespace: { startsWith: namespace } } : {}),
          ...(tags?.length ? tagsFilter(tags) : {}),
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
        take: limit ?? 100,
        orderBy: { loc: 'asc' },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    subtree: async (_: unknown, { prefix }: { prefix: string }, ctx: Context) => {
      const access = await graphAccessFilter(ctx);
      return ctx.db.node.findMany({
        where: { ...access, loc: { startsWith: prefix } },
        orderBy: { loc: 'asc' },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    nodeUsage: async (_: unknown, { loc, limit }: { loc: string; limit?: number }, ctx: Context) => {
      return ctx.db.usageEvent.findMany({
        where: { nodeLoc: loc },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
    },

    graphUsageSummary: async (_: unknown, { graphId }: { graphId: string }, ctx: Context) => {
      // Get all node locs belonging to this graph
      const nodes = await ctx.db.node.findMany({
        where: { graphId },
        select: { loc: true },
      });
      const locs = nodes.map((n) => n.loc);
      if (!locs.length) return [];

      const rows = await ctx.db.usageEvent.groupBy({
        by: ['nodeLoc', 'type'],
        where: { nodeLoc: { in: locs } },
        _count: { id: true },
      });
      return rows.map((r) => ({
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
      { type, repo, customerId, limit }: { type?: string; repo?: string; customerId?: string; limit?: number },
      ctx: Context,
    ) => {
      return ctx.db.session.findMany({
        where: {
          ...(type ? { type: type as any } : {}),
          ...(repo ? { repo } : {}),
          ...(customerId ? { customerId } : {}),
        },
        orderBy: { startedAt: 'desc' },
        take: limit ?? 50,
        include: SESSION_INCLUDE,
      });
    },

    session: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      return ctx.db.session.findUnique({ where: { id }, include: SESSION_INCLUDE });
    },

    clients: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.client.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
    },

    client: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.client.findUnique({ where: { id } });
    },

    myClients: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return [];
      return ctx.db.client.findMany({
        where: { userId: ctx.userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
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
      const memberships = await ctx.db.organizationMember.findMany({
        where: { userId: ctx.userId, deletedAt: null },
        include: { organization: { include: ORG_INCLUDE } },
      });
      return memberships.map((m) => m.organization);
    },

    organization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: id, userId: ctx.userId } },
        });
        if (!member) throw new Error('Forbidden');
      }
      return ctx.db.organization.findUnique({ where: { id }, include: ORG_INCLUDE });
    },

    publicGraphs: async (_: unknown, __: unknown, ctx: Context) => {
      return ctx.db.graph.findMany({
        where: { visibility: 'PUBLIC', deletedAt: null },
        orderBy: { name: 'asc' },
        include: GRAPH_INCLUDE,
      });
    },

    myGraphs: async (_: unknown, __: unknown, ctx: Context) => {
      // API-key client — return graphs from bundle subscriptions
      if (ctx.clientId && !ctx.userId) {
        const subs = await ctx.db.clientBundleSubscription.findMany({
          where: { clientId: ctx.clientId, deletedAt: null },
          include: { bundle: { include: { graphs: { include: { graph: { include: GRAPH_INCLUDE } } } } } },
        });
        const graphMap = new Map<string, any>();
        for (const sub of subs) {
          for (const bg of sub.bundle.graphs) {
            graphMap.set(bg.graph.id, bg.graph);
          }
        }
        return Array.from(graphMap.values());
      }
      // JWT/OAuth user — union of all org-accessible graphs
      if (ctx.userId) {
        const memberships = await ctx.db.organizationMember.findMany({
          where: { userId: ctx.userId, deletedAt: null },
          select: { organizationId: true },
        });
        const orgIds = memberships.map((m) => m.organizationId);
        if (orgIds.length === 0) return [];
        return ctx.db.graph.findMany({
          where: {
            deletedAt: null,
            OR: [
              { organizationId: { in: orgIds } },
              { subscriptions: { some: { organizationId: { in: orgIds } } } },
            ],
          },
          include: GRAPH_INCLUDE,
          orderBy: { name: 'asc' },
        });
      }
      throw new Error('Unauthenticated');
    },
  },

  Mutation: {
    upsertNode: async (_: unknown, { input }: { input: NodeInput }, ctx: Context) => {
      await requireGraphWriteAccess(ctx, input.graphId);
      const namespace = deriveNamespace(input.loc);
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER') && ctx.namespace && !namespace.startsWith(ctx.namespace)) {
        throw new Error('Forbidden: outside your writable namespace');
      }

      // Snapshot current state before update (for version history)
      const existing = await ctx.db.node.findUnique({ where: { loc: input.loc } });
      if (existing) {
        await ctx.db.nodeVersion.create({
          data: {
            nodeId: existing.id,
            loc: existing.loc,
            name: existing.name,
            title: existing.title,
            alias: existing.alias,
            description: existing.description,
            content: existing.content,
            tags: existing.tags as string[],
            editedBy: ctx.clientId ?? ctx.userId ?? null,
          },
        });
      }

      const tags = serializeTags(input.tags ?? []) as string[];
      const id = input.id ?? randomUUID().replace(/-/g, '');
      const { edges, ...nodeFields } = input;
      const node = await ctx.db.node.upsert({
        where: { loc: input.loc },
        create: { ...nodeFields, id, namespace, tags },
        update: { ...nodeFields, namespace, tags },
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
              create: { sourceId: node.id, targetId: target.id, label: e.label ?? '' },
              update: {},
            });
          } else {
            await ctx.db.pendingEdge.upsert({
              where: { sourceId_targetId: { sourceId: node.id, targetId: e.targetId } },
              create: { sourceId: node.id, targetId: e.targetId, label: e.label ?? null },
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
      }, input.ownerRepo ?? '', ctx.clientId).catch((err) => {
        console.error('[upsertNode] git write error:', err);
      });

      return finalNode;
    },

    deleteNode: async (_: unknown, { loc }: { loc: string }, ctx: Context) => {
      const node = await ctx.db.node.findUniqueOrThrow({ where: { loc } });
      await requireGraphWriteAccess(ctx, node.graphId);
      await ctx.db.node.delete({ where: { loc } });
      return true;
    },

    moveNode: async (_: unknown, { from, to }: { from: string; to: string }, ctx: Context) => {
      const node = await ctx.db.node.findUniqueOrThrow({ where: { loc: from } });
      await requireGraphWriteAccess(ctx, node.graphId);
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER') && ctx.namespace && !deriveNamespace(to).startsWith(ctx.namespace)) {
        throw new Error('Forbidden: outside your writable namespace');
      }
      const namespace = deriveNamespace(to);
      return ctx.db.node.update({
        where: { loc: from },
        data: { loc: to, namespace },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    replaceSubtree: async (
      _: unknown,
      {
        namespace,
        ownerRepo,
        graphId,
        nodes,
        edges,
      }: { namespace: string; ownerRepo: string; graphId: string; nodes: NodeInput[]; edges: EdgeInput[] },
      ctx: Context,
    ) => {
      await requireGraphWriteAccess(ctx, graphId);

      await ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.node.deleteMany({ where: { namespace, ownerRepo, graphId } });

        for (const input of nodes) {
          await tx.node.create({
            data: {
              id: input.id ?? randomUUID().replace(/-/g, ''),
              ...input,
              namespace: deriveNamespace(input.loc),
              tags: serializeTags(input.tags ?? []) as string[],
            },
          });
        }

        for (const edge of edges) {
          const source = await tx.node.findUnique({ where: { loc: edge.sourceLoc } });
          const target = await tx.node.findUnique({ where: { loc: edge.targetLoc } });
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
          clientId: ctx.clientId?.startsWith('github:') ? undefined : ctx.clientId,
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
        ? await ctx.db.node.findUnique({ where: { loc: event.nodeLoc } })
        : null;

      await ctx.db.usageEvent.create({
        data: {
          type: event.type,
          nodeLoc: event.nodeLoc,
          nodeId: node?.id,
          actionArgs: serializeJson(event.actionArgs) as InputJsonValue | undefined,
          clientId: ctx.clientId?.startsWith('github:') ? undefined : ctx.clientId,
          sessionId: event.sessionId,
          model: event.model,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
        },
      });
      return true;
    },

    createClient: async (
      _: unknown,
      {
        label,
        clientType,
        role,
        description,
        namespace,
        organizationId,
        userId,
        expiresAt,
      }: {
        label: string;
        clientType: string;
        role: string;
        description?: string;
        namespace?: string;
        organizationId?: string;
        userId?: string;
        expiresAt?: string;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      const rawKey = randomBytes(32).toString('hex');
      const keyHash = await bcrypt.hash(rawKey, 12);
      const client = await ctx.db.client.create({
        data: {
          label,
          keyHash,
          clientType: clientType as ClientType,
          description,
          role: role as Role,
          namespace,
          organizationId: organizationId ?? null,
          userId: userId ?? ctx.userId ?? null,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        },
      });
      return { client, rawKey };
    },

    regenerateApiKey: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      const existing = await ctx.db.client.findUniqueOrThrow({ where: { id } });
      if (existing.userId !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) throw new Error('Forbidden');
      const rawKey = randomBytes(32).toString('hex');
      const keyHash = await bcrypt.hash(rawKey, 12);
      const client = await ctx.db.client.update({ where: { id }, data: { keyHash, apiKeyShown: false } });
      return { client, rawKey };
    },

    revokeClient: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      const existing = await ctx.db.client.findUnique({ where: { id } });
      if (!existing) throw new Error('Client not found');
      if (existing.userId !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) throw new Error('Forbidden');
      await ctx.db.client.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },

    // ── Client bundle subscriptions ──────────────────────────────────────

    subscribeClientToBundle: async (
      _: unknown,
      { clientId, bundleId, subscriptionType, trainingMode }: { clientId: string; bundleId: string; subscriptionType?: string; trainingMode?: boolean },
      ctx: Context,
    ) => {
      const client = await ctx.db.client.findUniqueOrThrow({ where: { id: clientId } });
      const bundle = await ctx.db.graphBundle.findUniqueOrThrow({ where: { id: bundleId } });

      if (client.organizationId) {
        await requireOrgRole(ctx, client.organizationId, 'ADMIN');
      } else {
        if (client.userId !== ctx.userId && !ctx.roles?.includes('ADMIN')) throw new Error('Forbidden');
      }

      await ctx.db.clientBundleSubscription.upsert({
        where: { clientId_bundleId: { clientId, bundleId } },
        create: {
          clientId,
          bundleId,
          subscriptionType: (subscriptionType as any) ?? 'READ_ONLY',
          trainingMode: trainingMode ?? false,
        },
        update: {
          ...(subscriptionType ? { subscriptionType: subscriptionType as any } : {}),
          ...(trainingMode !== undefined ? { trainingMode } : {}),
        },
      });
      return ctx.db.client.findUniqueOrThrow({ where: { id: clientId }, include: CLIENT_INCLUDE });
    },

    unsubscribeClientFromBundle: async (
      _: unknown,
      { clientId, bundleId }: { clientId: string; bundleId: string },
      ctx: Context,
    ) => {
      const client = await ctx.db.client.findUniqueOrThrow({ where: { id: clientId } });
      if (client.organizationId) {
        await requireOrgRole(ctx, client.organizationId, 'ADMIN');
      } else {
        if (client.userId !== ctx.userId && !ctx.roles?.includes('ADMIN')) throw new Error('Forbidden');
      }

      await ctx.db.clientBundleSubscription.delete({
        where: { clientId_bundleId: { clientId, bundleId } },
      });
      return ctx.db.client.findUniqueOrThrow({ where: { id: clientId }, include: CLIENT_INCLUDE });
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
      { name, domain }: { name: string; domain: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      const org = await ctx.db.organization.create({
        data: { name, domain },
        include: ORG_INCLUDE,
      });
      if (ctx.userId) {
        await ctx.db.organizationMember.create({
          data: { organizationId: org.id, userId: ctx.userId, role: 'OWNER', canInvite: true },
        });
      }
      return ctx.db.organization.findUniqueOrThrow({ where: { id: org.id }, include: ORG_INCLUDE });
    },

    updateOrganization: async (
      _: unknown,
      { id, name, domain }: { id: string; name?: string; domain?: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, id, 'ADMIN');
      return ctx.db.organization.update({
        where: { id },
        data: { ...(name ? { name } : {}), ...(domain ? { domain } : {}) },
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

    // ── Organization membership ─────────────────────────────────────────

    addOrganizationMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.organizationMember.create({
        data: { organizationId: orgId, userId, role: role as Role },
        include: { user: true },
      });
    },

    updateOrganizationMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.organizationMember.update({
        where: { organizationId_userId: { organizationId: orgId, userId } },
        data: { role: role as Role },
        include: { user: true },
      });
    },

    removeOrganizationMember: async (
      _: unknown,
      { orgId, userId }: { orgId: string; userId: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      // Cannot remove the last OWNER
      const owners = await ctx.db.organizationMember.findMany({
        where: { organizationId: orgId, role: 'OWNER', deletedAt: null },
      });
      const member = await ctx.db.organizationMember.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: orgId, userId } },
      });
      if (member.role === 'OWNER' && owners.length <= 1) {
        throw new Error('Cannot remove the last owner of an organization');
      }
      await ctx.db.organizationMember.delete({
        where: { organizationId_userId: { organizationId: orgId, userId } },
      });
      return true;
    },

    // ── Graph management ────────────────────────────────────────────────

    createGraph: async (
      _: unknown,
      {
        orgId,
        name,
        source,
        readBranch,
        writeBranch,
        visibility,
      }: { orgId: string; name: string; source?: string | null; readBranch?: string; writeBranch?: string; visibility?: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.graph.create({
        data: {
          organizationId: orgId,
          name,
          source,
          readBranch,
          writeBranch,
          visibility: (visibility as Visibility) ?? 'PRIVATE',
        },
        include: GRAPH_INCLUDE,
      });
    },

    updateGraph: async (
      _: unknown,
      {
        id,
        source,
        readBranch,
        writeBranch,
        visibility,
      }: { id: string; source?: string; readBranch?: string; writeBranch?: string; visibility?: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.graph.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, graph.organizationId, 'ADMIN');
      return ctx.db.graph.update({
        where: { id },
        data: {
          ...(source !== undefined ? { source } : {}),
          ...(readBranch !== undefined ? { readBranch } : {}),
          ...(writeBranch !== undefined ? { writeBranch } : {}),
          ...(visibility !== undefined ? { visibility: visibility as Visibility } : {}),
        },
        include: GRAPH_INCLUDE,
      });
    },

    deleteGraph: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const graph = await ctx.db.graph.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, graph.organizationId, 'ADMIN');
      await ctx.db.graph.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },

    setGraphSourceToken: async (
      _: unknown,
      { id, token, expiresAt }: { id: string; token: string; expiresAt?: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.graph.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, graph.organizationId, 'ADMIN');
      const encrypted = encryptToken(token);
      return ctx.db.graph.update({
        where: { id },
        data: {
          sourceTokenEncrypted: encrypted,
          sourceTokenExpiresAt: expiresAt ? new Date(expiresAt) : null,
        },
        include: GRAPH_INCLUDE,
      });
    },

    // ── Graph bundle management ─────────────────────────────────────────

    createGraphBundle: async (
      _: unknown,
      { orgId, name, description }: { orgId: string; name: string; description?: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.graphBundle.create({
        data: { organizationId: orgId, name, description },
        include: BUNDLE_INCLUDE,
      });
    },

    updateGraphBundle: async (
      _: unknown,
      { id, name, description }: { id: string; name?: string; description?: string },
      ctx: Context,
    ) => {
      const bundle = await ctx.db.graphBundle.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, bundle.organizationId, 'ADMIN');
      return ctx.db.graphBundle.update({
        where: { id },
        data: { ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}) },
        include: BUNDLE_INCLUDE,
      });
    },

    deleteGraphBundle: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const bundle = await ctx.db.graphBundle.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, bundle.organizationId, 'ADMIN');
      await ctx.db.graphBundle.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },

    addGraphToBundle: async (
      _: unknown,
      { bundleId, graphId }: { bundleId: string; graphId: string },
      ctx: Context,
    ) => {
      const bundle = await ctx.db.graphBundle.findUniqueOrThrow({ where: { id: bundleId } });
      await requireOrgRole(ctx, bundle.organizationId, 'ADMIN');
      await ctx.db.graphBundleGraph.create({ data: { bundleId, graphId } });
      return ctx.db.graphBundle.findUniqueOrThrow({ where: { id: bundleId }, include: BUNDLE_INCLUDE });
    },

    removeGraphFromBundle: async (
      _: unknown,
      { bundleId, graphId }: { bundleId: string; graphId: string },
      ctx: Context,
    ) => {
      const bundle = await ctx.db.graphBundle.findUniqueOrThrow({ where: { id: bundleId } });
      await requireOrgRole(ctx, bundle.organizationId, 'ADMIN');
      await ctx.db.graphBundleGraph.delete({
        where: { bundleId_graphId: { bundleId, graphId } },
      });
      return ctx.db.graphBundle.findUniqueOrThrow({ where: { id: bundleId }, include: BUNDLE_INCLUDE });
    },

    // ── Graph subscriptions ─────────────────────────────────────────────

    createGraphSubscription: async (
      _: unknown,
      { graphId, orgId, role }: { graphId: string; orgId: string; role: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.graph.findUniqueOrThrow({ where: { id: graphId } });

      if (graph.visibility === 'PUBLIC') {
        await requireOrgRole(ctx, orgId, 'ADMIN');
      } else {
        await requireOrgRole(ctx, graph.organizationId, 'ADMIN');
      }

      if (graph.organizationId === orgId) {
        throw new Error('Owner organization has implicit access and cannot subscribe');
      }

      return ctx.db.graphSubscription.create({
        data: { graphId, organizationId: orgId, role: role as Role },
        include: { graph: { include: GRAPH_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
    },

    updateGraphSubscription: async (
      _: unknown,
      { graphId, orgId, role }: { graphId: string; orgId: string; role: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.graph.findUniqueOrThrow({ where: { id: graphId } });
      await requireOrgRole(ctx, graph.organizationId, 'ADMIN');
      return ctx.db.graphSubscription.update({
        where: { graphId_organizationId: { graphId, organizationId: orgId } },
        data: { role: role as Role },
        include: { graph: { include: GRAPH_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
    },

    deleteGraphSubscription: async (
      _: unknown,
      { graphId, orgId }: { graphId: string; orgId: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.graph.findUniqueOrThrow({ where: { id: graphId } });
      const isOwnerAdmin = async () => {
        if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return true;
        if (!ctx.userId) return false;
        const m = await ctx.db.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: graph.organizationId, userId: ctx.userId } },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      const isSubscriberAdmin = async () => {
        if (!ctx.userId) return false;
        const m = await ctx.db.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      if (!(await isOwnerAdmin()) && !(await isSubscriberAdmin())) {
        throw new Error('Forbidden');
      }
      await ctx.db.graphSubscription.delete({
        where: { graphId_organizationId: { graphId, organizationId: orgId } },
      });
      return true;
    },

    syncGraph: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const graph = await ctx.db.graph.findUniqueOrThrow({
        where: { id },
        include: { organization: true },
      });
      await requireOrgRole(ctx, graph.organizationId, 'CONTRIBUTOR');

      const result = await syncGraphFromGithub(graph);
      if (result.error) throw new Error(result.error);

      return ctx.db.graph.findUniqueOrThrow({ where: { id }, include: GRAPH_INCLUDE });
    },

    restoreNodeVersion: async (_: unknown, { versionId }: { versionId: string }, ctx: Context) => {
      const version = await ctx.db.nodeVersion.findUniqueOrThrow({ where: { id: versionId } });
      const node = await ctx.db.node.findUniqueOrThrow({ where: { id: version.nodeId } });
      await requireGraphWriteAccess(ctx, node.graphId);

      // Snapshot current state before restoring
      await ctx.db.nodeVersion.create({
        data: {
          nodeId: node.id,
          loc: node.loc,
          name: node.name,
          title: node.title,
          alias: node.alias,
          description: node.description,
          content: node.content,
          tags: node.tags as string[],
          editedBy: ctx.clientId ?? ctx.userId ?? null,
        },
      });

      // Restore the node to the version's state
      return ctx.db.node.update({
        where: { id: node.id },
        data: {
          name: version.name,
          title: version.title,
          alias: version.alias,
          description: version.description,
          content: version.content,
          tags: version.tags as string[],
        },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    addToMyGraphs: async (_: unknown, { graphId }: { graphId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      if (!ctx.userId) throw new Error('Authentication required');

      // Verify the graph is public
      const graph = await ctx.db.graph.findUniqueOrThrow({ where: { id: graphId } });
      if (graph.visibility !== 'PUBLIC') throw new Error('Graph is not public');

      // Find user's personal org
      const membership = await ctx.db.organizationMember.findFirst({
        where: {
          userId: ctx.userId,
          organization: { isPersonal: true },
        },
        include: { organization: { include: { graphBundles: true } } },
      });
      if (!membership) throw new Error('No personal workspace found');

      const org = membership.organization;
      const bundle = org.graphBundles[0];
      if (!bundle) throw new Error('No default bundle found');

      // Create graph subscription (personal org subscribes to the graph)
      await ctx.db.graphSubscription.upsert({
        where: { graphId_organizationId: { graphId, organizationId: org.id } },
        create: {
          graphId,
          organizationId: org.id,
          role: 'READER',
          activated: true,
        },
        update: {},
      });

      // Add graph to the default bundle
      await ctx.db.graphBundleGraph.upsert({
        where: { bundleId_graphId: { bundleId: bundle.id, graphId } },
        create: { bundleId: bundle.id, graphId },
        update: {},
      });

      return true;
    },
  },
};

function deriveNamespace(loc: string): string {
  const parts = loc.split('.');
  return parts.slice(0, 2).join('.');
}

interface NodeEdgeInput {
  targetId: string;
  label?: string;
}

interface NodeInput {
  id?: string;
  graphId: string;
  loc: string;
  name: string;
  title: string;
  alias?: string;
  description?: string;
  content?: string;
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
