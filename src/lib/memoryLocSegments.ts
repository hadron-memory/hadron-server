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

type Db = PrismaClient | Prisma.TransactionClient;

/** The indexed key expression (nodes_memory_segment_key_idx); the walk query inlines it and must match it unchanged. */
export const SEGMENT_KEY_SQL = `(replace(loc, ':', chr(1))) COLLATE "C"`;

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
 * Eligible nodes match findNodes' defaults: live (not soft-deleted), not system-type, not a
 * comment, and not an overridden inherited node. A segment exists for a memory when an eligible
 * node has loc `<parent>:<seg>` or starts with `<parent>:<seg>:` (root: `<seg>` / `<seg>:`).
 */
export async function readLocSegments(
  db: Db,
  args: {
    memoryIds: string[];
    excludeNodeIds: string[];
    parent: string;
    limit: number;
    after: Cursor | null;
  },
): Promise<LocSegmentsPage> {
  const { memoryIds, excludeNodeIds, parent, limit, after } = args;
  if (memoryIds.length === 0) return { items: [], hasMore: false, endCursor: null };

  // #3596 / ruling 0229: prove a flat prefix with a sibling-bounded ordered probe,
  // then scan only its index range; otherwise keep the skip-scan below.
  // Skip-scan over nodes_memory_segment_key_idx: ':' is chr(1) in the key, so one segment's locs are a
  // contiguous block; each step probes the first eligible row at or after the previous block's end
  // (key||chr(2)). The prefix is compared bytewise on the key, never with LIKE.
  const prefix = parent === '' ? '' : `${parent}:`;
  const prefixKey = prefix.replaceAll(':', '\u0001');
  // Every key under the prefix starts with prefixKey (ends in chr(1)); the first key past them is the same with chr(2).
  const upperKey = prefixKey.slice(0, -1) + '\u0002';
  // Emit a real range predicate for non-root parents: a parameterized OR can
  // hide the upper index bound from generic plans. Aliases are fixed SQL names,
  // never caller input; prefix values remain bound parameters.
  const upperBound = (alias: 'probe_node' | 'n' | 'flat_node') => prefix === ''
    ? Prisma.empty
    : Prisma.sql`AND (replace(${Prisma.raw(alias)}.loc, ':', chr(1))) COLLATE "C" < ${upperKey}::text COLLATE "C"`;
  const flatBlock = (afterKey: boolean) => Prisma.sql`
        SELECT array_agg(batch.loc ORDER BY batch.key) AS locs,
               array_agg(batch.seq ORDER BY batch.key) AS positions,
               max(batch.key COLLATE "C") AS last_key
        FROM (
          SELECT flat_node.loc, flat_node.seq,
                 (replace(flat_node.loc, ':', chr(1))) COLLATE "C" AS key
          FROM nodes flat_node
          WHERE flat_node.memory_id = m.memory_id
            AND (replace(flat_node.loc, ':', chr(1))) COLLATE "C" >= ${prefixKey}::text COLLATE "C"
            ${upperBound('flat_node')}
            ${afterKey ? Prisma.sql`AND (replace(flat_node.loc, ':', chr(1))) COLLATE "C" > m.last_key COLLATE "C"` : Prisma.empty}
            AND flat_node.deleted_at IS NULL AND flat_node.node_type <> 'system' AND flat_node.node_type <> 'comment' AND flat_node.loc <> ''
            AND NOT (flat_node.id = ANY(${excludeNodeIds}::text[]))
          ORDER BY (replace(flat_node.loc, ':', chr(1))) COLLATE "C" ASC
          LIMIT 256
        ) batch`;
  const rows = await db.$queryRaw<Array<{ memory_id: string; seg: string; has_node: boolean; pos: number | null }>>`
    WITH RECURSIVE shape AS MATERIALIZED (
      SELECT m.memory_id, NOT EXISTS (
        -- OFFSET 0 keeps this ordered subquery ahead of the descendant test.
        -- The first descendant stops the probe; all preceding eligible rows
        -- are distinct direct children, so chooser work is sibling-bounded.
        SELECT 1 FROM (
          SELECT probe_node.loc FROM nodes probe_node
          WHERE probe_node.memory_id = m.memory_id
            AND (replace(probe_node.loc, ':', chr(1))) COLLATE "C" >= ${prefixKey}::text COLLATE "C"
            ${upperBound('probe_node')}
            AND probe_node.deleted_at IS NULL AND probe_node.node_type <> 'system' AND probe_node.node_type <> 'comment' AND probe_node.loc <> ''
            AND NOT (probe_node.id = ANY(${excludeNodeIds}::text[]))
          ORDER BY (replace(probe_node.loc, ':', chr(1))) COLLATE "C" ASC
          OFFSET 0
        ) ordered_nodes
        WHERE strpos(substr(ordered_nodes.loc, length(${prefix}::text) + 1), ':') > 0
      ) AS flat
      FROM unnest(${memoryIds}::text[]) AS m(memory_id)
    ), walk AS (
      SELECT m.memory_id, f.loc, f.seq
      FROM shape m
      CROSS JOIN LATERAL (
        SELECT n.loc, n.seq FROM nodes n
        WHERE n.memory_id = m.memory_id
          AND (replace(n.loc, ':', chr(1))) COLLATE "C" >= ${prefixKey}::text COLLATE "C"
          ${upperBound('n')}
          AND n.deleted_at IS NULL AND n.node_type <> 'system' AND n.node_type <> 'comment' AND n.loc <> ''
          AND NOT (n.id = ANY(${excludeNodeIds}::text[]))
        ORDER BY (replace(n.loc, ':', chr(1))) COLLATE "C" ASC
        LIMIT 1
      ) f
      WHERE NOT m.flat
      UNION ALL
      SELECT w.memory_id, f.loc, f.seq
      FROM walk w
      CROSS JOIN LATERAL (
        SELECT n.loc, n.seq FROM nodes n
        WHERE n.memory_id = w.memory_id
          AND (replace(n.loc, ':', chr(1))) COLLATE "C" >=
              (${prefixKey}::text || replace(split_part(substr(w.loc, length(${prefix}::text) + 1), ':', 1), ':', chr(1)) || chr(2)) COLLATE "C"
          ${upperBound('n')}
          AND n.deleted_at IS NULL AND n.node_type <> 'system' AND n.node_type <> 'comment' AND n.loc <> ''
          AND NOT (n.id = ANY(${excludeNodeIds}::text[]))
        ORDER BY (replace(n.loc, ':', chr(1))) COLLATE "C" ASC
        LIMIT 1
      ) f
    ), flat_blocks AS (
      -- Bounded, ordered keyset blocks keep the flat arm startup-sensitive;
      -- an unbounded ORDER BY/OFFSET can choose a memory scan plus sort.
      -- Node @@unique([loc, memoryId]) is non-partial; a proven flat prefix
      -- has one key per eligible sibling, so strict continuation loses none.
      SELECT m.memory_id, b.locs, b.positions, b.last_key
      FROM shape m
      CROSS JOIN LATERAL (
        ${flatBlock(false)}
      ) b
      WHERE m.flat AND b.last_key IS NOT NULL
      UNION ALL
      SELECT m.memory_id, b.locs, b.positions, b.last_key
      FROM flat_blocks m
      CROSS JOIN LATERAL (
        ${flatBlock(true)}
      ) b
      WHERE b.last_key IS NOT NULL
    ), segs AS (
      SELECT memory_id,
             split_part(substr(loc, length(${prefix}::text) + 1), ':', 1) AS seg,
             (loc = ${prefix} || split_part(substr(loc, length(${prefix}::text) + 1), ':', 1)) AS has_node,
             CASE WHEN loc = ${prefix} || split_part(substr(loc, length(${prefix}::text) + 1), ':', 1) THEN seq END AS pos
      FROM walk
      UNION ALL
      SELECT f.memory_id, substr(item.loc, length(${prefix}::text) + 1) AS seg,
             true AS has_node, item.pos
      FROM flat_blocks f
      CROSS JOIN LATERAL unnest(f.locs, f.positions) AS item(loc, pos)
    )
    SELECT memory_id, seg, has_node, pos
    FROM segs
    WHERE seg <> ''
      AND (${after === null}::boolean
           OR (memory_id, (pos IS NULL), COALESCE(pos, 0), seg)
              > (${after?.m ?? ''}::text, (${after?.s ?? null}::int IS NULL), COALESCE(${after?.s ?? null}::int, 0), ${after?.n ?? ''}::text))
    ORDER BY memory_id ASC, (pos IS NULL) ASC, pos ASC, seg ASC
    LIMIT ${limit + 1}::int`;

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
