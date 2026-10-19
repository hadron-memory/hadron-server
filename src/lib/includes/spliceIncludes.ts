import { splitNodeUrn } from '@hadron-memory/urn-lib-js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { decryptNodeFields } from '../nodeCrypto.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { locateIncludeTags, IncludeSyntaxError, type IncludeTag } from './parseIncludeTags.js';

/** Deepest include chain a read follows: the same cap a write enforces (#2040). */
export const MAX_RESOLVE_DEPTH = 10;

/**
 * What a reader sees where an include can't be resolved (cor:dmo:150:05). One
 * string for every cause, so it never says whether a target the reader can't see exists.
 */
export const BROKEN_INCLUDE_NOTICE = '[Include unavailable]';

/** Node types whose body is a literal record, never a template: an include-shaped string in one is text (#2041). */
export const INCLUDE_LITERAL_NODE_TYPES: ReadonlySet<string> = new Set(['chat-message', 'record']);

interface Target { id: string; memoryId: string; content: string | null }

/**
 * Per-request lookups, and nothing else. It holds a reader's authorized
 * lookups and stored bytes — never a rendered result, because rendering
 * depends on the traversal (ancestors, depth) that reached a node. A memo
 * belongs to one request's principal; it is never shared across callers.
 */
export class IncludeReadMemo {
  readonly memoryByUrn = new Map<string, Promise<string | null>>();
  readonly targetByAddress = new Map<string, Promise<Target | null>>();
  readonly revisionByKey = new Map<string, Promise<string | null>>();
}

export interface SpliceOptions {
  /**
   * Allow a URN tag to name a memory other than the includer's. Only a caller
   * whose `access` is the reader's real read filter may set it: `{}` means
   * "unrestricted", and must not turn a foreign URN into a read.
   */
  foreign?: boolean;
  memo?: IncludeReadMemo;
}

type Db = Pick<PrismaClient, 'node' | 'memory' | 'nodeRevision'>;

async function memoryIdOfUrn(db: Db, memo: IncludeReadMemo, urn: string): Promise<string | null> {
  let hit = memo.memoryByUrn.get(urn);
  if (!hit) {
    hit = db.memory.findUnique({ where: { urn }, select: { id: true } }).then(m => m?.id ?? null);
    memo.memoryByUrn.set(urn, hit);
  }
  return hit;
}

/** The stored text of a node the reader may read, or null for missing, deleted, unreadable and keyless-encrypted alike. */
async function lookupTarget(
  db: Db, access: Record<string, unknown>, memo: IncludeReadMemo, memoryId: string, loc: string,
): Promise<Target | null> {
  const key = `${memoryId}\u0000${loc}`;
  let hit = memo.targetByAddress.get(key);
  if (!hit) {
    hit = (async () => {
      const node = await db.node.findFirst({
        where: { memoryId, loc, deletedAt: null, AND: [access] },
        select: { id: true, memoryId: true, content: true, memory: { select: { id: true, isEncrypted: true } } },
      });
      if (!node) return null;
      if (!node.memory?.isEncrypted) return { id: node.id, memoryId: node.memoryId, content: node.content };
      if (!sessionKeyCache.getByMemoryId(node.memory.id)) return null;
      return { id: node.id, memoryId: node.memoryId, content: decryptNodeFields({ content: node.content }, node.memory).content ?? null };
    })();
    memo.targetByAddress.set(key, hit);
  }
  return hit;
}

/** The stored text of one past revision of `target`, or null. History is never resolved against today's targets. */
async function lookupRevision(db: Db, memo: IncludeReadMemo, target: Target, revNo: number): Promise<string | null> {
  const key = `${target.id}\u0000${revNo}`;
  let hit = memo.revisionByKey.get(key);
  if (!hit) {
    hit = (async () => {
      const rev = await db.nodeRevision.findFirst({
        where: { nodeId: target.id, revNo },
        select: { memoryId: true, content: true },
      });
      // A snapshot captured while the node lived in another memory is not this reader's to see.
      if (!rev || (rev.memoryId != null && rev.memoryId !== target.memoryId)) return null;
      return rev.content ?? null;
    })();
    memo.revisionByKey.set(key, hit);
  }
  return hit;
}

async function expandTag(
  db: Db, access: Record<string, unknown>, memo: IncludeReadMemo, opts: SpliceOptions,
  tag: IncludeTag, includerMemoryId: string, trail: ReadonlySet<string>, level: number,
): Promise<string> {
  // S3 (#1838) owns "approved" and "signed" qualification: until it lands, no revision qualifies.
  if (tag.settings.approved || tag.settings.signed) return BROKEN_INCLUDE_NOTICE;
  if (level > MAX_RESOLVE_DEPTH) return BROKEN_INCLUDE_NOTICE;
  let memoryId = includerMemoryId;
  let loc = tag.target;
  if (tag.kind === 'urn') {
    let parts: { memoryUrn: string; loc: string };
    try { parts = splitNodeUrn(tag.target); } catch { return BROKEN_INCLUDE_NOTICE; }
    const id = await memoryIdOfUrn(db, memo, parts.memoryUrn);
    if (!id || (id !== includerMemoryId && !opts.foreign)) return BROKEN_INCLUDE_NOTICE;
    memoryId = id;
    loc = parts.loc;
  }
  const target = await lookupTarget(db, access, memo, memoryId, loc);
  if (!target || trail.has(target.id)) return BROKEN_INCLUDE_NOTICE;
  const stored = tag.settings.rev !== undefined
    ? await lookupRevision(db, memo, target, tag.settings.rev)
    : target.content;
  if (stored == null) return tag.settings.rev !== undefined ? BROKEN_INCLUDE_NOTICE : '';
  // Rendered per traversal: this node's ancestors and depth travel with it.
  return spliceWithin(db, access, memo, opts, stored, target.memoryId, new Set([...trail, target.id]), level + 1);
}

async function spliceWithin(
  db: Db, access: Record<string, unknown>, memo: IncludeReadMemo, opts: SpliceOptions,
  content: string, memoryId: string, trail: ReadonlySet<string>, level: number,
): Promise<string> {
  if (!content.includes('{{>')) return content;
  let tags: Array<IncludeTag & { index: number }>;
  try {
    tags = locateIncludeTags(content);
  } catch (e) {
    if (e instanceof IncludeSyntaxError) return content; // a stored malformed tag renders as it always did
    throw e;
  }
  let out = '';
  let cursor = 0;
  for (const tag of tags) {
    out += content.slice(cursor, tag.index);
    out += await expandTag(db, access, memo, opts, tag, memoryId, trail, level);
    cursor = tag.index + tag.raw.length;
  }
  return out + content.slice(cursor);
}

/**
 * Replace every include tag in `content` with the target's stored text, read
 * with `access` (the reader's own filter, cor:dmo:150:04) and nested up to
 * `MAX_RESOLVE_DEPTH`. A target that is missing, deleted, unreadable,
 * undecryptable, on the way back to an ancestor, or past the cap becomes
 * `BROKEN_INCLUDE_NOTICE`, and the rest of the text still resolves. Writes nothing.
 * `nodeId` is the includer, so a cycle through it is caught at its first repeat.
 */
export function spliceIncludes(
  db: Db, access: Record<string, unknown>, content: string, includer: { id?: string; memoryId: string },
  opts: SpliceOptions = {},
): Promise<string> {
  return spliceWithin(
    db, access, opts.memo ?? new IncludeReadMemo(), opts, content, includer.memoryId,
    new Set(includer.id ? [includer.id] : []), 1,
  );
}
