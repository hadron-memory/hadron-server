import { GraphQLError } from 'graphql';
import { splitNodeUrn } from '@hadron-memory/urn-lib-js';
import type { Prisma } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { decryptNodeFields } from '../nodeCrypto.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { IncludeSyntaxError, parseIncludeTags, type IncludeTag } from './parseIncludeTags.js';

/** The `loc` of every derived include edge: one per (source, target). */
export const includeEdgeLoc = (sourceId: string, targetId: string) => `includes:${sourceId}:${targetId}`;

export interface IncludeWriteNode {
  /** Absent for a node being created (it cannot be reached by a cycle yet). */
  id?: string;
  memoryId: string;
  loc: string;
}

/** Memory ids the writing principal may read: `null` = unrestricted. */
export type ReadableMemoryIds = string[] | null;

/**
 * Prospective contents of same-memory nodes that a batch is about to write (git
 * sync): checked as if already written, so a new file cannot slip a cycle past a
 * check that only sees committed rows. Keyed by loc.
 */
export interface IncludeOverlay {
  memoryId: string;
  contents: Map<string, string | null>;
}

/** The id a not-yet-created node carries inside a batch check. */
export const prospectiveNodeId = (loc: string) => `new:${loc}`;

type Tx = Prisma.TransactionClient;

interface Resolved { id: string; memoryId: string; loc: string; content: string | null }

/** A tag's target node, or null when absent / unreadable (the two are indistinguishable by design). */
async function resolveTarget(
  tx: Tx, tag: IncludeTag, from: IncludeWriteNode, readable: ReadableMemoryIds, overlay?: IncludeOverlay,
): Promise<Resolved | null> {
  let memoryId = from.memoryId;
  let loc = tag.target;
  if (tag.kind === 'urn') {
    const parts = splitNodeUrn(tag.target);
    const mem = await tx.memory.findUnique({ where: { urn: parts.memoryUrn }, select: { id: true } });
    if (!mem) return null;
    memoryId = mem.id;
    loc = parts.loc;
  }
  if (readable !== null && !readable.includes(memoryId)) return null;
  const node = await tx.node.findFirst({
    where: { memoryId, loc, deletedAt: null },
    select: { id: true, memoryId: true, loc: true, content: true, memory: { select: { id: true, isEncrypted: true } } },
  });
  if (overlay && memoryId === overlay.memoryId && overlay.contents.has(loc)) {
    return { id: node?.id ?? prospectiveNodeId(loc), memoryId, loc, content: overlay.contents.get(loc) ?? null };
  }
  if (!node) return null;
  let content = node.content;
  if (node.memory.isEncrypted) {
    // No key, no walk: a ciphertext node cannot be followed, and is not an error.
    if (!sessionKeyCache.getByMemoryId(node.memory.id)) return null;
    content = decryptNodeFields({ content }, node.memory).content ?? null;
  }
  return { id: node.id, memoryId: node.memoryId, loc: node.loc, content };
}

export function includeRefusal(code: string, message: string, extra: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(message, { extensions: { code, ...extra } });
}

/**
 * Refuse content whose include tags are malformed or reach the writing node
 * again (a cycle). Depth is not a write refusal: a chain deeper than the read
 * cap saves and shows the broken-include notice at read (#2134, cor:dmo:150:06).
 * Run inside the writer's transaction on the PLAINTEXT content, before the node
 * row is written, so a refusal leaves nothing behind. The walk follows only
 * nodes the principal can read (`readable`); an unreadable or missing target
 * ends its branch silently, so a cycle through one cannot be learned from the
 * error. A node already walked on another branch is not re-walked (diamonds are
 * fine): everything it reaches was walked with it, and did not reach the writer.
 */
export async function assertIncludesWritable(
  tx: Tx, node: IncludeWriteNode, plaintextContent: string | null | undefined, readable: ReadableMemoryIds,
  overlay?: IncludeOverlay,
): Promise<IncludeTag[]> {
  if (!plaintextContent || !plaintextContent.includes('{{>')) return [];
  let tags: IncludeTag[];
  try {
    tags = parseIncludeTags(plaintextContent);
  } catch (e) {
    if (e instanceof IncludeSyntaxError) throw includeRefusal('INVALID_INCLUDE', e.message, { tag: e.raw });
    throw e;
  }
  // `visited` holds every node entered, so each is walked once and the walk
  // ends on any graph, including a cycle that does not pass through the writer.
  const visited = new Set<string>();
  const walk = async (from: IncludeWriteNode, fromTags: IncludeTag[]): Promise<void> => {
    for (const tag of fromTags) {
      const target = await resolveTarget(tx, tag, from, readable, overlay);
      if (!target) continue;
      if (node.id && target.id === node.id) {
        throw includeRefusal('INCLUDE_CYCLE', `Include ${tag.raw} would make this node include itself.`, { tag: tag.raw });
      }
      if (visited.has(target.id)) continue;
      visited.add(target.id);
      let nested: IncludeTag[] = [];
      try {
        nested = target.content ? parseIncludeTags(target.content) : [];
      } catch { /* a stored malformed tag is that node's problem, not this write's */ }
      await walk(target, nested);
    }
  };
  for (const tag of tags) {
    try {
      await walk(node, [tag]);
    } catch (e) {
      // A cycle found deep in the chain names the tag the writer authored, not
      // the tag inside some other node.
      if (e instanceof GraphQLError && e.extensions?.code === 'INCLUDE_CYCLE') {
        throw includeRefusal('INCLUDE_CYCLE', `Include ${tag.raw} would make this node include itself.`, { tag: tag.raw });
      }
      throw e;
    }
  }
  return tags;
}

/**
 * Replace the node's derived INCLUDE edges with exactly the targets its tags
 * name (one edge per distinct, live, readable target). Idempotent; only INCLUDE
 * rows are touched, so a client's own edges are never disturbed. The caller is
 * the node's content writer, inside its transaction.
 */
export async function syncDerivedIncludesEdges(
  tx: Tx, node: { id: string; memoryId: string; loc: string }, tags: IncludeTag[], readable: ReadableMemoryIds,
): Promise<void> {
  const wanted = new Map<string, string>();
  for (const tag of tags) {
    const target = await resolveTarget(tx, tag, node, readable);
    if (target && target.id !== node.id) wanted.set(target.id, includeEdgeLoc(node.id, target.id));
  }
  const existing = await tx.edge.findMany({
    where: { sourceId: node.id, governedKind: 'INCLUDE' },
    select: { id: true, targetId: true },
  });
  const stale = existing.filter(e => !wanted.has(e.targetId)).map(e => e.id);
  if (stale.length) await tx.edge.deleteMany({ where: { id: { in: stale } } });
  const have = new Set(existing.map(e => e.targetId));
  for (const [targetId, loc] of wanted) {
    if (have.has(targetId)) continue;
    await tx.edge.create({
      data: { id: generateId(), memoryId: node.memoryId, sourceId: node.id, targetId, loc, name: 'includes', governedKind: 'INCLUDE' },
    });
  }
}

/** The text an MCP tool returns for an include refusal, or null for any other error. */
export function includeRefusalText(e: unknown): string | null {
  if (!(e instanceof GraphQLError)) return null;
  const code = e.extensions?.code;
  if (code !== 'INVALID_INCLUDE' && code !== 'INCLUDE_CYCLE') return null;
  const tag = typeof e.extensions?.tag === 'string' ? ` Tag: ${e.extensions.tag}` : '';
  return `[${String(code).toLowerCase()}] ${e.message}${tag}`;
}

/** Tags of content already stored: a malformed one yields no edges rather than failing the caller. */
export function storedIncludeTags(content: string | null | undefined): IncludeTag[] {
  try {
    return content ? parseIncludeTags(content) : [];
  } catch {
    return [];
  }
}

/**
 * Re-derive a stored node's INCLUDE edges from its own content, for the paths
 * that copy or move already-valid content (clone, extract, merge): no refusal,
 * the content was valid where it came from. Encrypted memories re-derive only
 * while their key is cached; otherwise the edges wait for the next content write.
 */
export async function resyncDerivedIncludesForNodes(tx: Tx, nodeIds: string[]): Promise<void> {
  if (nodeIds.length === 0) return;
  const nodes = await tx.node.findMany({
    where: { id: { in: nodeIds }, deletedAt: null },
    select: { id: true, memoryId: true, loc: true, content: true, memory: { select: { id: true, isEncrypted: true } } },
  });
  for (const node of nodes) {
    let content = node.content;
    if (node.memory.isEncrypted) {
      if (!sessionKeyCache.getByMemoryId(node.memory.id)) continue;
      content = decryptNodeFields({ content }, node.memory).content ?? null;
    }
    // No principal is present on a copy / move / merge: derive same-memory targets only,
    // so a tag can never create an edge (existence, id) into a memory nobody checked.
    await syncDerivedIncludesEdges(tx, node, storedIncludeTags(content), [node.memoryId]);
  }
}
