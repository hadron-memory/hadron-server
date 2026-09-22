import type { Prisma, PrismaClient } from '../generated/prisma/index.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Prisma's `startsWith` compiles to SQL LIKE, where `_` and `%` are
 * wildcards. Node locs permit both characters, so Channel ownership must use
 * PostgreSQL's literal `starts_with` predicate instead
 * (`findings:prisma-string-filters-are-unescaped-like`).
 */
export async function nodeIdsWithLiteralLocPrefix(
  db: Db,
  memoryId: string,
  prefix: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM nodes
    WHERE memory_id = ${memoryId}
      AND starts_with(loc, ${prefix})
  `;
  return rows.map((row) => row.id);
}

/** The allocator/backfill high-water over canonical message node types. */
export async function maxMessageSeqAtLiteralLocPrefix(
  db: Db,
  memoryId: string,
  prefix: string,
): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ maxSeq: number | null }>>`
    SELECT MAX(seq) AS "maxSeq"
    FROM nodes
    WHERE memory_id = ${memoryId}
      AND starts_with(loc, ${prefix})
      AND node_type IN ('chat-message', 'record')
      AND seq IS NOT NULL
  `;
  return row?.maxSeq ?? 0;
}
