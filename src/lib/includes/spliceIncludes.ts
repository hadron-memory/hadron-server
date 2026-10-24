import { includeUrnTarget } from './includeUrnTarget.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { decryptNodeFields } from '../nodeCrypto.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { revisionApprovalOf, newestApprovedRevisionOf } from '../nodeApproval.js';
import { locateIncludeTags, locateLiteralIncludeTags, IncludeSyntaxError, type IncludeTag } from './parseIncludeTags.js';
import { LiteralGuardCollision } from './literalGuard.js';

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
export interface IncludeTarget { id: string; memoryId: string; content: string | null; revSeq: number; memory: { id: string; isEncrypted: boolean } }
type Target = IncludeTarget;

/**
 * Per-request lookups, and nothing else. It holds a reader's authorized
 * lookups and stored bytes — never a rendered result, because rendering
 * depends on the traversal (ancestors, depth) that reached a node. A memo
 * belongs to one request's principal; it is never shared across callers.
 */
export class IncludeReadMemo {
  readonly targetIdentityByUrn = new Map<string, ReturnType<typeof includeUrnTarget>>();
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
  /**
   * #2135 — when set, the `{{>` of every include tag written as code is replaced by this guard in the
   * spliced text, so a later Mustache render cannot treat it as a partial; the caller restores it. Each
   * source text is judged on its own, before assembly. Unset leaves literal tags as written.
   */
  literalGuard?: string;
}

export type IncludeDb = Pick<PrismaClient, 'node' | 'memory' | 'nodeRevision' | 'urnAlias'>;
type Db = IncludeDb;


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
  db: Db, access: Record<string, unknown>, memo: IncludeReadMemo, memoryId: string, loc: string, targetId?: string,
): Promise<Target | null> {
  const key = targetId ?? `${memoryId}\u0000${loc}`;
  let hit = memo.targetByAddress.get(key);
  if (!hit) {
    hit = (async () => {
      const node = await db.node.findFirst({
        where: { ...(targetId ? { id: targetId } : { loc }), memoryId, deletedAt: null, AND: [access, { memory: { deletedAt: null } }] },
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
async function approvedText(db: Db, target: Target, pinned: number | undefined): Promise<{ revNo: number; text: string } | null> {
  const revNo = pinned ?? (await newestApprovedRevisionOf(db, target.id)).found?.revNo;
  if (revNo === undefined) return null;
  const verdict = await revisionApprovalOf(db, target.id, revNo);
  if (verdict.state !== 'APPROVED' || !verdict.served) return null;
  if (verdict.served.memoryId !== target.memoryId) return null;
  return { revNo, text: verdict.served.content ?? '' };
}

/**
 * #2046 — THE include selector (cor:dmo:150:02), shared by every read and by the
 * boot-prompt compile so the two cannot disagree about which revision a tag
 * serves. `approved` (pinned or not) serves the revision the shared approval
 * predicate qualifies; `rev=N` alone serves stored revision N; no settings
 * serves the latest. `signed` is ignored until signing ships (D7), as before.
 * Null when no revision qualifies: a reader shows the notice, a compile refuses.
 */
export async function selectIncludeRevision(
  db: IncludeDb, memo: IncludeReadMemo, target: IncludeTarget, settings: IncludeTag['settings'],
): Promise<{ revNo: number; text: string } | null> {
  if (settings.approved) return approvedText(db, target, settings.rev);
  if (settings.rev !== undefined) {
    const text = await lookupRevision(db, memo, target, settings.rev);
    return text == null ? null : { revNo: settings.rev, text };
  }
  return { revNo: target.revSeq, text: target.content ?? '' };
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
  let targetId: string | undefined;
  if (tag.kind === 'urn') {
    let identity = memo.targetIdentityByUrn.get(tag.target);
    if (!identity) {
      identity = includeUrnTarget(db, tag.target);
      memo.targetIdentityByUrn.set(tag.target, identity);
    }
    const resolved = await identity;
    if (!resolved || (resolved.memoryId !== includerMemoryId && !opts.foreign)) return BROKEN_INCLUDE_NOTICE;
    memoryId = resolved.memoryId;
    loc = resolved.loc;
    targetId = resolved.id;
  }
  const target = await lookupTarget(db, access, memo, memoryId, loc, targetId);
  if (!target || trail.has(target.id)) return BROKEN_INCLUDE_NOTICE;
  const selected = await selectIncludeRevision(db, memo, target, tag.settings);
  if (!selected) return BROKEN_INCLUDE_NOTICE;
  if (!tag.settings.approved && tag.settings.rev === undefined && target.content == null) return '';
  // Rendered per traversal: this node's ancestors and depth travel with it.
  return spliceWithin(db, access, memo, opts, selected.text, target.memoryId, new Set([...trail, target.id]), level + 1);
}

async function spliceWithin(
  db: Db, access: Record<string, unknown>, memo: IncludeReadMemo, opts: SpliceOptions,
  content: string, memoryId: string, trail: ReadonlySet<string>, level: number,
): Promise<string> {
  const guard = opts.literalGuard;
  // The guard must be absent from every text it will be restored out of, whether or not that text has a tag.
  if (guard && content.includes(guard)) throw new LiteralGuardCollision();
  if (!content.includes('{{>')) return content;
  const literal = guard ? locateLiteralIncludeTags(content) : [];
  // Copy `content[from, to)`, guarding the opener of each literal tag inside it.
  const copy = (from: number, to: number): string => {
    let text = '';
    let at = from;
    for (const l of literal) {
      if (l.index < from || l.index >= to) continue;
      text += content.slice(at, l.index) + guard + content.slice(l.index + 3, l.index + l.raw.length);
      at = l.index + l.raw.length;
    }
    return text + content.slice(at, to);
  };
  let tags: Array<IncludeTag & { index: number }>;
  try {
    tags = locateIncludeTags(content);
  } catch (e) {
    if (e instanceof IncludeSyntaxError) return copy(0, content.length); // a stored malformed tag renders as it always did
    throw e;
  }
  let out = '';
  let cursor = 0;
  for (const tag of tags) {
    out += copy(cursor, tag.index);
    out += await expandTag(db, access, memo, opts, tag, memoryId, trail, level);
    cursor = tag.index + tag.raw.length;
  }
  return out + copy(cursor, content.length);
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
