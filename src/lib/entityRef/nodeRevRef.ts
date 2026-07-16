/**
 * resolveNodeRevRef — convert an entity-reference string to a definite
 * NodeRevision ID (#696). A revision is addressable two ways:
 *   - a bare NodeRevision id (the `NodeRevision.id` cuid), or
 *   - an END-ANCHORED grammar-v2 URN
 *     `hrn:noderev:<root>:<mem>:<loc...>:<rev>` where the last atom is the
 *     revision id (`r<N>`), the first post-root atom is the memory, and
 *     everything between is the (variable-length, opaque) node loc.
 *
 * NodeRevision has no `urn` column — the URN is computed. The URN path
 * decomposes the end-anchored shape (via `parseNodeRevUrnV2`), reconstructs the
 * owning node's URN from `<root>::<mem>::<loc>`, resolves it to a node id, and
 * looks the revision up by `(nodeId, revNo)`. A malformed URN and an absent
 * revision are indistinguishable (no existence oracle).
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { isId as isIdFunc } from './shape.js';
import { parseNodeRevUrnV2, composeNodeRevUrnV2, normalizeUrnForLookup } from '../urn.js';
import { NodeRevisionNotFoundError, NodeNotFoundError } from './errors.js';
import { resolveNodeRef } from './nodeRef.js';

/**
 * Parse the `r<N>` revision terminal into its positive integer revision number,
 * or null when it isn't the canonical `r<N>` form.
 */
export function parseRevNo(rev: string): number | null {
  const m = /^r(\d+)$/.exec(rev);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Render a per-node revision number as the URN terminal atom (`r<N>`). */
export function formatRevNo(revNo: number): string {
  return `r${revNo}`;
}

/**
 * Compose the canonical `hrn:noderev:<root>:<mem>:<loc...>:<rev>` URN from the
 * revision's captured memory URN, node loc, and revision number. The memory URN
 * is flattened and split into its root (first atom) and memory slug. Throws if
 * the memory slug isn't a single atom (a multi-segment per-user memory) —
 * callers render such rows without a URN.
 */
export function composeNodeRevUrn(memUrn: string, loc: string, revNo: number): string {
  const flat = normalizeUrnForLookup(memUrn); // strip scheme prefix, `::` → `:`
  const firstColon = flat.indexOf(':');
  const root = firstColon === -1 ? flat : flat.slice(0, firstColon);
  const memSlug = firstColon === -1 ? '' : flat.slice(firstColon + 1);
  return composeNodeRevUrnV2(root, memSlug, loc, formatRevNo(revNo));
}

export async function resolveNodeRevRef(
  db: Pick<PrismaClient, 'nodeRevision' | 'node' | 'memory'>,
  ref: string,
): Promise<{ id: string }> {
  if (isIdFunc(ref)) {
    const rev = await db.nodeRevision.findUnique({ where: { id: ref }, select: { id: true } });
    if (!rev) throw new NodeRevisionNotFoundError(ref);
    return { id: rev.id };
  }

  let root: string;
  let memory: string;
  let loc: string;
  let revNo: number;
  try {
    const p = parseNodeRevUrnV2(ref);
    root = p.root;
    memory = p.memory;
    loc = p.loc;
    const n = parseRevNo(p.rev);
    if (n === null) throw new NodeRevisionNotFoundError(ref);
    revNo = n;
  } catch (err) {
    if (err instanceof NodeRevisionNotFoundError) throw err;
    throw new NodeRevisionNotFoundError(ref);
  }

  let nodeId: string;
  try {
    ({ id: nodeId } = await resolveNodeRef(db, `hrn:node:${root}::${memory}::${loc}`));
  } catch (err) {
    if (err instanceof NodeNotFoundError) throw new NodeRevisionNotFoundError(ref);
    throw err;
  }

  const rev = await db.nodeRevision.findFirst({ where: { nodeId, revNo }, select: { id: true } });
  if (!rev) throw new NodeRevisionNotFoundError(ref);
  return { id: rev.id };
}
