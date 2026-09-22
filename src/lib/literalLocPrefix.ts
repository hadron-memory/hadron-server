import type { Prisma, PrismaClient } from '../generated/prisma/index.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Prisma's string filters compile to PostgreSQL LIKE without escaping the
 * caller's value. Escape LIKE's three metacharacters before passing a loc to
 * `startsWith`, preserving indexed filtering, counts and pagination without
 * first materializing an unbounded id list
 * (`findings:prisma-string-filters-are-unescaped-like`).
 */
export function escapePrismaLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
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
