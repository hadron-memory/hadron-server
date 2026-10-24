import { memoryAccessFilter, type Context } from '../api/graphql/schema/resolvers.helpers.js';
import { resolveNodeRef } from './entityRef/nodeRef.js';
import { AmbiguousLegacyUrnError, NodeNotFoundError } from './entityRef/errors.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, isBootPromptRole } from './bootPrompt.js';
import { IncludeSyntaxError, locateIncludeTags, type IncludeTag } from './includes/parseIncludeTags.js';
import { IncludeReadMemo, selectIncludeRevision, type IncludeTarget } from './includes/spliceIncludes.js';
import { decryptNodeFields } from './nodeCrypto.js';
import { newestApprovedRevisionOf } from './nodeApproval.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { safeNodeUrnV2 } from './urnEmit.js';

/**
 * #2048 (S11a, cor:agt:040:13) — link lint for a boot-prompt SOURCE.
 *
 * Lint warns and never blocks. It is a pure function of the node's stored include tags and the CALLER's own
 * authorized reads of each target, so a warning computed for a write's result and one computed on a later read
 * are the same code on the same state: nothing is stored, nothing goes stale (R46), and a source change with no
 * write shows on the next read (R98). A target the caller cannot read, one that is absent and one in a memory that
 * cannot be opened are the SAME position-only {@link LintKind BROKEN_INCLUDE} (cor:dmo:150:05): a warning never
 * says whether such a target exists, is retired or is approved.
 *
 * Compiled/served warnings (S11b), the worker signature link (S11c) and the policy-override notice read other
 * inputs and are not produced here; {@link lintSourceWarnings} returns `null` (unavailable) for a compiled node
 * rather than an empty list that would pass for "no warnings".
 */
export type LintKind =
  | 'RETIRED_TARGET'
  | 'NO_QUALIFYING_REVISION'
  | 'PINNED_NEWER_APPROVED'
  | 'SIGNING_NOT_CHECKED'
  | 'BROKEN_INCLUDE';

/** Every field a warning may carry; the serializer is an allowlist, there is no free-form detail (cor:api:120:04). */
export interface LintWarning {
  kind: LintKind;
  /** 0-based offset of the include tag in the source text. */
  position: number;
  text: string;
  /** Null for a position-only warning and for kinds with no readable target. */
  targetUrn: string | null;
  pinnedRevision: number | null;
  newerRevision: number | null;
  /** Reserved for the policy-override notice; never set by source lint. */
  overriddenNodeLoc: null;
  /** Reserved for the worker signature/trailer lint; never set by source lint. */
  workerField: null;
}

export interface LintWarningPage {
  items: LintWarning[];
  total: number;
  nextCursor: string | null;
}

export const LINT_PAGE_DEFAULT = 50;
export const LINT_PAGE_MAX = 100;
/** Tags examined per node. Past it the answer is unavailable, never a silently truncated list. */
export const LINT_MAX_TAGS = 5_000;
/** Distinct targets read per query. */
const TARGET_BATCH = 100;

const KIND_RANK: Record<LintKind, number> = {
  BROKEN_INCLUDE: 0, RETIRED_TARGET: 1, NO_QUALIFYING_REVISION: 2, PINNED_NEWER_APPROVED: 3, SIGNING_NOT_CHECKED: 4,
};

/** What lint reads of a node: the stored (decrypted) source and how it is classified. */
export interface LintSubject {
  id: string;
  memoryId: string;
  content: string | null;
  role?: string | null;
  nodeType?: string | null;
}

const warning = (kind: LintKind, position: number, text: string, extra: Partial<LintWarning> = {}): LintWarning => ({
  kind, position, text, targetUrn: null, pinnedRevision: null, newerRevision: null,
  overriddenNodeLoc: null, workerField: null, ...extra,
});

interface FoundTarget extends IncludeTarget {
  urn: string;
  deletedAt: Date | null;
}

const targetSelect = {
  id: true, memoryId: true, loc: true, content: true, revSeq: true, deletedAt: true,
  memory: { select: { id: true, isEncrypted: true, urn: true } },
} as const;

/**
 * Read every distinct include target once, as the caller. A missing, unreadable or keyless-encrypted target is
 * simply absent from the result (the caller reports it position-only); a soft-deleted one IS returned, marked, so
 * it can be told apart as retired (R20 A) without ever leaving the caller's readable memories.
 */
async function readTargets(
  ctx: Context, access: Record<string, unknown>, subject: LintSubject, tags: ReadonlyArray<IncludeTag & { index: number }>,
): Promise<Map<string, FoundTarget>> {
  const found = new Map<string, FoundTarget>();
  const keyOf = (tag: IncludeTag) => `${tag.kind}\u0000${tag.target}`;
  const locs = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const tag of tags) {
    const key = keyOf(tag);
    if (locs.has(key) || ids.has(key)) continue;
    if (tag.kind === 'loc') { locs.set(key, tag.target); continue; }
    try {
      ids.set(key, (await resolveNodeRef(ctx.db, tag.target, undefined, { includeDeleted: true })).id);
    } catch (error) {
      if (error instanceof NodeNotFoundError || error instanceof AmbiguousLegacyUrnError) continue;
      throw error;
    }
  }
  const rows: Array<Awaited<ReturnType<typeof ctx.db.node.findMany<{ select: typeof targetSelect }>>>[number]> = [];
  const batch = async (where: Record<string, unknown>) => {
    rows.push(...await ctx.db.node.findMany({ where: { AND: [access, { memory: { deletedAt: null } }, where] }, select: targetSelect }));
  };
  const locList = [...new Set(locs.values())];
  for (let i = 0; i < locList.length; i += TARGET_BATCH) {
    await batch({ memoryId: subject.memoryId, loc: { in: locList.slice(i, i + TARGET_BATCH) } });
  }
  const idList = [...new Set(ids.values())];
  for (let i = 0; i < idList.length; i += TARGET_BATCH) await batch({ id: { in: idList.slice(i, i + TARGET_BATCH) } });

  const open = (row: (typeof rows)[number]): FoundTarget | null => {
    const memory = { id: row.memoryId, isEncrypted: row.memory?.isEncrypted === true };
    const base = { id: row.id, memoryId: row.memoryId, revSeq: row.revSeq, memory, urn: safeNodeUrnV2(row.memory?.urn ?? '', row.loc), deletedAt: row.deletedAt };
    if (!memory.isEncrypted) return { ...base, content: row.content };
    // Same as a reader: an encrypted memory's text opens only with the caller's session key.
    if (!sessionKeyCache.getByMemoryId(memory.id)) return null;
    try { return { ...base, content: decryptNodeFields({ content: row.content }, memory).content ?? null }; }
    catch { return null; }
  };
  const byLoc = new Map(rows.filter(r => r.memoryId === subject.memoryId).map(r => [r.loc, r]));
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const [key, loc] of locs) {
    const row = byLoc.get(loc);
    const opened = row ? open(row) : null;
    if (opened) found.set(key, opened);
  }
  for (const [key, id] of ids) {
    const row = byId.get(id);
    const opened = row ? open(row) : null;
    if (opened) found.set(key, opened);
  }
  return found;
}

const describeSettings = (settings: IncludeTag['settings']): string => {
  const parts = [settings.rev !== undefined ? `rev=${settings.rev}` : null, settings.approved ? 'approved' : null].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(' ')})` : '';
};

/**
 * Every warning for a boot-prompt source, ordered by position then kind; `[]` is a real empty answer for a node
 * with nothing to warn about (including any node that is not a boot prompt). Throws on a read failure: callers
 * that must not fail the request map it to `null` with {@link lintWarningPage}.
 */
export async function lintSourceWarnings(ctx: Context, subject: LintSubject): Promise<LintWarning[] | null> {
  if (!isBootPromptRole(subject.role)) return [];
  // A compiled node's warnings read its recorded provenance (S11b), not live tags: unavailable, not empty.
  if (subject.nodeType === COMPILED_BOOT_PROMPT_NODE_TYPE) return null;
  const content = subject.content;
  if (!content || !content.includes('{{>')) return [];
  let tags: Array<IncludeTag & { index: number }>;
  try { tags = locateIncludeTags(content); }
  // A stored malformed tag renders as written (it is text, not an include), so it has nothing to resolve.
  catch (error) { if (error instanceof IncludeSyntaxError) return []; throw error; }
  if (tags.length === 0) return [];
  if (tags.length > LINT_MAX_TAGS) throw new Error(`Boot prompt has more than ${LINT_MAX_TAGS} include tags`);

  const access = await memoryAccessFilter(ctx);
  const targets = await readTargets(ctx, access, subject, tags);
  const memo = new IncludeReadMemo();
  // The newest approved revision is a property of the target; ask once per target.
  const newestApproved = new Map<string, Promise<number | null>>();
  const newestOf = (targetId: string) => {
    let hit = newestApproved.get(targetId);
    if (!hit) {
      hit = newestApprovedRevisionOf(ctx.db, targetId).then(result => result.found?.revNo ?? null);
      newestApproved.set(targetId, hit);
    }
    return hit;
  };

  const warnings: LintWarning[] = [];
  for (const tag of tags) {
    const target = targets.get(`${tag.kind}\u0000${tag.target}`);
    if (!target) {
      warnings.push(warning('BROKEN_INCLUDE', tag.index, 'This include cannot be resolved.'));
    } else if (target.deletedAt) {
      warnings.push(warning('RETIRED_TARGET', tag.index, `Include target ${target.urn} is retired (deleted).`, { targetUrn: target.urn }));
    } else {
      const selected = await selectIncludeRevision(ctx.db, memo, target, tag.settings);
      if (!selected) {
        warnings.push(warning(
          'NO_QUALIFYING_REVISION', tag.index,
          `Include target ${target.urn} has no revision that meets this include's settings${describeSettings(tag.settings)}.`,
          { targetUrn: target.urn, pinnedRevision: tag.settings.rev ?? null },
        ));
      }
      if (tag.settings.rev !== undefined) {
        const newest = await newestOf(target.id);
        if (newest != null && newest > tag.settings.rev) {
          warnings.push(warning(
            'PINNED_NEWER_APPROVED', tag.index,
            `Include pins revision ${tag.settings.rev} of ${target.urn}; revision ${newest} is approved and newer.`,
            { targetUrn: target.urn, pinnedRevision: tag.settings.rev, newerRevision: newest },
          ));
        }
      }
    }
    // The setting is about the tag's own text, so it needs no target and discloses none.
    if (tag.settings.signed) {
      warnings.push(warning(
        'SIGNING_NOT_CHECKED', tag.index,
        'The "signed" setting is not checked yet: signing has not shipped, so this include is served as if it were not signed.',
        target && !target.deletedAt ? { targetUrn: target.urn } : {},
      ));
    }
  }
  return warnings.sort((a, b) => a.position - b.position || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

const encodeCursor = (offset: number) => Buffer.from(String(offset), 'utf8').toString('base64url');
function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const offset = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
}

/** One page of an already-computed list: default 50, clamped to [1, 100], deterministic offset cursor. */
export function pageLintWarnings(all: LintWarning[], args: { first?: number | null; after?: string | null }): LintWarningPage {
  const size = Math.min(Math.max(Math.trunc(args.first ?? LINT_PAGE_DEFAULT) || LINT_PAGE_DEFAULT, 1), LINT_PAGE_MAX);
  const start = decodeCursor(args.after);
  const items = all.slice(start, start + size);
  const end = start + items.length;
  return { items, total: all.length, nextCursor: end < all.length ? encodeCursor(end) : null };
}

/**
 * The warning page a read or a write result carries. A fault is `null` (unavailable), never an empty page, and
 * never an error: the write that raised the question has already committed and lint cannot undo or fail it.
 */
export async function lintWarningPage(
  ctx: Context, subject: LintSubject, args: { first?: number | null; after?: string | null } = {},
): Promise<LintWarningPage | null> {
  try {
    const all = await lintSourceWarnings(ctx, subject);
    return all === null ? null : pageLintWarnings(all, args);
  } catch (error) {
    console.error(`[bootPromptLint] warnings unavailable for node ${subject.id}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The warning page for a node held only by id or by (memory, loc) (an approval receipt, an MCP write): loads the live
 * row and opens an encrypted memory's text with the caller's session key. A node that is gone, or cannot be
 * opened, is unavailable (`null`), not "no warnings".
 */
export async function lintWarningPageForNodeId(
  ctx: Context, node: string | { memoryId: string; loc: string }, args: { first?: number | null; after?: string | null } = {},
): Promise<LintWarningPage | null> {
  const nodeId = typeof node === 'string' ? node : `${node.memoryId}:${node.loc}`;
  try {
    const row = await ctx.db.node.findUnique({
      where: typeof node === 'string' ? { id: node } : { loc_memoryId: { loc: node.loc, memoryId: node.memoryId } },
      select: { id: true, memoryId: true, content: true, role: true, nodeType: true, deletedAt: true, memory: { select: { id: true, isEncrypted: true } } },
    });
    if (!row || row.deletedAt) return null;
    let content = row.content;
    if (row.memory?.isEncrypted) {
      if (!sessionKeyCache.getByMemoryId(row.memoryId)) return null;
      content = decryptNodeFields({ content }, { id: row.memoryId, isEncrypted: true }).content ?? null;
    }
    return lintWarningPage(ctx, { id: row.id, memoryId: row.memoryId, content, role: row.role, nodeType: row.nodeType }, args);
  } catch (error) {
    console.error(`[bootPromptLint] warnings unavailable for node ${nodeId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Plain-text rendering for the MCP tools, which return text rather than a GraphQL node (cor:agt:040:13 R19). */
export function renderLintWarnings(page: LintWarningPage | null): string {
  if (page === null) return '\nLint warnings: unavailable right now.';
  if (page.total === 0) return '';
  const lines = page.items.map(item => `- [${item.kind}] at position ${item.position}: ${item.text}`);
  const more = page.nextCursor ? [`- … ${page.total - page.items.length} more; read the node's lintWarnings to page through them.`] : [];
  return `\nLint warnings (${page.total}):\n${[...lines, ...more].join('\n')}`;
}
