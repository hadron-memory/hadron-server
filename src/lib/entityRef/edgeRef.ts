/**
 * resolveEdgeRef — convert an inbound edge reference string to a
 * definite edge ID. See `memoryRef.ts` for the broader convention.
 *
 * Spec 037 made edges first-class, memory-scoped, loc-addressed peers
 * of nodes (`hrn:edge:<memory-urn>::<loc>`, the edge's memory being its
 * SOURCE node's memory). This helper completes the spec-007 resolveXRef
 * family for them (#473 — the uniform `edge(ref:)` read surface).
 *
 * Accepted forms:
 *   - `<id>`                                 bare ID (cuid or 32-hex)
 *   - `hrn:edge:<memory-urn>::<loc>`         prefixed full URN
 *   - `<memory-urn>::<loc>`                  bare full URN
 *
 * Unlike `resolveNodeRef` there is NO short-loc-within-context form:
 * edges are only ever resolved at the API boundary (spec 022 FR-007a),
 * where the input must be fully qualified — graph traversal reaches
 * edges through their source node, not by ref.
 *
 * Throws `EdgeNotFoundError` for any unresolvable ref and
 * `UrnNotQualifiedError` for a non-ID input without the org+memory+loc
 * shape. Soft-deleted edges — and edges reached through a soft-deleted
 * memory — are treated as not-existing unless `{ includeDeleted: true }`.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseUrnInput, assertFullyQualifiedUrn } from '../urn.js';
import { EdgeNotFoundError } from './errors.js';

export async function resolveEdgeRef(
  db: Pick<PrismaClient, 'edge' | 'memory'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  // Form 1: bare ID — PK lookup with the soft-delete exclusion in the query.
  if (isIdFunc(ref)) {
    const edge = await db.edge.findFirst({
      where: { id: ref, ...(options?.includeDeleted ? {} : { deletedAt: null }) },
      select: { id: true },
    });
    if (!edge) throw new EdgeNotFoundError(ref);
    return { id: edge.id };
  }

  const parsed = parseUrnInput(ref);

  // A wrong-type URN prefix (e.g. `hrn:node:...`, `hrn:memory:...`) is a
  // coercion bug — fail loudly rather than silently look up the bare value.
  if (parsed.type !== 'unknown' && parsed.type !== 'edge') {
    throw new EdgeNotFoundError(ref);
  }
  const normalized = parsed.value;

  // A prefixed input whose body is a bare ID (`hrn:edge:<id>`) is not a valid
  // edge-URN shape — edge URNs are always `<memory-urn>::<loc>`.
  if (isIdFunc(normalized)) {
    throw new EdgeNotFoundError(ref);
  }

  // API-boundary discipline (spec 022): a non-ID input must carry the full
  // org+memory+loc shape.
  assertFullyQualifiedUrn(ref, 'edge');

  // Full URN `<memory-urn>::<loc>`. Prefer canonical `::` as the hierarchy
  // separator so a multi-atom loc (e.g. `intro:next`) stays one leaf; fall
  // back to single-`:` for legacy inputs (mirrors resolveNodeRef).
  const parts = normalized.includes('::')
    ? normalized.split('::')
    : normalized.split(':');
  if (parts.length < 3) throw new EdgeNotFoundError(ref);

  // First two segments are <org>:<memorySlug>. Memory rows may be stored in
  // legacy (`:`) or canonical (`::`) form — the OR matches whichever is on disk.
  const memory = await db.memory.findFirst({
    where: {
      OR: [
        { urn: `${parts[0]}:${parts[1]}` },
        { urn: `${parts[0]}::${parts[1]}` },
      ],
    },
    select: { id: true, deletedAt: true },
  });
  if (!memory || (!options?.includeDeleted && memory.deletedAt)) {
    throw new EdgeNotFoundError(ref);
  }
  // Locs are stored with single-`:` atoms; `::` is only the memory/loc boundary.
  const loc = parts.slice(2).join(':');
  const edge = await db.edge.findUnique({
    where: { loc_memoryId: { loc, memoryId: memory.id } },
    select: { id: true, deletedAt: true },
  });
  if (!edge || (!options?.includeDeleted && edge.deletedAt)) {
    throw new EdgeNotFoundError(ref);
  }
  return { id: edge.id };
}
