import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import type { InputJsonValue } from '../generated/prisma/runtime/library.js';
import type { PrismaClient } from '../generated/prisma/index.js';

export interface Context {
  db: PrismaClient;
  clientId?: string; // set by auth middleware
  role?: 'ADMIN' | 'CONTRIBUTOR' | 'READER';
  namespace?: string; // contributor's writable namespace
}

function requireRole(ctx: Context, required: 'ADMIN' | 'CONTRIBUTOR' | 'READER') {
  const order = { READER: 0, CONTRIBUTOR: 1, ADMIN: 2 };
  if (!ctx.role || order[ctx.role] < order[required]) {
    throw new Error('Forbidden');
  }
}

export const resolvers = {
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
          ...(tags?.length ? { tags: { hasEvery: tags } } : {}),
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: 'insensitive' } },
                  { description: { contains: search, mode: 'insensitive' } },
                  { content: { contains: search, mode: 'insensitive' } },
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

    apiKeys: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
    },

    me: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.clientId) return null;
      // clientId format for GitHub OAuth users: "github-oauth:<login>"
      if (!ctx.clientId.startsWith('github-oauth:')) return null;
      const login = ctx.clientId.slice('github-oauth:'.length);
      return ctx.db.user.findFirst({ where: { login } });
    },
  },

  Mutation: {
    upsertNode: async (_: unknown, { input }: { input: NodeInput }, ctx: Context) => {
      requireRole(ctx, 'CONTRIBUTOR');
      const namespace = deriveNamespace(input.loc);
      if (ctx.role === 'CONTRIBUTOR' && ctx.namespace && !namespace.startsWith(ctx.namespace)) {
        throw new Error('Forbidden: outside your writable namespace');
      }
      return ctx.db.node.upsert({
        where: { loc: input.loc },
        create: { ...input, namespace, tags: input.tags ?? [] },
        update: { ...input, namespace, tags: input.tags ?? [] },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
    },

    deleteNode: async (_: unknown, { loc }: { loc: string }, ctx: Context) => {
      requireRole(ctx, 'CONTRIBUTOR');
      await ctx.db.node.delete({ where: { loc } });
      return true;
    },

    // Full replace of a repo's namespace subtree — used by the collection tool.
    // Deletes all existing nodes in the namespace owned by ownerRepo, then inserts
    // the new set. Runs in a transaction so partial failures don't corrupt the graph.
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

      await ctx.db.$transaction(async (tx) => {
        // Delete all nodes in this namespace owned by this repo
        await tx.node.deleteMany({ where: { namespace, ownerRepo } });

        // Insert new nodes
        for (const input of nodes) {
          await tx.node.create({
            data: { ...input, namespace: deriveNamespace(input.loc), tags: input.tags ?? [] },
          });
        }

        // Insert edges (source and target must already exist)
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

    recordUsage: async (_: unknown, { event }: { event: UsageEventInput }, ctx: Context) => {
      const node = event.nodeLoc
        ? await ctx.db.node.findUnique({ where: { loc: event.nodeLoc } })
        : null;

      await ctx.db.usageEvent.create({
        data: {
          type: event.type,
          nodeLoc: event.nodeLoc,
          nodeId: node?.id,
          actionArgs: event.actionArgs as InputJsonValue | undefined,
          success: event.success,
          clientId: event.clientId ?? ctx.clientId,
          sessionId: event.sessionId,
        },
      });
      return true;
    },

    createApiKey: async (
      _: unknown,
      {
        label,
        role,
        namespace,
        expiresAt,
      }: { label: string; role: 'ADMIN' | 'CONTRIBUTOR' | 'READER'; namespace?: string; expiresAt?: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      const rawKey = randomBytes(32).toString('hex');
      const keyHash = await bcrypt.hash(rawKey, 12);
      const apiKey = await ctx.db.apiKey.create({
        data: {
          label,
          keyHash,
          role,
          namespace,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        },
      });
      return { apiKey, rawKey };
    },

    revokeApiKey: async (_: unknown, { label }: { label: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      await ctx.db.apiKey.delete({ where: { label } });
      return true;
    },
  },
};

// Derive namespace from a dotted loc: first two dot-separated segments.
// "micromentor-org.mmdata.models" → "micromentor-org.mmdata"
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

interface UsageEventInput {
  type: string;
  nodeLoc?: string;
  actionArgs?: Record<string, unknown>;
  success?: boolean;
  clientId?: string;
  sessionId?: string;
}
