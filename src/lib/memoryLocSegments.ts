/**
 * #3456 — the bounded read of the distinct next loc segments under a parent loc
 * (cor:api:090:05). One level only: for a parent `P` it lists the names a tree shows as
 * branches one level down, including a branch with no node of its own (`findings:flaky-ci`
 * with no `findings` node lists `findings`, `hasNode: false`).
 *
 * The caller (`memoryLocSegments` in resolvers.query.node.ts) resolves WHICH memories and
 * WHICH nodes are eligible through the same computation as `findNodes` and hands this module
 * plain ids. This module only reads loc strings, so it holds no access rule of its own.
 *
 * Order (ruling 0217, cor:dmo:020:01): rows are grouped by memory id; inside a memory a
 * node-backed segment whose node has a position (`seq`) comes first, by position, then every
 * other segment by name. The keyset is (memory id, position-absent-last, segment name), which
 * identifies every row, so following the continuation returns each row once.
 */
import { Buffer } from 'node:buffer';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES } from './retrieval/defaultNodeTypes.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** The indexed key expression (nodes_memory_segment_key_idx); the walk query inlines it and must match it unchanged. */
export const SEGMENT_KEY_SQL = `(replace(loc, ':', chr(1))) COLLATE "C"`;

/**
 * #2836 (cor:api:090:05 rev 5): the node types a segment never comes from. findNodes' unqualified
 * defaults (system, chat-message), plus comment, which segments always left out.
 */
export const SEGMENT_INELIGIBLE_NODE_TYPES: readonly string[] = Object.freeze([...UNQUALIFIED_SEARCH_EXCLUDED_NODE_TYPES, 'comment']);

/** The partial index holding only eligible rows (prisma/migrations/20261106050000_nodes_segment_key_eligible_index). */
export const SEGMENT_ELIGIBLE_INDEX = 'nodes_memory_segment_key_eligible_idx';

/**
 * The eligible-row predicate, with the type list inlined as a SQL literal, never a bound parameter:
 * the planner can use the partial index only when it can prove the query's predicate implies the
 * index's, and it cannot prove that from a parameter. With `alias` omitted this is, byte for byte,
 * the index's WHERE clause (pinned against the migration and post-push.sql). A chat root holds tens
 * of thousands of messages; as a row filter on the full index the walk would step over every one
 * (and the planner, expecting that, flips plans and JIT-compiles every read).
 */
export function segmentEligibleSql(alias?: string): string {
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  const list = SEGMENT_INELIGIBLE_NODE_TYPES.map((t) => {
    if (!/^[a-z][a-z0-9-]*$/.test(t)) throw new Error(`segmentEligibleSql: unexpected node type literal ${JSON.stringify(t)}`);
    return `'${t}'`;
  }).join(',');
  return `${col('deleted_at')} IS NULL AND ${col('node_type')} <> ALL(ARRAY[${list}]) AND ${col('loc')} <> ''`;
}

export const LOC_SEGMENTS_DEFAULT_LIMIT = 20;
export const LOC_SEGMENTS_MAX_LIMIT = 200;

export interface LocSegmentRow {
  segment: string;
  hasNode: boolean;
  memoryId: string;
}

export interface LocSegmentsPage {
  items: LocSegmentRow[];
  hasMore: boolean;
  /** Opaque; null when `hasMore` is false. */
  endCursor: string | null;
}

/** The page size a caller asked for: default 20 (also null), clamped to 1..cap, never refused for being large. */
export function normalizeLocSegmentsLimit(limit: number | null | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return LOC_SEGMENTS_DEFAULT_LIMIT;
  return Math.min(LOC_SEGMENTS_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

interface Cursor { m: string; s: number | null; n: string }

export function encodeLocSegmentsCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.m, c.s, c.n]), 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this module issued (the caller refuses it). */
export function decodeLocSegmentsCursor(raw: string): Cursor | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [m, s, n] = v as unknown[];
    if (typeof m !== 'string' || typeof n !== 'string') return null;
    // The position is bound as int4 and the strings as text: a value Postgres cannot take must be a refused
    // cursor, not an internal error.
    if (m.includes('\0') || n.includes('\0')) return null;
    if (s !== null && !(typeof s === 'number' && Number.isInteger(s) && s >= -2147483648 && s <= 2147483647)) return null;
    return { m, s: s as number | null, n };
  } catch {
    return null;
  }
}

/**
 * One page. `memoryIds` and `excludeNodeIds` are the already-gated scope (readable set after
 * system-memory inheritance). `parent` is "" for the root. `after` is a decoded cursor.
 *
 * Eligible nodes match findNodes' defaults: live (not soft-deleted), none of
 * SEGMENT_INELIGIBLE_NODE_TYPES (system, chat-message, comment), and not an overridden inherited
 * node. A segment exists for a memory when an eligible node has loc `<parent>:<seg>` or starts
 * with `<parent>:<seg>:` (root: `<seg>` / `<seg>:`).
 */
export async function readLocSegments(db: Db, args: LocSegmentsArgs): Promise<LocSegmentsPage> {
  const { memoryIds, limit } = args;
  if (memoryIds.length === 0) return { items: [], hasMore: false, endCursor: null };
  const rows = await db.$queryRaw<Array<{ memory_id: string; seg: string; has_node: boolean; pos: number | null }>>(locSegmentsWalkSql(args));

  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const items = page.map((r) => ({ segment: r.seg, hasNode: r.has_node, memoryId: r.memory_id }));
  const last = page[page.length - 1];
  return {
    items,
    hasMore: more,
    endCursor: more && last ? encodeLocSegmentsCursor({ m: last.memory_id, s: last.pos, n: last.seg }) : null,
  };
}

export interface LocSegmentsArgs {
  memoryIds: string[];
  excludeNodeIds: string[];
  parent: string;
  limit: number;
  after: Cursor | null;
}

/** The walk statement readLocSegments runs, exported so a test can EXPLAIN the exact application query. */
export function locSegmentsWalkSql(args: LocSegmentsArgs): Prisma.Sql {
  const { memoryIds, excludeNodeIds, parent, limit, after } = args;
  const eligible = Prisma.raw(segmentEligibleSql('n'));
  // Skip-scan over the eligible-row partial index (SEGMENT_ELIGIBLE_INDEX, keyed like
  // nodes_memory_segment_key_idx): ':' is chr(1) in the key, so one segment's locs are a contiguous
  // block; each step probes the first eligible row at or after the previous block's end (key||chr(2)). The prefix is compared bytewise on the key, never with LIKE.
  const prefix = parent === '' ? '' : `${parent}:`;
  const prefixKey = prefix.replaceAll(':', '\u0001');
  // Every key under the prefix starts with prefixKey (ends in chr(1)); the first key past them is the same with chr(2).
  const upperKey = prefixKey.slice(0, -1) + '\u0002';
  const hasUpper = prefix !== '';
  return Prisma.sql`
    WITH RECURSIVE walk AS (
      SELECT m.memory_id, f.loc, f.seq
      FROM unnest(${memoryIds}::text[]) AS m(memory_id)
      CROSS JOIN LATERAL (
        SELECT n.loc, n.seq FROM nodes n
        WHERE n.memory_id = m.memory_id
          AND (replace(n.loc, ':', chr(1))) COLLATE "C" >= ${prefixKey}::text COLLATE "C"
          AND (NOT ${hasUpper}::boolean OR (replace(n.loc, ':', chr(1))) COLLATE "C" < ${upperKey}::text COLLATE "C")
          AND ${eligible}
          AND NOT (n.id = ANY(${excludeNodeIds}::text[]))
        ORDER BY (replace(n.loc, ':', chr(1))) COLLATE "C" ASC
        LIMIT 1
      ) f
      UNION ALL
      SELECT w.memory_id, f.loc, f.seq
      FROM walk w
      CROSS JOIN LATERAL (
        SELECT n.loc, n.seq FROM nodes n
        WHERE n.memory_id = w.memory_id
          AND (replace(n.loc, ':', chr(1))) COLLATE "C" >=
              (${prefixKey}::text || replace(split_part(substr(w.loc, length(${prefix}::text) + 1), ':', 1), ':', chr(1)) || chr(2)) COLLATE "C"
          AND (NOT ${hasUpper}::boolean OR (replace(n.loc, ':', chr(1))) COLLATE "C" < ${upperKey}::text COLLATE "C")
          AND ${eligible}
          AND NOT (n.id = ANY(${excludeNodeIds}::text[]))
        ORDER BY (replace(n.loc, ':', chr(1))) COLLATE "C" ASC
        LIMIT 1
      ) f
    ), segs AS (
      SELECT memory_id,
             split_part(substr(loc, length(${prefix}::text) + 1), ':', 1) AS seg,
             (loc = ${prefix} || split_part(substr(loc, length(${prefix}::text) + 1), ':', 1)) AS has_node,
             CASE WHEN loc = ${prefix} || split_part(substr(loc, length(${prefix}::text) + 1), ':', 1) THEN seq END AS pos
      FROM walk
    )
    SELECT memory_id, seg, has_node, pos
    FROM segs
    WHERE seg <> ''
      AND (${after === null}::boolean
           OR (memory_id, (pos IS NULL), COALESCE(pos, 0), seg)
              > (${after?.m ?? ''}::text, (${after?.s ?? null}::int IS NULL), COALESCE(${after?.s ?? null}::int, 0), ${after?.n ?? ''}::text))
    ORDER BY memory_id ASC, (pos IS NULL) ASC, pos ASC, seg ASC
    LIMIT ${limit + 1}::int`;
}
