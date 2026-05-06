/**
 * resolveNodeRef — convert an inbound node reference string to a
 * definite node ID. See `memoryRef.ts` for the broader convention.
 *
 * Spec: 007-entity-id-or-urn (extension to nodes for spec 005 graph
 * traversal callers — primarily edges).
 *
 * Accepted forms:
 *   - `<id>`                                    bare ID (cuid or 32-hex)
 *   - `urn:node:<memory-urn>:<loc>`             prefixed full URN
 *   - `<memory-urn>:<loc>`                      bare full URN (e.g.
 *                                                 `acme.com:mmdata:services:db-model-helper`)
 *   - `<loc>`                                   short loc — resolved
 *                                                 within `contextMemoryId`
 *
 * `contextMemoryId` is the memory the caller "is in" — typically the
 * source node's memory when resolving an outgoing edge target. Short
 * locs resolve relative to it; full URNs resolve against the memory
 * named in the URN (which may differ from the context memory — that
 * supports cross-memory edges).
 *
 * Throws `NodeNotFoundError` for any unresolvable ref. Soft-deleted
 * nodes are treated as not-existing.
 *
 * Why this lives next to `memoryRef.ts` and friends: spec 007's
 * resolution-helpers contract is the single place callers go to turn
 * an inbound entity-ref string into a definite ID. This adds nodes to
 * that contract so edge-target resolution gets the same uniform shape
 * the memory/agent/app refs already have, instead of each caller (the
 * upsertNode resolver, MCP shims) inventing its own one-off lookup.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId } from './shape.js';
import { parseUrnInput } from '../urn.js';
import { NodeNotFoundError } from './errors.js';

export async function resolveNodeRef(
  db: Pick<PrismaClient, 'node' | 'memory'>,
  ref: string,
  contextMemoryId: string,
): Promise<{ id: string }> {
  const parsed = parseUrnInput(ref);

  // A wrong-type URN prefix (e.g. `urn:memory:...`, `urn:org:...`)
  // is a coercion bug — fail loudly rather than silently lookup the
  // bare value.
  if (parsed.type !== 'unknown' && parsed.type !== 'node' && parsed.type !== 'loc') {
    throw new NodeNotFoundError(ref);
  }
  const normalized = parsed.value;

  // Form 1: bare ID.
  if (isId(normalized)) {
    const node = await db.node.findUnique({
      where: { id: normalized },
      select: { id: true, deletedAt: true },
    });
    if (!node || node.deletedAt) throw new NodeNotFoundError(ref);
    return { id: node.id };
  }

  // Form 2/3: full URN `<memory-urn>:<loc>`. Memory URNs are always
  // exactly two segments (`<orgUrn>:<memoryName>`) per the URN-format
  // convention, so a 3+-segment input may be a full-URN-prefixed loc.
  // We only treat it as such if the 2-segment prefix actually names a
  // live memory — otherwise we fall through to short-loc resolution
  // (which preserves locs that legitimately contain colons).
  const parts = normalized.split(':');
  if (parts.length >= 3) {
    const memoryUrn = parts.slice(0, 2).join(':');
    const memory = await db.memory.findUnique({
      where: { urn: memoryUrn },
      select: { id: true, deletedAt: true },
    });
    if (memory && !memory.deletedAt) {
      const loc = parts.slice(2).join(':');
      const node = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
        select: { id: true, deletedAt: true },
      });
      if (!node || node.deletedAt) throw new NodeNotFoundError(ref);
      return { id: node.id };
    }
  }

  // Form 4: short loc — resolve within the context memory.
  const node = await db.node.findUnique({
    where: { loc_memoryId: { loc: normalized, memoryId: contextMemoryId } },
    select: { id: true, deletedAt: true },
  });
  if (!node || node.deletedAt) throw new NodeNotFoundError(ref);
  return { id: node.id };
}
