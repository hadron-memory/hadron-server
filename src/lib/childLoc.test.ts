/**
 * #2832 — the parent-loc expression index lives in three DDL sites (the migration, prisma/post-push.sql and the
 * test template builder) and in the filter's SQL. A query only uses an expression index when it compares the
 * index's own expression, so all four must carry the exact text of PARENT_LOC_SQL.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PARENT_LOC_SQL } from './childLoc.js';

const STATEMENT = `CREATE INDEX IF NOT EXISTS nodes_memory_parent_loc_idx\n  ON nodes (memory_id, (${PARENT_LOC_SQL}));`;
const squash = (s: string) => s.replace(/\s+/g, ' ');

describe('#2832 parent-loc expression index stays in lockstep', () => {
  it.each([
    'prisma/migrations/20261030100000_nodes_parent_loc_index/migration.sql',
    'prisma/post-push.sql',
    'src/test/globalSetup.ts',
  ])('%s carries the index on exactly PARENT_LOC_SQL', (file) => {
    expect(squash(readFileSync(file, 'utf8'))).toContain(squash(STATEMENT));
  });

  it('the filter compares the same expression', () => {
    expect(readFileSync('src/lib/retrieval/postgres.ts', 'utf8')).toContain('${PARENT_LOC_SQL} = ${bind(flt.childrenOf)}');
  });
});
