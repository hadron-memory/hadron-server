import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { includeUrnTarget } from './includeUrnTarget.js';
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
  let targetId: string | undefined;
  if (tag.kind === 'urn') {
    const target = await includeUrnTarget(tx, tag.target);
    if (!target) return null;
    memoryId = target.memoryId;
    loc = target.loc;
    targetId = target.id;
  }
  if (readable !== null && !readable.includes(memoryId)) return null;
  const node = await tx.node.findFirst({
    where: { ...(targetId ? { id: targetId } : { loc }), memoryId, deletedAt: null, memory: { deletedAt: null } },
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
 * How a writer's include tags are judged (#2041 S2b). `storedPlaintext` is the
 * includer's plaintext from the row the writer locked and revalidated in its
 * own transaction, read before its update; absent for a create or a resurrected
 * tombstone. `includeSystemWrite` is for git sync and the root-node seam only,
 * which have no writing person: they keep the syntax and cycle checks and skip
 * the read check (cor:dmo:150:04 applies to GraphQL, the CLI, the portal and MCP).
 */
export interface IncludeWriteOptions {
  storedPlaintext?: string | null;
  includeSystemWrite?: true;
}

/**
 * A tag's identity for "added or changed": kind, target and settings, never its
 * spelling. `rev` is keyed as a string: JSON would write a rev too large for a
 * number (Infinity) as null, the same as no rev (Gene, #2226).
 */
export function includeTagKey(tag: IncludeTag): string {
  const { rev, approved, signed } = tag.settings;
  return JSON.stringify([tag.kind, tag.target, rev === undefined ? null : String(rev), approved === true, signed === true]);
}

/** Keys of the tags in the stored text; text that no longer parses has none, so every tag is checked. */
function storedIncludeKeys(storedPlaintext: string | null | undefined): Set<string> {
  return new Set(storedIncludeTags(storedPlaintext).map(includeTagKey));
}

/**
 * Does the tag's target exist, live, in a memory the writer may read? Access
 * only, never decryption: an encrypted target the writer may read counts with
 * no session key (cor:dmo:150:04). A same-batch overlay file counts as existing.
 */
async function targetIsReadable(
  tx: Tx, tag: IncludeTag, from: IncludeWriteNode, readable: ReadableMemoryIds, overlay?: IncludeOverlay,
): Promise<boolean> {
  const id = await targetIdOf(tx, tag, from, readable);
  if (id) return true;
  if (!overlay) return false;
  const loc = tag.kind === 'loc' ? tag.target : null;
  return loc !== null && from.memoryId === overlay.memoryId && overlay.contents.has(loc);
}

/** The id of a tag's live target in a memory `readable` admits, without reading its content. */
async function targetIdOf(
  tx: Tx, tag: IncludeTag, from: { memoryId: string }, readable: ReadableMemoryIds,
): Promise<string | null> {
  let memoryId = from.memoryId;
  let loc = tag.target;
  let targetId: string | undefined;
  if (tag.kind === 'urn') {
    const target = await includeUrnTarget(tx, tag.target);
    if (!target) return null;
    memoryId = target.memoryId;
    loc = target.loc;
    targetId = target.id;
  }
  if (readable !== null && !readable.includes(memoryId)) return null;
  const node = await tx.node.findFirst({ where: { ...(targetId ? { id: targetId } : { loc }), memoryId, deletedAt: null, memory: { deletedAt: null } }, select: { id: true } });
  return node?.id ?? null;
}

/**
 * Refuse content whose include tags are malformed, name a target the writer
 * can't read, or reach the writing node again (a cycle). Only tags the write
 * ADDS or CHANGES against `opts.storedPlaintext` are checked for access and
 * start the cycle walk (R110): a tag already stored is not re-checked, and a
 * cycle that formed later through one is a broken include at read, not a
 * refusal of an unrelated save. Depth is not a write refusal: a chain deeper
 * than the read cap saves and shows the notice at read (#2134, cor:dmo:150:06).
 * Run inside the writer's transaction on the PLAINTEXT content, so a refusal
 * leaves nothing behind. A missing, deleted or unreadable target gets one
 * error naming only the authored tag (cor:dmo:150:05). The walk follows only
 * nodes the principal can read; an unreadable or missing target ends its
 * branch silently, so a cycle through one cannot be learned from the error. A
 * node already walked is not re-walked (diamonds are fine): everything it
 * reaches was walked with it, and did not reach the writer.
 */
export async function assertIncludesWritable(
  tx: Tx, node: IncludeWriteNode, plaintextContent: string | null | undefined, readable: ReadableMemoryIds,
  overlay?: IncludeOverlay, opts: IncludeWriteOptions = {},
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
  const stored = storedIncludeKeys(opts.storedPlaintext);
  const touched = tags.filter(tag => !stored.has(includeTagKey(tag)));
  if (!opts.includeSystemWrite) {
    for (const tag of touched) {
      if (!(await targetIsReadable(tx, tag, node, readable, overlay))) {
        throw includeRefusal('INCLUDE_TARGET_UNAVAILABLE',
          `Include ${tag.raw} can't be used: the target doesn't exist or you can't read it.`, { tag: tag.raw });
      }
    }
  }
  for (const tag of touched) {
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
 * name (one edge per distinct, live, readable target). A tag already in
 * `opts.storedPlaintext` keeps its existing edge even when the writer can no
 * longer read its target (R110); no edge is ever created to a target the
 * writer can't read. Idempotent; only INCLUDE rows are touched, so a client's
 * own edges are never disturbed. The caller is the node's content writer,
 * inside its transaction.
 */
export async function syncDerivedIncludesEdges(
  tx: Tx, node: { id: string; memoryId: string; loc: string }, tags: IncludeTag[], readable: ReadableMemoryIds,
  opts: Pick<IncludeWriteOptions, 'storedPlaintext'> = {},
): Promise<void> {
  const wanted = new Map<string, string>();
  const kept = new Set<string>();
  const stored = storedIncludeKeys(opts.storedPlaintext);
  for (const tag of tags) {
    const target = await resolveTarget(tx, tag, node, readable);
    if (target && target.id !== node.id) {
      wanted.set(target.id, includeEdgeLoc(node.id, target.id));
    } else if (!target && stored.has(includeTagKey(tag))) {
      const id = await targetIdOf(tx, tag, node, null);
      if (id) kept.add(id);
    }
  }
  const existing = await tx.edge.findMany({
    where: { sourceId: node.id, governedKind: 'INCLUDE' },
    select: { id: true, targetId: true },
  });
  const stale = existing.filter(e => !wanted.has(e.targetId) && !kept.has(e.targetId)).map(e => e.id);
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
  if (code !== 'INVALID_INCLUDE' && code !== 'INCLUDE_CYCLE' && code !== 'INCLUDE_TARGET_UNAVAILABLE') return null;
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
/**
 * #2167 — a copy (clone, extract) is an includer write: every tag in every
 * copied node counts as added, so each is checked for the copier's read access
 * and as a cycle root against where it landed (cor:dmo:150:04, :06). Run on the
 * inserted rows inside the copy's transaction, after any content rewrite, so a
 * refusal rolls the whole copy back. The copier owns the destination it is
 * creating, so the destination joins `readable`. Copies are plaintext: both
 * copy paths refuse an encrypted source.
 */
export async function assertCopiedIncludesWritable(
  tx: Tx, nodeIds: string[], destinationMemoryId: string, readable: ReadableMemoryIds,
): Promise<void> {
  if (nodeIds.length === 0) return;
  const withDestination = readable === null ? null : [...readable, destinationMemoryId];
  const nodes = await tx.node.findMany({
    where: { id: { in: nodeIds }, deletedAt: null },
    select: { id: true, memoryId: true, loc: true, content: true },
    orderBy: { loc: 'asc' },
  });
  for (const node of nodes) await assertIncludesWritable(tx, node, node.content, withDestination);
}

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
