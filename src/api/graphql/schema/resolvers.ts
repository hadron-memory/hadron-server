import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import type { InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import type { PrismaClient, Role, ClientType, Prisma } from '../../../generated/prisma/index.js';
import { serializeTags, deserializeTags, serializeJson, deserializeJson, searchContains, tagsFilter } from '../../../integrations/db/provider.js';

export interface Context {
  db: PrismaClient;
  clientId?: string;  // Client.label or "github:<login>"
  userId?: string;    // User.id — only set for OAuth/JWT users
  role?: 'ADMIN' | 'CONTRIBUTOR' | 'READER';
  namespace?: string; // contributor's writable namespace
}

function requireRole(ctx: Context, required: 'ADMIN' | 'CONTRIBUTOR' | 'READER') {
  const order = { READER: 0, CONTRIBUTOR: 1, ADMIN: 2 };
  if (!ctx.role || order[ctx.role] < order[required]) {
    throw new Error('Forbidden');
  }
}

const SESSION_INCLUDE = { events: { orderBy: { createdAt: 'desc' as const }, take: 50 } };

export const resolvers = {
  // Field resolvers: deserialize SQLite TEXT back to arrays/objects for GraphQL
  Node: {
    tags: (node: { tags: string | string[] }) => deserializeTags(node.tags),
  },
  Session: {
    outcomeMeta: (session: { outcomeMeta: unknown }) => deserializeJson(session.outcomeMeta),
  },
  UsageEvent: {
    actionArgs: (event: { actionArgs: unknown }) => deserializeJson(event.actionArgs),
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
      return ctx.db.node.findMany({
        where: {
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

    users: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.findMany({ orderBy: { createdAt: 'desc' } });
    },

    me: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return null;
      return ctx.db.user.findUnique({ where: { id: ctx.userId } });
    },
  },

  Mutation: {
    upsertNode: async (_: unknown, { input }: { input: NodeInput }, ctx: Context) => {
      requireRole(ctx, 'CONTRIBUTOR');
      const namespace = deriveNamespace(input.loc);
      if (ctx.role === 'CONTRIBUTOR' && ctx.namespace && !namespace.startsWith(ctx.namespace)) {
        throw new Error('Forbidden: outside your writable namespace');
      }
      const tags = serializeTags(input.tags ?? []) as string[];
      return ctx.db.node.upsert({
        where: { loc: input.loc },
        create: { ...input, namespace, tags },
        update: { ...input, namespace, tags },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    deleteNode: async (_: unknown, { loc }: { loc: string }, ctx: Context) => {
      requireRole(ctx, 'CONTRIBUTOR');
      await ctx.db.node.delete({ where: { loc } });
      return true;
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
            data: { ...input, namespace: deriveNamespace(input.loc), tags: serializeTags(input.tags ?? []) as string[] },
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
        role,
        description,
        namespace,
        expiresAt,
      }: {
        label: string;
        type: string;
        role: 'ADMIN' | 'CONTRIBUTOR' | 'READER';
        description?: string;
        namespace?: string;
        expiresAt?: string;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      const rawKey = randomBytes(32).toString('hex');
      const keyHash = await bcrypt.hash(rawKey, 12);
      const client = await ctx.db.client.create({
        data: {
          label,
          keyHash,
          type: type as ClientType,
          description,
          role: role as Role,
          namespace,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        },
      });
      return { client, rawKey };
    },

    revokeClient: async (_: unknown, { label }: { label: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      await ctx.db.client.delete({ where: { label } });
      return true;
    },

    updateUserRole: async (
      _: unknown,
      { userId, role }: { userId: string; role: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.update({ where: { id: userId }, data: { role: role as Role } });
    },
  },
};

function deriveNamespace(loc: string): string {
  const parts = loc.split('.');
  return parts.slice(0, 2).join('.');
}

interface NodeInput {
  loc: string;
  name: string;
  alias?: string;
  description?: string;
  content?: string;
  tags?: string[];
  ownerRepo: string;
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
