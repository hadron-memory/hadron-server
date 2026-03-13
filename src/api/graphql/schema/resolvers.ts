import bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'crypto';
import type { InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import type { PrismaClient, Role, ClientType, OrgRole, Prisma } from '../../../generated/prisma/index.js';
import { serializeTags, deserializeTags, serializeRoles, deserializeRoles, serializeJson, deserializeJson, searchContains, tagsFilter } from '../../../integrations/db/provider.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { syncGraphFromGithub } from '../../../integrations/github/syncGraphFromGithub.js';

export interface Context {
  db: PrismaClient;
  clientId?: string;       // Client.label or "github:<login>"
  userId?: string;         // User.id — only set for OAuth/JWT users
  roles?: ('ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  namespace?: string;      // contributor's writable namespace
  organizationId?: string; // set when the Client is scoped to an organization
}

function requireRole(ctx: Context, required: 'ADMIN' | 'CONTRIBUTOR' | 'READER') {
  const order: Record<string, number> = { READER: 0, CONTRIBUTOR: 1, ADMIN: 2 };
  const highest = ctx.roles ? Math.max(...ctx.roles.map((r) => order[r] ?? -1)) : -1;
  if (highest < order[required]) throw new Error('Forbidden');
}

async function requireOrgRole(
  ctx: Context,
  orgId: string,
  required: 'ADMIN' | 'CONTRIBUTOR' | 'READER',
): Promise<void> {
  // Platform ADMIN bypasses org-level check
  if (ctx.roles?.includes('ADMIN')) return;
  if (!ctx.userId) throw new Error('Forbidden');
  const order: Record<string, number> = { READER: 0, CONTRIBUTOR: 1, ADMIN: 2 };
  const member = await ctx.db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
  });
  if (!member || (order[member.role] ?? -1) < order[required]) {
    throw new Error('Forbidden');
  }
}

const GRAPH_INCLUDE = {
  owner: true,
  subscriptions: { include: { organization: true }, orderBy: { createdAt: 'asc' as const } },
};

const ORG_INCLUDE = {
  owner: true,
  members: { include: { user: true }, orderBy: { createdAt: 'asc' as const } },
  graphs: { include: GRAPH_INCLUDE, orderBy: { name: 'asc' as const } },
  subscriptions: { include: { graph: true }, orderBy: { createdAt: 'asc' as const } },
};

const CLIENT_GQL_INCLUDE = {
  graphSubscriptions: { include: { graph: { include: { owner: true } } }, orderBy: { createdAt: 'asc' as const } },
};

/**
 * Return the list of graph namespaces the given org can access:
 * graphs it owns + graphs it has any subscription to.
 */
async function getAccessibleNamespaces(db: PrismaClient, organizationId: string): Promise<string[]> {
  const graphs = await db.hadronGraph.findMany({
    where: {
      OR: [
        { organizationId },
        { subscriptions: { some: { organizationId } } },
      ],
    },
    select: { name: true },
  });
  return graphs.map((g) => g.name.replace(/\//g, '.'));
}

const INVITE_INCLUDE = {
  organization: { include: ORG_INCLUDE },
  invitedBy: true,
};

const INVITE_EXPIRATION_DAYS = 7;

const SESSION_INCLUDE = { events: { orderBy: { createdAt: 'desc' as const }, take: 50 } };

const toISO = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

export const resolvers = {
  // Field resolvers: deserialize SQLite TEXT back to arrays/objects for GraphQL
  Node: {
    tags: (node: { tags: string | string[] }) => deserializeTags(node.tags),
  },
  GraphConfig: {
    lastSyncedAt: (g: { lastSyncedAt?: Date | string | null }) => toISO(g.lastSyncedAt),
    createdAt: (g: { createdAt: Date | string }) => toISO(g.createdAt)!,
    updatedAt: (g: { updatedAt: Date | string }) => toISO(g.updatedAt)!,
  },
  Organization: {
    createdAt: (o: { createdAt: Date | string }) => toISO(o.createdAt)!,
    updatedAt: (o: { updatedAt: Date | string }) => toISO(o.updatedAt)!,
  },
  Client: {
    roles: (client: { roles: string | string[] }) => deserializeRoles(client.roles),
    graphs: (client: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.clientGraphSubscription
        .findMany({ where: { clientId: client.id }, include: { graph: { include: GRAPH_INCLUDE } } })
        .then((subs) => subs.map((s) => s.graph)),
    subscriptions: (client: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.clientGraphSubscription
        .findMany({ where: { clientId: client.id }, include: { graph: { include: GRAPH_INCLUDE } }, orderBy: { createdAt: 'asc' as const } }),
    user: (client: { userId?: string | null }, _: unknown, ctx: Context) =>
      client.userId ? ctx.db.user.findUnique({ where: { id: client.userId } }) : null,
  },
  User: {
    roles: (user: { roles: string | string[] }) => deserializeRoles(user.roles),
  },
  Session: {
    outcomeMeta: (session: { outcomeMeta: unknown }) => deserializeJson(session.outcomeMeta),
  },
  UsageEvent: {
    actionArgs: (event: { actionArgs: unknown }) => deserializeJson(event.actionArgs),
  },
  OrgInvite: {
    createdAt: (inv: { createdAt: Date | string }) => toISO(inv.createdAt)!,
    expiresAt: (inv: { expiresAt: Date | string }) => toISO(inv.expiresAt)!,
  },

  Query: {
    node: async (_: unknown, { loc }: { loc: string }, ctx: Context) => {
      return ctx.db.node.findUnique({
        where: { loc },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    nodes: async (
      _: unknown,
      { namespace, tags, search, limit }: { namespace?: string; tags?: string[]; search?: string; limit?: number },
      ctx: Context,
    ) => {
      // Org-scoped clients see only nodes in graphs they own or subscribe to
      let accessibleNamespaces: string[] | null = null;
      if (ctx.organizationId && !ctx.roles?.includes('ADMIN')) {
        accessibleNamespaces = await getAccessibleNamespaces(ctx.db, ctx.organizationId);
      }

      return ctx.db.node.findMany({
        where: {
          ...(accessibleNamespaces ? { namespace: { in: accessibleNamespaces } } : {}),
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
      return ctx.db.node.findMany({
        where: { loc: { startsWith: prefix } },
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

    sessions: async (
      _: unknown,
      { type, repo, customerId, limit }: { type?: string; repo?: string; customerId?: string; limit?: number },
      ctx: Context,
    ) => {
      return ctx.db.session.findMany({
        where: {
          ...(type ? { type } : {}),
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
      return ctx.db.client.findMany({ orderBy: { createdAt: 'desc' } });
    },

    client: async (_: unknown, { label }: { label: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.client.findUnique({ where: { label } });
    },

    myClients: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return [];
      return ctx.db.client.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
      });
    },

    users: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.findMany({ orderBy: { createdAt: 'desc' } });
    },

    me: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return null;
      return ctx.db.user.findUnique({ where: { id: ctx.userId } });
    },

    organizations: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.organization.findMany({ orderBy: { name: 'asc' }, include: ORG_INCLUDE });
    },

    myOrganizations: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return [];
      const memberships = await ctx.db.organizationMember.findMany({
        where: { userId: ctx.userId },
        include: { organization: { include: ORG_INCLUDE } },
      });
      return memberships.map((m) => m.organization);
    },

    organization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      if (!ctx.roles?.includes('ADMIN')) {
        // Must be a member
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: id, userId: ctx.userId } },
        });
        if (!member) throw new Error('Forbidden');
      }
      return ctx.db.organization.findUnique({ where: { id }, include: ORG_INCLUDE });
    },

    myInvites: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return [];
      const user = await ctx.db.user.findUnique({ where: { id: ctx.userId } });
      if (!user?.email) return [];
      return ctx.db.orgInvite.findMany({
        where: { email: user.email, status: 'PENDING' },
        include: INVITE_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    },

    organizationInvites: async (_: unknown, { orgId }: { orgId: string }, ctx: Context) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.orgInvite.findMany({
        where: { orgId },
        include: INVITE_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    },

    publicGraphs: async (_: unknown, __: unknown, _ctx: Context) => {
      return _ctx.db.hadronGraph.findMany({
        where: { visibility: 'PUBLIC' },
        orderBy: { name: 'asc' },
        include: GRAPH_INCLUDE,
      });
    },

    myGraphs: async (_: unknown, __: unknown, ctx: Context) => {
      // API-key client — return its explicit ClientGraphSubscriptions
      if (ctx.clientId && !ctx.userId) {
        const client = await ctx.db.client.findUnique({
          where: { label: ctx.clientId },
          include: { graphSubscriptions: { include: { graph: { include: GRAPH_INCLUDE } } } },
        });
        return (client?.graphSubscriptions ?? []).map((s) => s.graph);
      }
      // JWT/OAuth user — union of all org-accessible graphs
      if (ctx.userId) {
        const memberships = await ctx.db.organizationMember.findMany({
          where: { userId: ctx.userId },
          select: { organizationId: true },
        });
        const orgIds = memberships.map((m) => m.organizationId);
        if (orgIds.length === 0) return [];
        return ctx.db.hadronGraph.findMany({
          where: {
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
      requireRole(ctx, 'CONTRIBUTOR');
      const namespace = deriveNamespace(input.loc);
      if (!ctx.roles?.includes('ADMIN') && ctx.namespace && !namespace.startsWith(ctx.namespace)) {
        throw new Error('Forbidden: outside your writable namespace');
      }

      // Org-scoped clients must own the graph or have a CONTRIBUTOR subscription
      if (ctx.organizationId && !ctx.roles?.includes('ADMIN')) {
        const graph = await ctx.db.hadronGraph.findFirst({
          where: {
            name: input.ownerRepo,
            OR: [
              { organizationId: ctx.organizationId },
              { subscriptions: { some: { organizationId: ctx.organizationId, role: 'CONTRIBUTOR' } } },
            ],
          },
          select: { id: true },
        });
        if (!graph) throw new Error('Forbidden: no write access to this graph');
      }
      const tags = serializeTags(input.tags ?? []) as string[];
      const id = input.id ?? randomUUID().replace(/-/g, '');
      // Destructure edges out so it's not passed to Prisma (not a DB column)
      const { edges, ...nodeFields } = input;
      const node = await ctx.db.node.upsert({
        where: { loc: input.loc },
        create: { ...nodeFields, id, namespace, tags },
        update: { ...nodeFields, namespace, tags },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });

      // Replace outgoing edges when caller provides them
      let finalNode = node;
      if (edges !== undefined) {
        await ctx.db.edge.deleteMany({ where: { sourceId: node.id } });
        await ctx.db.pendingEdge.deleteMany({ where: { sourceId: node.id } });
        for (const e of edges) {
          const target = await ctx.db.node.findUnique({ where: { id: e.targetId } });
          if (target) {
            await ctx.db.edge.upsert({
              where: { sourceId_targetId: { sourceId: node.id, targetId: target.id } },
              create: { sourceId: node.id, targetId: target.id, label: e.label ?? null },
              update: { label: e.label ?? null },
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

      // Fire-and-forget git write: checkout writeBranch, write YAML, commit, push.
      writeNodeToGit({
        id: finalNode.id,
        loc: finalNode.loc,
        name: finalNode.name,
        alias: finalNode.alias,
        description: finalNode.description,
        content: finalNode.content,
        tags: deserializeTags(finalNode.tags) as string[],
        outgoingEdges: finalNode.outgoingEdges ?? [],
      }, input.ownerRepo, ctx.clientId).catch((err) => {
        console.error('[upsertNode] git write error:', err);
      });

      return finalNode;
    },

    deleteNode: async (_: unknown, { loc }: { loc: string }, ctx: Context) => {
      requireRole(ctx, 'CONTRIBUTOR');
      await ctx.db.node.delete({ where: { loc } });
      return true;
    },

    moveNode: async (_: unknown, { from, to }: { from: string; to: string }, ctx: Context) => {
      requireRole(ctx, 'CONTRIBUTOR');
      const namespace = deriveNamespace(to);
      if (!ctx.roles?.includes('ADMIN') && ctx.namespace && !namespace.startsWith(ctx.namespace)) {
        throw new Error('Forbidden: outside your writable namespace');
      }
      return ctx.db.node.update({
        where: { loc: from },
        data: { loc: to, namespace },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    // Full replace of a repo's namespace subtree — used by the collection tool.
    replaceSubtree: async (
      _: unknown,
      {
        namespace,
        ownerRepo,
        nodes,
        edges,
      }: { namespace: string; ownerRepo: string; nodes: NodeInput[]; edges: EdgeInput[] },
      ctx: Context,
    ) => {
      requireRole(ctx, 'CONTRIBUTOR');

      await ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.node.deleteMany({ where: { namespace, ownerRepo } });

        for (const input of nodes) {
          await tx.node.create({
            data: { id: input.id ?? randomUUID().replace(/-/g, ''), ...input, namespace: deriveNamespace(input.loc), tags: serializeTags(input.tags ?? []) as string[] },
          });
        }

        for (const edge of edges) {
          const source = await tx.node.findUnique({ where: { loc: edge.sourceLoc } });
          const target = await tx.node.findUnique({ where: { loc: edge.targetLoc } });
          if (source && target) {
            await tx.edge.upsert({
              where: { sourceId_targetId: { sourceId: source.id, targetId: target.id } },
              create: { sourceId: source.id, targetId: target.id, label: edge.label },
              update: { label: edge.label },
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
          type: input.type ?? 'developer',
          clientId: ctx.clientId,
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
          clientId: event.clientId ?? ctx.clientId,
          sessionId: event.sessionId,
        },
      });
      return true;
    },

    createClient: async (
      _: unknown,
      {
        label,
        type,
        roles,
        description,
        namespace,
        organizationId,
        userId,
        expiresAt,
      }: {
        label: string;
        type: string;
        roles: ('ADMIN' | 'CONTRIBUTOR' | 'READER')[];
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
          type: type as ClientType,
          description,
          roles: serializeRoles(roles) as Role[],
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
      if (existing.userId !== ctx.userId && !ctx.roles?.includes('ADMIN')) throw new Error('Forbidden');
      const rawKey = randomBytes(32).toString('hex');
      const keyHash = await bcrypt.hash(rawKey, 12);
      const client = await ctx.db.client.update({ where: { id }, data: { keyHash } });
      return { client, rawKey };
    },

    revokeClient: async (_: unknown, { label }: { label: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      const existing = await ctx.db.client.findUnique({ where: { label } });
      if (!existing) throw new Error('Client not found');
      if (existing.userId !== ctx.userId && !ctx.roles?.includes('ADMIN')) throw new Error('Forbidden');
      await ctx.db.client.delete({ where: { label } });
      return true;
    },

    // ── Client graph subscriptions ────────────────────────────────────────────

    subscribeClientToGraph: async (
      _: unknown,
      { clientId, graphId, subscriptionType, namespace }: { clientId: string; graphId: string; subscriptionType?: string; namespace?: string },
      ctx: Context,
    ) => {
      const client = await ctx.db.client.findUniqueOrThrow({ where: { id: clientId } });
      const graph = await ctx.db.hadronGraph.findUniqueOrThrow({ where: { id: graphId } });

      if (client.organizationId) {
        // Org-scoped client: require org admin + graph accessible to org
        const orgId = client.organizationId;
        await requireOrgRole(ctx, orgId, 'ADMIN');
        const isOwned = graph.organizationId === orgId;
        const isSubscribed = isOwned
          ? null
          : await ctx.db.hadronGraphSubscription.findUnique({
              where: { graphId_organizationId: { graphId, organizationId: orgId } },
            });
        if (!isOwned && !isSubscribed) {
          throw new Error("Forbidden: graph is not accessible to this client's organization");
        }
      } else {
        // User-owned client: require client owner or platform admin
        if (client.userId !== ctx.userId && !ctx.roles?.includes('ADMIN')) throw new Error('Forbidden');
        // Verify graph is public or accessible via one of the user's orgs
        if (graph.visibility !== 'PUBLIC') {
          const userOrgIds = await ctx.db.organizationMember
            .findMany({ where: { userId: ctx.userId! } })
            .then((ms) => ms.map((m) => m.organizationId));
          const isOwnedByUserOrg = userOrgIds.includes(graph.organizationId);
          const isSubscribedByUserOrg = isOwnedByUserOrg
            ? false
            : !!(await ctx.db.hadronGraphSubscription.findFirst({
                where: { graphId, organizationId: { in: userOrgIds } },
              }));
          if (!isOwnedByUserOrg && !isSubscribedByUserOrg) {
            throw new Error('Forbidden: graph is not accessible to you');
          }
        }
      }

      await ctx.db.clientGraphSubscription.upsert({
        where: { clientId_graphId: { clientId, graphId } },
        create: { clientId, graphId, subscriptionType: subscriptionType ?? 'READ_ONLY', namespace: namespace ?? null },
        update: { ...(subscriptionType ? { subscriptionType } : {}), ...(namespace !== undefined ? { namespace } : {}) },
      });
      return ctx.db.client.findUniqueOrThrow({ where: { id: clientId } });
    },

    unsubscribeClientFromGraph: async (
      _: unknown,
      { clientId, graphId }: { clientId: string; graphId: string },
      ctx: Context,
    ) => {
      const client = await ctx.db.client.findUniqueOrThrow({ where: { id: clientId } });
      const orgId = client.organizationId;
      if (!orgId) throw new Error('Client is not scoped to an organization');
      await requireOrgRole(ctx, orgId, 'ADMIN');

      await ctx.db.clientGraphSubscription.delete({
        where: { clientId_graphId: { clientId, graphId } },
      });
      return ctx.db.client.findUniqueOrThrow({ where: { id: clientId } });
    },

    updateUserRoles: async (
      _: unknown,
      { userId, roles }: { userId: string; roles: ('ADMIN' | 'CONTRIBUTOR' | 'READER')[] },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.update({ where: { id: userId }, data: { roles: serializeRoles(roles) as Role[] } });
    },

    updateUserCanInvite: async (
      _: unknown,
      { userId, canInvite }: { userId: string; canInvite: boolean },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.update({ where: { id: userId }, data: { canInvite } });
    },

    // ── Organization management ───────────────────────────────────────────────

    createOrganization: async (
      _: unknown,
      { name, slug }: { name: string; slug: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      const org = await ctx.db.organization.create({
        data: { name, slug, ownerId: ctx.userId ?? null },
        include: ORG_INCLUDE,
      });
      if (ctx.userId) {
        await ctx.db.organizationMember.create({
          data: { organizationId: org.id, userId: ctx.userId, role: 'ADMIN' },
        });
      }
      return org;
    },

    updateOrganization: async (
      _: unknown,
      { id, name, slug }: { id: string; name?: string; slug?: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, id, 'ADMIN');
      return ctx.db.organization.update({
        where: { id },
        data: { ...(name ? { name } : {}), ...(slug ? { slug } : {}) },
        include: ORG_INCLUDE,
      });
    },

    deleteOrganization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      await ctx.db.organization.delete({ where: { id } });
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

    // ── Organization membership ───────────────────────────────────────────────

    addOrganizationMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.organizationMember.create({
        data: { organizationId: orgId, userId, role: role as OrgRole },
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
        data: { role: role as OrgRole },
        include: { user: true },
      });
    },

    removeOrganizationMember: async (
      _: unknown,
      { orgId, userId }: { orgId: string; userId: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: orgId } });
      if (org.ownerId === userId) throw new Error('Cannot remove the owner of an organization');
      await ctx.db.organizationMember.delete({
        where: { organizationId_userId: { organizationId: orgId, userId } },
      });
      return true;
    },

    // ── Graph config management ───────────────────────────────────────────────

    createGraphConfig: async (
      _: unknown,
      {
        orgId,
        name,
        source,
        readBranch,
        writeBranch,
        visibility,
        version,
      }: { orgId: string; name: string; source?: string | null; readBranch?: string; writeBranch?: string; visibility?: string; version?: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.hadronGraph.create({
        data: { organizationId: orgId, ownerId: ctx.userId ?? null, name, source, readBranch, writeBranch, visibility, version },
        include: GRAPH_INCLUDE,
      });
    },

    updateGraphConfig: async (
      _: unknown,
      {
        id,
        source,
        readBranch,
        writeBranch,
        visibility,
        version,
      }: { id: string; source?: string; readBranch?: string; writeBranch?: string; visibility?: string; version?: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.hadronGraph.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, graph.organizationId, 'ADMIN');
      return ctx.db.hadronGraph.update({
        where: { id },
        data: {
          ...(source !== undefined ? { source } : {}),
          ...(readBranch !== undefined ? { readBranch } : {}),
          ...(writeBranch !== undefined ? { writeBranch } : {}),
          ...(visibility !== undefined ? { visibility } : {}),
          ...(version !== undefined ? { version } : {}),
        },
        include: GRAPH_INCLUDE,
      });
    },

    deleteGraphConfig: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const graph = await ctx.db.hadronGraph.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, graph.organizationId, 'ADMIN');
      await ctx.db.hadronGraph.delete({ where: { id } });
      return true;
    },

    // ── Organization invites ──────────────────────────────────────────────────

    createOrganizationInvite: async (
      _: unknown,
      { orgId, email }: { orgId: string; email: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');

      // Check permission: platform ADMIN, org owner, org ADMIN, or user with canInvite who is an org member
      const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: orgId } });
      const isPlatformAdmin = ctx.roles?.includes('ADMIN');
      const isOrgOwner = org.ownerId === ctx.userId;
      if (!isPlatformAdmin && !isOrgOwner) {
        const member = await ctx.db.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
        });
        if (!member) throw new Error('Forbidden: you must be a member of this organization');
        const isOrgAdmin = member.role === 'ADMIN';
        if (!isOrgAdmin) {
          const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.userId } });
          if (!user.canInvite) throw new Error('Forbidden: you do not have permission to invite');
        }
      }

      // Prevent duplicate pending invites
      const existing = await ctx.db.orgInvite.findFirst({
        where: { orgId, email, status: 'PENDING' },
      });
      if (existing) throw new Error('A pending invite already exists for this email');

      // Check if there's a user with this email — if not, generate a token
      const targetUser = await ctx.db.user.findUnique({ where: { email } });
      const token = targetUser ? null : randomBytes(32).toString('hex');

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRATION_DAYS);

      return ctx.db.orgInvite.create({
        data: { orgId, email, invitedById: ctx.userId, token, expiresAt },
        include: INVITE_INCLUDE,
      });
    },

    acceptInvite: async (_: unknown, { inviteId }: { inviteId: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      if (!user.email) throw new Error('You must set an email on your account to accept invites');

      const invite = await ctx.db.orgInvite.findUniqueOrThrow({
        where: { id: inviteId },
        include: INVITE_INCLUDE,
      });

      if (invite.email !== user.email) throw new Error('Forbidden: this invite is not for you');
      if (invite.status !== 'PENDING') throw new Error(`Invite is already ${invite.status.toLowerCase()}`);
      if (new Date(invite.expiresAt) < new Date()) throw new Error('Invite has expired');

      // Add user as READER member of the org
      await ctx.db.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: invite.orgId, userId: ctx.userId } },
        create: { organizationId: invite.orgId, userId: ctx.userId, role: 'READER' },
        update: {},
      });

      return ctx.db.orgInvite.update({
        where: { id: inviteId },
        data: { status: 'ACCEPTED' },
        include: INVITE_INCLUDE,
      });
    },

    declineInvite: async (_: unknown, { inviteId }: { inviteId: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      if (!user.email) throw new Error('You must set an email on your account to decline invites');

      const invite = await ctx.db.orgInvite.findUniqueOrThrow({
        where: { id: inviteId },
        include: INVITE_INCLUDE,
      });

      if (invite.email !== user.email) throw new Error('Forbidden: this invite is not for you');
      if (invite.status !== 'PENDING') throw new Error(`Invite is already ${invite.status.toLowerCase()}`);

      return ctx.db.orgInvite.update({
        where: { id: inviteId },
        data: { status: 'DECLINED' },
        include: INVITE_INCLUDE,
      });
    },

    cancelInvite: async (_: unknown, { inviteId }: { inviteId: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');

      const invite = await ctx.db.orgInvite.findUniqueOrThrow({
        where: { id: inviteId },
        include: INVITE_INCLUDE,
      });

      if (invite.status !== 'PENDING') throw new Error(`Invite is already ${invite.status.toLowerCase()}`);

      // Allow: platform ADMIN, org owner, org ADMIN, or the user who sent the invite
      const isSender = invite.invitedById === ctx.userId;
      const isPlatformAdmin = ctx.roles?.includes('ADMIN');
      if (!isSender && !isPlatformAdmin) {
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: invite.orgId } });
        const isOrgOwner = org.ownerId === ctx.userId;
        if (!isOrgOwner) {
          await requireOrgRole(ctx, invite.orgId, 'ADMIN');
        }
      }

      return ctx.db.orgInvite.update({
        where: { id: inviteId },
        data: { status: 'CANCELLED' },
        include: INVITE_INCLUDE,
      });
    },

    transferOrganizationOwnership: async (
      _: unknown,
      { orgId, newOwnerId }: { orgId: string; newOwnerId: string },
      ctx: Context,
    ) => {
      const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: orgId } });
      // Only the current owner or a platform ADMIN can transfer
      if (org.ownerId !== ctx.userId && !ctx.roles?.includes('ADMIN')) throw new Error('Forbidden');

      // New owner must already be a member of the org
      const newOwnerMember = await ctx.db.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: orgId, userId: newOwnerId } },
      });
      if (!newOwnerMember) throw new Error('New owner must already be a member of the organization');

      // Promote new owner to ADMIN
      await ctx.db.organizationMember.update({
        where: { organizationId_userId: { organizationId: orgId, userId: newOwnerId } },
        data: { role: 'ADMIN' },
      });

      // Demote old owner to ADMIN member (they remain a member, just no longer owner)
      if (org.ownerId) {
        await ctx.db.organizationMember.upsert({
          where: { organizationId_userId: { organizationId: orgId, userId: org.ownerId } },
          create: { organizationId: orgId, userId: org.ownerId, role: 'ADMIN' },
          update: { role: 'ADMIN' },
        });
      }

      return ctx.db.organization.update({
        where: { id: orgId },
        data: { ownerId: newOwnerId },
        include: ORG_INCLUDE,
      });
    },

    transferGraphOwnership: async (
      _: unknown,
      { graphId, newOwnerId }: { graphId: string; newOwnerId: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.hadronGraph.findUniqueOrThrow({ where: { id: graphId } });
      if (graph.ownerId !== ctx.userId && !ctx.roles?.includes('ADMIN')) throw new Error('Forbidden');
      return ctx.db.hadronGraph.update({
        where: { id: graphId },
        data: { ownerId: newOwnerId },
        include: GRAPH_INCLUDE,
      });
    },

    syncGraphConfig: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const graph = await ctx.db.hadronGraph.findUniqueOrThrow({
        where: { id },
        include: { organization: true },
      });
      await requireOrgRole(ctx, graph.organizationId, 'CONTRIBUTOR');

      const result = await syncGraphFromGithub(graph);
      if (result.error) throw new Error(result.error);

      return ctx.db.hadronGraph.findUniqueOrThrow({ where: { id }, include: GRAPH_INCLUDE });
    },

    // ── Graph subscriptions ────────────────────────────────────────────────────

    createGraphSubscription: async (
      _: unknown,
      { graphId, orgId, role }: { graphId: string; orgId: string; role: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.hadronGraph.findUniqueOrThrow({ where: { id: graphId } });

      if (graph.visibility === 'PUBLIC') {
        // Any org admin may self-subscribe to a public graph
        await requireOrgRole(ctx, orgId, 'ADMIN');
      } else {
        // Private graph: only the owner org admin or platform admin can add subscribers
        await requireOrgRole(ctx, graph.organizationId, 'ADMIN');
      }

      // Prevent the owning org from subscribing (they have implicit access)
      if (graph.organizationId === orgId) {
        throw new Error('Owner organization has implicit access and cannot subscribe');
      }

      return ctx.db.hadronGraphSubscription.create({
        data: { graphId, organizationId: orgId, role },
        include: { graph: { include: GRAPH_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
    },

    updateGraphSubscription: async (
      _: unknown,
      { graphId, orgId, role }: { graphId: string; orgId: string; role: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.hadronGraph.findUniqueOrThrow({ where: { id: graphId } });
      await requireOrgRole(ctx, graph.organizationId, 'ADMIN');
      return ctx.db.hadronGraphSubscription.update({
        where: { graphId_organizationId: { graphId, organizationId: orgId } },
        data: { role },
        include: { graph: { include: GRAPH_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
    },

    deleteGraphSubscription: async (
      _: unknown,
      { graphId, orgId }: { graphId: string; orgId: string },
      ctx: Context,
    ) => {
      const graph = await ctx.db.hadronGraph.findUniqueOrThrow({ where: { id: graphId } });
      // Owner admin, platform admin, or the subscribing org itself can remove
      const isOwnerAdmin = async () => {
        if (ctx.roles?.includes('ADMIN')) return true;
        if (!ctx.userId) return false;
        const m = await ctx.db.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: graph.organizationId, userId: ctx.userId } },
        });
        return m?.role === 'ADMIN';
      };
      const isSubscriberAdmin = async () => {
        if (!ctx.userId) return false;
        const m = await ctx.db.organizationMember.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
        });
        return m?.role === 'ADMIN';
      };
      if (!(await isOwnerAdmin()) && !(await isSubscriberAdmin())) {
        throw new Error('Forbidden');
      }
      await ctx.db.hadronGraphSubscription.delete({
        where: { graphId_organizationId: { graphId, organizationId: orgId } },
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
  loc: string;
  name: string;
  alias?: string;
  description?: string;
  content?: string;
  tags?: string[];
  ownerRepo: string;
  edges?: NodeEdgeInput[];
}

interface EdgeInput {
  sourceLoc: string;
  targetLoc: string;
  label?: string;
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
  clientId?: string;
  sessionId?: string;
}
