/**
 * #5412 section 5 (gate rulings issuecomment-7238580841 and issuecomment-7238581276): the ONE per-node arm for a memory a caller
 * reaches only through `memory.read` grants that carry a `branch`.
 *
 * Such a memory never joins the per-memory reach sets (`getAccessibleMemoryIds`, `memoryAccessFilter`, the MCP principal access),
 * so every per-memory door treats it as unreadable and fails closed by construction. Only three node surfaces, GraphQL and MCP
 * both, admit its nodes inside the branch: point read, listing and search. They call the builders here, so the branch test is
 * written once (in JavaScript, Prisma and SQL) and the three cannot disagree:
 *   - {@link branchAdmitsLoc} (readGrant.ts) for a row already in hand;
 *   - {@link branchNodeWhereArms} for a Prisma `where`;
 *   - {@link branchSqlClause} for the raw retrieval statements (`NodeSqlFilter.branches`), applied INSIDE the statement, before
 *     ranking, paging, totals and the vector candidate limit, so no count or order reveals a node outside the branch.
 *
 * A branch is a loc prefix on a `:` boundary (`grantCoversLoc`): `a:b` admits `a:b` and `a:b:…`, never `a:bc`. `_` and `%` in a
 * prefix are literal on every path.
 */
import { escapePrismaLikePattern } from '../literalLocPrefix.js';

/** Memory id → the loc prefixes the caller may read it under. A memory read whole is never a key. */
export type BranchScopes = ReadonlyMap<string, readonly string[]>;

export const NO_BRANCHES: BranchScopes = new Map();

/**
 * The branch map with every memory the caller ALSO reaches whole removed (condition: a whole-memory route always wins). `whole` is
 * the caller's per-memory reach set from whichever surface asks.
 */
export function branchOnly(branches: BranchScopes, whole: Iterable<string>): BranchScopes {
  if (branches.size === 0) return NO_BRANCHES;
  const out = new Map(branches);
  for (const id of whole) out.delete(id);
  return out;
}

/** The branch map restricted to `ids` (a surface's requested scope). */
export function branchesWithin(branches: BranchScopes, ids: Iterable<string>): BranchScopes {
  if (branches.size === 0) return NO_BRANCHES;
  const out = new Map<string, readonly string[]>();
  for (const id of ids) {
    const p = branches.get(id);
    if (p && p.length > 0) out.set(id, p);
  }
  return out;
}

/**
 * Prisma `OR` arms, one per branch memory: the memory, and a loc equal to a prefix or under it on a `:` boundary. Combine with
 * the whole-memory arm (`{ memoryId: { in: whole } }`) under one `OR`; never use these alone to widen a query that has no scope.
 */
export function branchNodeWhereArms(branches: BranchScopes): Array<Record<string, unknown>> {
  const arms: Array<Record<string, unknown>> = [];
  for (const [memoryId, prefixes] of branches) {
    if (prefixes.length === 0) continue;
    arms.push({
      memoryId,
      OR: prefixes.flatMap((p) => [{ loc: p }, { loc: { startsWith: escapePrismaLikePattern(`${p}:`) } }]),
    });
  }
  return arms;
}

/**
 * The Prisma restriction a query that already scopes by memory id adds: a row in a branch memory must be inside a prefix; rows in
 * other memories are untouched. Null when there is no branch. AND it with the query's own scope (never OR).
 */
export function branchRestrictionWhere(branches: BranchScopes): Record<string, unknown> | null {
  const arms = branchNodeWhereArms(branches);
  if (arms.length === 0) return null;
  return { OR: [{ memoryId: { notIn: [...branches.keys()] } }, ...arms] };
}

/**
 * The node-scope `where` for a surface that reads whole memories `whole` plus the branch memories: `{ memoryId: { in: whole } }`
 * when there is no branch, else an `OR` of that arm and the branch arms.
 */
export function nodeScopeWhere(whole: readonly string[], branches: BranchScopes): Record<string, unknown> {
  const arms = branchNodeWhereArms(branches);
  if (arms.length === 0) return { memoryId: { in: [...whole] } };
  return { OR: [{ memoryId: { in: [...whole] } }, ...arms] };
}

/**
 * The SQL predicate for the retrieval statements: a row in a branch memory must sit inside one of its prefixes; a row in any other
 * memory is untouched (the statement's own `memory_id` scope decides it). `starts_with` with the bound `prefix:` keeps `_` and `%`
 * literal. Empty string when there is no branch.
 */
export function branchSqlClause(
  branches: ReadonlyArray<{ memoryId: string; prefixes: readonly string[] }> | undefined,
  bind: (v: unknown) => string,
): string {
  const rows = (branches ?? []).filter((b) => b.prefixes.length > 0);
  if (rows.length === 0) return '';
  const arms = rows.map((b) => {
    const locs = b.prefixes.map((p) => `loc = ${bind(p)} OR starts_with(loc, ${bind(`${p}:`)})`).join(' OR ');
    return `(memory_id = ${bind(b.memoryId)} AND (${locs}))`;
  });
  return `(memory_id <> ALL(${bind(rows.map((b) => b.memoryId))}::text[]) OR ${arms.join(' OR ')})`;
}

/** The `NodeSqlFilter.branches` form of a branch map. */
export function branchSqlRows(branches: BranchScopes): Array<{ memoryId: string; prefixes: string[] }> {
  return [...branches].map(([memoryId, prefixes]) => ({ memoryId, prefixes: [...prefixes] }));
}
