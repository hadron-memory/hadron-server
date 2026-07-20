/**
 * Object-store API resolvers (#745) — the legible sugar surface over structured
 * storage. Each op is a thin projection onto an existing, fully-gated node
 * resolver, so auth, encryption, conformance, revisions, git-sync and the
 * concurrency guards are inherited — NOT re-implemented:
 *
 *   createObject → createNode (+ schema conformance)
 *   updateObject → updateNodeProperties (atomic merge + conformance)
 *   getObject    → node(ref:)
 *   deleteObject → deleteNode (soft delete by default)
 *   findObjects  → findNodes (objectType facet + where + sortProperty)
 *
 * The pure transforms (flat projection, loc/name derivation, match→where and
 * sort→sortProperty desugaring with schema-inferred casts) live in
 * src/lib/objectStore.ts. Design: `hadron-server::design:object-store-api`.
 */
import { GraphQLError } from 'graphql';
import { generateId } from '../../../lib/id.js';
import type { Context } from './resolvers.helpers.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { nodeMutations } from './resolvers.mutation.node.js';
import { nodeQueries } from './resolvers.query.node.js';
import type { MemorySchema } from '../../../lib/memorySchema.js';
import type { NodeWhere } from '../../../lib/retrieval/nodeWhere.js';
import {
  ObjectStoreError,
  projectNodeToObject,
  assertNoReservedKeys,
  isPlainObject,
  deriveObjectLoc,
  deriveObjectName,
  matchToWhere,
  combineWhere,
  sortToPropertySort,
  type StoredObject,
} from '../../../lib/objectStore.js';

const badInput = (msg: string) => new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });

/** Map an ObjectStoreError to BAD_USER_INPUT; re-throw everything else (node resolver errors pass through). */
function mapObjectError(e: unknown): never {
  if (e instanceof ObjectStoreError) throw badInput(e.message);
  throw e;
}

/**
 * Best-effort read of a memory's property schema, for cast inference only (the
 * actual data access is gated by the delegated findNodes). Returns null when the
 * ref doesn't resolve — casts then fall back to value/text inference.
 */
async function readMemorySchema(ctx: Context, memoryRef: string): Promise<MemorySchema | null> {
  try {
    const { id } = await resolveMemoryRef(ctx.db, memoryRef);
    const row = await ctx.db.memory.findUnique({ where: { id }, select: { schema: true } });
    return (row?.schema as unknown as MemorySchema | null) ?? null;
  } catch {
    return null;
  }
}

/** Require a non-empty string `type` (the collection). */
function requireType(type: unknown): string {
  if (typeof type !== 'string' || type.trim() === '') {
    throw badInput('`type` (the collection) is required.');
  }
  return type;
}

export const objectMutations = {
  /** Create an object in a collection → a node with objectType + flat properties. */
  createObject: async (
    _: unknown,
    { memoryRef, type, fields, key, name }: { memoryRef: string; type: string; fields: unknown; key?: string | null; name?: string | null },
    ctx: Context,
  ): Promise<StoredObject> => {
    const t = requireType(type);
    const f = fields ?? {};
    if (!isPlainObject(f)) throw badInput('`fields` must be a JSON object.');
    let loc: string;
    try {
      assertNoReservedKeys(f);
      loc = deriveObjectLoc(t, key ?? undefined, generateId);
    } catch (e) {
      mapObjectError(e);
    }
    const nodeName = deriveObjectName(t, f, name ?? undefined);
    const node = await nodeMutations.createNode(
      _,
      { input: { memoryId: memoryRef, loc, name: nodeName, objectType: t, properties: f } },
      ctx,
    );
    return projectNodeToObject(node);
  },

  /** Merge fields into an object (server-side atomic merge + conformance) → node updateNodeProperties. */
  updateObject: async (
    _: unknown,
    { ref, fields, reason }: { ref: string; fields: unknown; reason?: string | null },
    ctx: Context,
  ): Promise<StoredObject> => {
    const f = fields ?? {};
    if (!isPlainObject(f)) throw badInput('`fields` must be a JSON object.');
    try {
      assertNoReservedKeys(f);
    } catch (e) {
      mapObjectError(e);
    }
    const node = await nodeMutations.updateNodeProperties(_, { nodeRef: ref, properties: f, reason }, ctx);
    return projectNodeToObject(node);
  },

  /** Delete an object (soft by default) → node deleteNode. */
  deleteObject: async (
    _: unknown,
    { ref, hard }: { ref: string; hard?: boolean | null },
    ctx: Context,
  ): Promise<boolean> => {
    await nodeMutations.deleteNode(_, { nodeRef: ref, hard }, ctx);
    return true;
  },
};

export const objectQueries = {
  /** Read one object by id → node(ref:), projected flat. Null when not found/inaccessible. */
  object: async (_: unknown, { ref }: { ref: string }, ctx: Context): Promise<StoredObject | null> => {
    const node = await nodeQueries.node(_, { ref }, ctx);
    return node ? projectNodeToObject(node) : null;
  },

  /** Query a collection → findNodes with the objectType facet + desugared match/where + sort. */
  findObjects: async (
    _: unknown,
    {
      memoryRef, type, match, where, sort, limit, offset,
    }: {
      memoryRef: string;
      type: string;
      match?: Record<string, unknown> | null;
      where?: NodeWhere | null;
      sort?: Record<string, unknown> | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ): Promise<{ objects: StoredObject[]; total: number | null }> => {
    const t = requireType(type);
    const schema = await readMemorySchema(ctx, memoryRef);
    let combinedWhere: NodeWhere | undefined;
    let sortProperty;
    try {
      combinedWhere = combineWhere(matchToWhere(match, t, schema), where ?? null);
      sortProperty = sortToPropertySort(sort, t, schema);
    } catch (e) {
      mapObjectError(e);
    }
    const result = await nodeQueries.findNodes(
      _,
      {
        filter: { memoryIds: [memoryRef], objectType: t, ...(combinedWhere ? { where: combinedWhere } : {}) },
        ...(sortProperty ? { sortProperty } : {}),
        limit: limit ?? undefined,
        offset: offset ?? undefined,
      },
      ctx,
    );
    return {
      objects: result.hits.map((h: { node: { id: string; objectType: string | null; properties: unknown } }) => projectNodeToObject(h.node)),
      total: result.total ?? null,
    };
  },
};
