/** #3494: one open-root predicate for counts, minimum-root time and candidate admission. */
import { Prisma } from '../../generated/prisma/index.js';

// Alias names are fixed here and never supplied by a caller. A retracted root is a deleted stub, not open.
export const OPEN_ROOT_SQL = "cm.thread_root_id IS NULL AND cm.thread_state = 'OPEN' AND cm.retracted_at IS NULL AND cn.deleted_at IS NULL";
const openRootWhere = { threadRootId: null, threadState: 'OPEN' as const, retractedAt: null, node: { deletedAt: null } };

/** Prisma equivalent, pinned against the shared SQL on every lifecycle state. Synthetic inherited summaries are zero. */
export function openThreadsWhere(value: boolean | null | undefined, syntheticMemoryIds: string[] = []): Prisma.NodeWhereInput | null {
  if (value == null) return null;
  const predicate: Prisma.NodeWhereInput = { commentsOn: { [value ? 'some' : 'none']: openRootWhere } };
  if (!syntheticMemoryIds.length) return predicate;
  return value
    ? { AND: [{ memoryId: { notIn: syntheticMemoryIds } }, predicate] }
    : { OR: [{ memoryId: { in: syntheticMemoryIds } }, predicate] };
}

/** Correlated EXISTS/NOT EXISTS, before rank/cap/paging. nodeId/memoryId are internal column expressions only. */
export function openThreadsSql(value: boolean | null | undefined, bind: (v: unknown) => string,
  nodeId = 'nodes.id', memoryId = 'nodes.memory_id', syntheticMemoryIds: string[] = []): string {
  if (value == null) return '';
  const exists = `EXISTS (SELECT 1 FROM comment_meta cm JOIN nodes cn ON cn.id = cm.node_id WHERE cm.target_node_id = ${nodeId} AND ${OPEN_ROOT_SQL})`;
  const predicate = value ? exists : `NOT ${exists}`;
  if (!syntheticMemoryIds.length) return predicate;
  const synthetic = `${memoryId} = ANY(${bind(syntheticMemoryIds)}::text[])`;
  return value ? `(NOT (${synthetic}) AND ${predicate})` : `(${synthetic} OR ${predicate})`;
}

/** Same SQL for parameterized Prisma vector queries; aliases are internal fixed expressions. */
export function openThreadsVectorSql(value: boolean | null | undefined, syntheticMemoryIds: string[] = []): Prisma.Sql {
  const values: unknown[] = [];
  const sql = openThreadsSql(value, v => { values.push(v); return '__BOUND__'; }, 'n.id', 'n.memory_id', syntheticMemoryIds);
  if (!sql) return Prisma.empty;
  if (!values.length) return Prisma.sql`AND ${Prisma.raw(sql)}`;
  const [before, after] = sql.split('__BOUND__');
  return Prisma.sql`AND ${Prisma.raw(before)}${values[0]}${Prisma.raw(after)}`;
}
