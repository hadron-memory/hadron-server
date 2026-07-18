/**
 * Shared node-schema enforcement seam (#725 / #737).
 *
 * A single choke point every GraphQL node-WRITE path routes through, so the
 * "a structured record must satisfy its collection" invariant is enforced
 * uniformly — not re-implemented per resolver. Wraps the pure validator
 * (src/lib/validateNodeAgainstSchema.ts) with the memory-schema fetch + the
 * empty-objectType normalization + the BAD_USER_INPUT mapping.
 *
 * Used by writeNodeCore, replaceSubtree, mergeNodes, restoreNodeRevision, and
 * mergeMemories. (The MCP create/update tools surface violations as tool-error
 * text, so they call the pure validator directly rather than this GraphQL seam.)
 */
import { GraphQLError } from 'graphql';
import type { PrismaClient } from '../generated/prisma/index.js';
import { validateNodeAgainstSchema, NodeSchemaViolation } from './validateNodeAgainstSchema.js';
import type { MemorySchema } from './memorySchema.js';

/**
 * An empty/whitespace objectType means "no collection" → null (an ordinary node).
 * `undefined` is PRESERVED (omit-on-update = leave unchanged) — do NOT collapse
 * it to null, or a partial update would clobber the existing objectType.
 */
export function normalizeObjectType(v: string | null | undefined): string | null | undefined {
  if (typeof v === 'string' && v.trim() === '') return null;
  return v;
}

/** DB handle that can read a memory's schema — a PrismaClient or a transaction client. */
type MemorySchemaReader = Pick<PrismaClient, 'memory'>;

/**
 * Fetch the memory's schema and enforce it on a node's RESULTING objectType /
 * properties. No-op for an unschema'd memory or a non-collection node. Throws
 * GraphQLError(BAD_USER_INPUT) on a violation.
 *
 * @param db        PrismaClient or tx client (the schema read is tx-independent).
 * @param memoryId  the node's (target) memory.
 * @param objectType the resulting collection discriminator (input-overrides-else-existing).
 * @param properties the resulting properties.
 */
export async function enforceNodeSchemaOnWrite(
  db: MemorySchemaReader,
  memoryId: string,
  objectType: string | null | undefined,
  properties: unknown,
): Promise<void> {
  const norm = normalizeObjectType(objectType);
  if (norm == null) return; // ordinary node — nothing to enforce
  const row = await db.memory.findUnique({ where: { id: memoryId }, select: { schema: true } });
  try {
    validateNodeAgainstSchema(
      row?.schema as unknown as MemorySchema | null,
      norm,
      (properties ?? null) as Record<string, unknown> | null,
    );
  } catch (e) {
    if (e instanceof NodeSchemaViolation) {
      throw new GraphQLError(e.message, { extensions: { code: 'BAD_USER_INPUT' } });
    }
    throw e;
  }
}
