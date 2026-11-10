import { Prisma } from '../../generated/prisma/index.js';

/** Selection-only equivalent of the final branch guard; the in-lock TypeScript validator remains authoritative. */
export function mirrorRetryBranchEligibleSql(branch: Prisma.Sql, configured: Prisma.Sql): Prisma.Sql {
  const template = Prisma.sql`COALESCE(${configured}, 'hadron-updates')`;
  const at = Prisma.sql`position('{client}' in ${template})`;
  const final = Prisma.sql`(CASE WHEN ${at} = 0 THEN ${template} ELSE ${branch} END)`;
  // PostgreSQL text cannot contain NUL; the remaining forbidden bytes match gitRef.ts.
  const forbidden = String.raw`[\x01-\x1f\x7f ~^:?*[\\]`;
  return Prisma.sql`(
    length(${final}) > 0
    AND left(${final}, 1) NOT IN ('-', '+', '.', '/')
    AND right(${final}, 1) NOT IN ('.', '/')
    AND ${final} <> '@'
    AND position('/.' in ${final}) = 0
    AND right(${final}, 5) <> '.lock'
    AND position('.lock/' in ${final}) = 0
    AND position('..' in ${final}) = 0
    AND position('//' in ${final}) = 0
    AND position('@{' in ${final}) = 0
    AND ${final} !~ ${forbidden}
    AND (${at} = 0 OR (
      length(${branch}) > length(${template}) - 8
      AND left(${branch}, ${at} - 1) = left(${template}, ${at} - 1)
      AND right(${branch}, length(${template}) - ${at} - 7) = substring(${template} from ${at} + 8)
    ))
  )`;
}
