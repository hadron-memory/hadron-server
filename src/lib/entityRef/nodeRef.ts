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
  // An explicit `urn:node:` prefix declares "this is a full node URN".
  // We resolve it strictly: the body must have the `<memory-urn>:<loc>`
  // shape and the named memory must be live. We never silently fall
  // through to short-loc resolution within `contextMemoryId`, because
  // that could mis-resolve to a same-shaped loc in the context memory
  // when the caller's intent was unambiguously the named memory.
  const strictUrnNode = parsed.type === 'node';

  // Form 1: bare ID.
  if (isId(normalized)) {
    if (strictUrnNode) {
      // `urn:node:<id>` is not a defined shape — node URNs are always
      // `<memory-urn>:<loc>`. Reject rather than silently accepting.
      throw new NodeNotFoundError(ref);
    }
    const node = await db.node.findUnique({
      where: { id: normalized },
      select: { id: true, deletedAt: true },
    });
    if (!node || node.deletedAt) throw new NodeNotFoundError(ref);
    return { id: node.id };
  }

  // Form 2/3: full URN `<memory-urn>:<loc>`. Memory URNs are always
  // exactly two segments (`<orgUrn>:<memoryName>`) per the URN-format
  // convention, so a 3+-segment input MAY be a full-URN-prefixed loc.
  // For explicit `urn:node:` inputs we require this shape; for
  // unprefixed inputs we treat it as such only if the 2-segment prefix
  // actually names a live memory (otherwise fall through to short-loc
  // resolution, which preserves short locs that legitimately contain
  // colons).
  const parts = normalized.split(':');
  if (parts.length >= 3) {
    const memoryUrn = parts.slice(0, 2).join(':');
    const memory = await db.memory.findUnique({
      where: { urn: memoryUrn },
      select: { id: true, deletedAt: true },
    });
    if (memory) {
      // The 2-segment prefix names a memory row. Treat the body as
      // `<memory-urn>:<loc>` and resolve strictly — soft-deleted
      // memories produce a clean miss rather than a fall-through that
      // could resolve to the wrong node in `contextMemoryId`.
      if (memory.deletedAt) throw new NodeNotFoundError(ref);
      const loc = parts.slice(2).join(':');
      const node = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
        select: { id: true, deletedAt: true },
      });
      if (!node || node.deletedAt) throw new NodeNotFoundError(ref);
      return { id: node.id };
    }
    if (strictUrnNode) {
      // Explicit `urn:node:` with no live memory at the named prefix
      // — reject without falling back to short-loc.
      throw new NodeNotFoundError(ref);
    }
  } else if (strictUrnNode) {
    // Explicit `urn:node:` with fewer than 3 segments is malformed.
    throw new NodeNotFoundError(ref);
  }

  // Form 4: short loc — resolve within the context memory. Reached
  // only for unprefixed inputs whose 2-segment prefix doesn't name a
  // live memory.
  const node = await db.node.findUnique({
    where: { loc_memoryId: { loc: normalized, memoryId: contextMemoryId } },
    select: { id: true, deletedAt: true },
  });
  if (!node || node.deletedAt) throw new NodeNotFoundError(ref);
  return { id: node.id };
}
