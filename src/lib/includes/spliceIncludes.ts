import { splitNodeUrn } from '@hadron-memory/urn-lib-js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { decryptNodeFields } from '../nodeCrypto.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { revisionApprovalOf, newestApprovedRevisionOf } from '../nodeApproval.js';
import { locateIncludeTags, IncludeSyntaxError, type IncludeTag } from './parseIncludeTags.js';

/** Deepest include chain a read follows; past it a reader sees the notice (cor:dmo:150:06). Writes don't enforce it (#2134). */
export const MAX_RESOLVE_DEPTH = 10;

/**
 * What a reader sees where an include can't be resolved (cor:dmo:150:05). One
 * string for every cause, so it never says whether a target the reader can't see exists.
 */
export const BROKEN_INCLUDE_NOTICE = '[Include unavailable]';

/** Node types whose body is a literal record, never a template: an include-shaped string in one is text (#2041). */
export const INCLUDE_LITERAL_NODE_TYPES: ReadonlySet<string> = new Set(['chat-message', 'record']);

/** `content` is the live row's decrypted text; `memory` is kept so a past revision can be decrypted with the same authorized context. */
interface Target { id: string; memoryId: string; content: string | null; revSeq: number; memory: { id: string; isEncrypted: boolean } }

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

/**
 * Decrypt one sealed field with the memory's cached key. A failure (a key that
 * no longer fits, a damaged envelope) is the same "can't resolve" as a missing
 * key: `undefined`, rendered as the notice, never an error that fails the read.
 */
function openSealed(content: string | null, memory: { id: string; isEncrypted: boolean }): string | null | undefined {
  try {
    return decryptNodeFields({ content }, memory).content ?? null;
  } catch {
    return undefined;
  }
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
        select: { id: true, memoryId: true, content: true, revSeq: true, memory: { select: { id: true, isEncrypted: true } } },
      });
      if (!node) return null;
      const memory = { id: node.memoryId, isEncrypted: node.memory?.isEncrypted === true };
      const base = { id: node.id, memoryId: node.memoryId, revSeq: node.revSeq, memory };
      if (!memory.isEncrypted) return { ...base, content: node.content };
      if (!sessionKeyCache.getByMemoryId(memory.id)) return null;
      const text = openSealed(node.content, memory);
      return text === undefined ? null : { ...base, content: text };
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
      if (!rev) {
        // The live row is revision `revSeq` and may have no snapshot yet (the same rule revisionApprovalOf uses).
        return revNo === target.revSeq ? target.content : null;
      }
      // A snapshot captured while the node lived in another memory is not this reader's to see.
      if (rev.memoryId != null && rev.memoryId !== target.memoryId) return null;
      // Same memory, so the same authorized key: a sealed snapshot is read as plaintext, never as its envelope.
      if (target.memory.isEncrypted) {
        if (!sessionKeyCache.getByMemoryId(target.memory.id)) return null;
        return openSealed(rev.content, target.memory) ?? null;
      }
      return rev.content ?? null;
    })();
    memo.revisionByKey.set(key, hit);
  }
  return hit;
}

/**
 * The text of the revision an `approved` include qualifies for, or null (the notice). `rev=N approved` asks the
 * shared predicate about N; an unpinned one asks `newestApprovedRevisionOf` which revision to try. Either way the
 * text served is the content the predicate's own verdict hashed (`served`), checked again for the chosen number, so
 * a snapshot deleted, altered or replaced after selection can only fail closed: no second read of the revision, no
 * fall back to the live row or to another revision. A search that hit its cap and an exhausted one both end here as
 * null; neither is evidence about approval. A snapshot captured in another memory is not this target's to serve, and
 * an encrypted memory is NOT_APPLICABLE.
 */
async function approvedText(db: Db, target: Target, pinned: number | undefined): Promise<string | null> {
  const revNo = pinned ?? (await newestApprovedRevisionOf(db, target.id)).found?.revNo;
  if (revNo === undefined) return null;
  const verdict = await revisionApprovalOf(db, target.id, revNo);
  if (verdict.state !== 'APPROVED' || !verdict.served) return null;
  if (verdict.served.memoryId !== target.memoryId) return null;
  return verdict.served.content ?? '';
}

async function expandTag(
  db: Db, access: Record<string, unknown>, memo: IncludeReadMemo, opts: SpliceOptions,
  tag: IncludeTag, includerMemoryId: string, trail: ReadonlySet<string>, level: number,
): Promise<string> {
  // `signed` is stored and ignored until the signing ceremony ships (cor:dmo:150:02,
  // Vera's D7): it serves as if absent, and `approved signed` as `approved`.
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
  let stored: string | null;
  if (tag.settings.approved) {
    stored = await approvedText(db, target, tag.settings.rev);
    if (stored === null) return BROKEN_INCLUDE_NOTICE;
  } else {
    stored = tag.settings.rev !== undefined
      ? await lookupRevision(db, memo, target, tag.settings.rev)
      : target.content;
  }
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
