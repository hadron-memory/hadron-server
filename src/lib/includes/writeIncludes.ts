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

type Tx = Prisma.TransactionClient;

interface Resolved { id: string; memoryId: string; loc: string; content: string | null }

/** A tag's target node, or null when absent / unreadable (the two are indistinguishable by design). */
async function resolveTarget(
  tx: Tx, tag: IncludeTag, from: IncludeWriteNode, readable: ReadableMemoryIds,
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
): Promise<IncludeTag[]> {
  if (!plaintextContent || !plaintextContent.includes('{{>')) return [];
  let tags: IncludeTag[];
  try {
    tags = parseIncludeTags(plaintextContent);
  } catch (e) {
    if (e instanceof IncludeSyntaxError) throw includeRefusal('INVALID_INCLUDE', e.message, { tag: e.raw });
    throw e;
  }
  const seen = new Set<string>();
  const walk = async (from: IncludeWriteNode, fromTags: IncludeTag[], depth: number): Promise<void> => {
    for (const tag of fromTags) {
      const target = await resolveTarget(tx, tag, from, readable);
      if (!target) continue;
      if (node.id && target.id === node.id) {
        throw includeRefusal('INCLUDE_CYCLE', `Include ${tag.raw} would make this node include itself.`, { tag: tag.raw });
      }
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      if (depth + 1 > MAX_INCLUDE_DEPTH) {
        throw includeRefusal('INCLUDE_TOO_DEEP', `Includes nest deeper than ${MAX_INCLUDE_DEPTH}.`, { tag: tag.raw });
      }
      let nested: IncludeTag[] = [];
      try {
        nested = target.content ? parseIncludeTags(target.content) : [];
      } catch { /* a stored malformed tag is that node's problem, not this write's */ }
      await walk(target, nested, depth + 1);
    }
  };
  await walk(node, tags, 0);
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
