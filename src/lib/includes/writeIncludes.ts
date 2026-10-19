import { GraphQLError } from 'graphql';
import { splitNodeUrn } from '@hadron-memory/urn-lib-js';
import type { Prisma } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { decryptNodeFields } from '../nodeCrypto.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { IncludeSyntaxError, parseIncludeTags, type IncludeTag } from './parseIncludeTags.js';

/** Deepest include chain a write accepts (#2040). */
export const MAX_INCLUDE_DEPTH = 10;

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

/**
 * Does the tag's target exist, live, in a memory the writer may read? Existence
 * and read access only: an encrypted target the writer may read counts without
 * a session key, because the question is access, not decryption (cor:dmo:150:04).
 * A batch overlay counts as existing: a file written in the same batch is there.
 */
async function targetIsReadable(
  tx: Tx, tag: IncludeTag, from: IncludeWriteNode, readable: ReadableMemoryIds, overlay?: IncludeOverlay,
): Promise<boolean> {
  let memoryId = from.memoryId;
  let loc = tag.target;
  if (tag.kind === 'urn') {
    let parts: ReturnType<typeof splitNodeUrn>;
    try { parts = splitNodeUrn(tag.target); } catch { return false; }
    const mem = await tx.memory.findUnique({ where: { urn: parts.memoryUrn }, select: { id: true } });
    if (!mem) return false;
    memoryId = mem.id;
    loc = parts.loc;
  }
  if (readable !== null && !readable.includes(memoryId)) return false;
  if (overlay && memoryId === overlay.memoryId && overlay.contents.has(loc)) return true;
  return (await tx.node.count({ where: { memoryId, loc, deletedAt: null } })) > 0;
}

export function includeRefusal(code: string, message: string, extra: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(message, { extensions: { code, ...extra } });
}

/**
 * Refuse content whose include tags are malformed, nest deeper than
 * `MAX_INCLUDE_DEPTH`, or reach the writing node again (a cycle). Run inside
 * the writer's transaction on the PLAINTEXT content, before the node row is
 * written, so a refusal leaves nothing behind. The walk follows only nodes
 * the principal can read (`readable`); an unreadable or missing target ends
 * its branch silently, so a cycle through one cannot be learned from the error.
 * A node already seen on another branch is not re-walked (diamonds are fine).
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
  // cor:dmo:150:04: a writer can't include what they can't read. One error for
  // a target that doesn't exist, was deleted or isn't readable, naming only the
  // tag the writer typed, so the refusal reveals nothing about the target.
  for (const tag of tags) {
    if (!(await targetIsReadable(tx, tag, node, readable, overlay))) {
      throw includeRefusal('INCLUDE_TARGET_UNAVAILABLE', `Include ${tag.raw} can't be used: the target doesn't exist or you can't read it.`, { tag: tag.raw });
    }
  }
  // Longest chain below a node (0 for a leaf), memoized so a node reached first
  // by a shallow branch cannot hide a deeper one: acceptance never depends on
  // tag order. `onPath` stops a cycle that does not pass through the writing node.
  const height = new Map<string, number>();
  const onPath = new Set<string>();
  const levelsBelow = async (from: IncludeWriteNode, fromTags: IncludeTag[], level: number): Promise<number> => {
    let deepest = 0;
    for (const tag of fromTags) {
      const target = await resolveTarget(tx, tag, from, readable, overlay);
      if (!target) continue;
      if (node.id && target.id === node.id) {
        throw includeRefusal('INCLUDE_CYCLE', `Include ${tag.raw} would make this node include itself.`, { tag: tag.raw });
      }
      if (onPath.has(target.id)) continue;
      let h = height.get(target.id);
      if (h === undefined) {
        let nested: IncludeTag[] = [];
        try {
          nested = target.content ? parseIncludeTags(target.content) : [];
        } catch { /* a stored malformed tag is that node's problem, not this write's */ }
        onPath.add(target.id);
        try {
          h = await levelsBelow(target, nested, level + 1);
        } catch (e) {
          // A depth refusal found deep in the chain names the tag the writer
          // authored, not the tag inside some other node.
          if (level === 1 && e instanceof GraphQLError && e.extensions?.code === 'INCLUDE_TOO_DEEP') {
            throw includeRefusal('INCLUDE_TOO_DEEP', `Includes nest deeper than ${MAX_INCLUDE_DEPTH}.`, { tag: tag.raw });
          }
          throw e;
        } finally {
          onPath.delete(target.id);
        }
        height.set(target.id, h);
      }
      if (level + h > MAX_INCLUDE_DEPTH) {
        throw includeRefusal('INCLUDE_TOO_DEEP', `Includes nest deeper than ${MAX_INCLUDE_DEPTH}.`, { tag: tag.raw });
      }
      deepest = Math.max(deepest, 1 + h);
    }
    return deepest;
  };
  await levelsBelow(node, tags, 1);
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
  if (code !== 'INVALID_INCLUDE' && code !== 'INCLUDE_CYCLE' && code !== 'INCLUDE_TOO_DEEP' && code !== 'INCLUDE_TARGET_UNAVAILABLE') return null;
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
