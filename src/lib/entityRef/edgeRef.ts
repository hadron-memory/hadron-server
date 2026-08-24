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
import { findMemoryByAliasedUrn } from '../urnAlias.js';
import { EdgeNotFoundError } from './errors.js';

export async function resolveEdgeRef(
  db: Pick<PrismaClient, 'edge' | 'memory' | 'urnAlias'>,
  ref: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  // Form 1: bare ID — PK lookup with the soft-delete exclusion in the query.
  // The memory-liveness join keeps the PK path consistent with the URN path
  // below (an edge behind a soft-deleted memory is not-found either way —
  // PR-475 Copilot review).
  if (isIdFunc(ref)) {
    const edge = await db.edge.findFirst({
      where: {
        id: ref,
        ...(options?.includeDeleted ? {} : { deletedAt: null, memory: { deletedAt: null } }),
      },
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

  // Full URN `<memory-urn>::<loc>`.
  //
  // Canonical (`::`) input: the LOC is always the FINAL `::`-leaf (locs never
  // contain `::`; composeEdgeUrn attaches them that way) and the memory URN is
  // everything before it — which may itself span more than two hierarchy
  // levels (e.g. a per-user `<org>::<agent>::app-user:<id>` memory), so a
  // fixed two-segment prefix would mis-split those (PR-475 review, Codex P2).
  // Legacy single-`:` input can't be split unambiguously, so it keeps the
  // historical two-segment memory heuristic (mirrors resolveNodeRef).
  let loc: string;
  let memoryUrnCandidates: string[];
  if (normalized.includes('::')) {
    const parts = normalized.split('::');
    if (parts.length < 3) throw new EdgeNotFoundError(ref);
    loc = parts[parts.length - 1];
    const memParts = parts.slice(0, -1);
    // The stored Memory.urn may be legacy (`:`) or canonical (`::`) form.
    memoryUrnCandidates = [memParts.join('::'), memParts.join(':')];
  } else {
    const parts = normalized.split(':');
    if (parts.length < 3) throw new EdgeNotFoundError(ref);
    loc = parts.slice(2).join(':');
    memoryUrnCandidates = [`${parts[0]}:${parts[1]}`, `${parts[0]}::${parts[1]}`];
  }

  const memory =
    (await db.memory.findFirst({
      where: { urn: { in: memoryUrnCandidates } },
      select: { id: true, deletedAt: true },
    })) ??
    // #1079 — same arm as resolveNodeRef, for the same reason: this resolver
    // splits the memory prefix out itself rather than delegating to
    // `resolveMemoryRef`, so a renamed memory would otherwise strand every
    // published edge URN under it.
    (await findMemoryByAliasedUrn(db, memoryUrnCandidates, () => {
      throw new EdgeNotFoundError(ref);
    }));
  if (!memory || (!options?.includeDeleted && memory.deletedAt)) {
    throw new EdgeNotFoundError(ref);
  }
  const edge = await db.edge.findUnique({
    where: { loc_memoryId: { loc, memoryId: memory.id } },
    select: { id: true, deletedAt: true },
  });
  if (!edge || (!options?.includeDeleted && edge.deletedAt)) {
    throw new EdgeNotFoundError(ref);
  }
  return { id: edge.id };
}
