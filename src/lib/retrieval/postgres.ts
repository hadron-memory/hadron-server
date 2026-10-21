/**
 * Postgres implementation of the node retrieval seam (cor:rag:010:02).
 *
 * Lexical search rides the weighted `nodes.tsv` generated column
 * (see prisma/post-push.sql) + GIN index, ranked by `ts_rank_cd`
 * (field-weighted + length-normalized). Boolean operators are compiled to a
 * tsquery expression (tsquery.ts). Vector search delegates to the existing
 * pgvector helpers.
 */
import { contentScopeSql, effectiveContentScope } from '../comments/scope.js';
import { approvalStateSql, mintedSql } from '../nodeApproval.js';
import type {
  NodeRetrievalProvider,
  LexicalHit,
  LexicalSearchOpts,
  RegexSearchOpts,
  VectorSearchOpts,
  FilterSearchOpts,
  FilterWhereOpts,
  NodeSqlFilter,
  LexicalSort,
  BrowseSort,
  NodePropertySort,
} from './provider.js';
import type { VectorHit, ChunkHit } from '../../services/embedding/vectors.js';
import { vectorSearchNodes, vectorSearchChunks } from '../../services/embedding/vectors.js';
import { compileBooleanQuery } from './tsquery.js';
import { compileNodeWhere, compileNodePropertySort } from './nodeWhere.js';
import { regexSearchTimeoutMs } from './regexTimeout.js';

/** Ordered parameter accumulator — appends a value and returns its `$n` placeholder. */
function paramBuilder(seed: unknown[] = []) {
  const params = [...seed];
  return { params, bind: (v: unknown) => `$${params.push(v)}` };
}

/** Structured-filter SQL (cor:api:090:02), AND-combined; applied in-query so filter + sort + paging are exact. */
function filterClause(f: NodeSqlFilter | undefined, bind: (v: unknown) => string): string {
  const parts: string[] = [];
  const flt = f ?? {};
  // Explicit nodeType wins; otherwise exclude system-type nodes (node_type is NOT NULL, default 'info').
  if (flt.nodeType) parts.push(`node_type = ${bind(flt.nodeType)}`);
  else parts.push(`node_type <> 'system'`);
  if (flt.objectType) parts.push(`object_type = ${bind(flt.objectType)}`); // #725 collection facet
  if (flt.isRunnable != null) parts.push(`is_runnable = ${bind(flt.isRunnable)}`);
  if (flt.role != null) {
    const exact = bind(flt.role);
    const descendantPrefix = bind(`${flt.role}.`);
    parts.push(`(role = ${exact} OR starts_with(role, ${descendantPrefix}))`);
  }
  if (flt.tags && flt.tags.length) parts.push(`tags @> ARRAY[${flt.tags.map((t) => bind(t)).join(', ')}]::text[]`);
  if (flt.locPrefix) parts.push(`starts_with(loc, ${bind(flt.locPrefix)})`);
  if (flt.createdBy) parts.push(`created_by = ${bind(flt.createdBy)}`);
  if (flt.updatedAfter) parts.push(`updated_at >= ${bind(flt.updatedAfter)}::timestamptz`);
  if (flt.updatedBefore) parts.push(`updated_at <= ${bind(flt.updatedBefore)}::timestamptz`);
  // #719 — structured predicate over properties/data JSONB, compiled to a
  // parameterized boolean expr sharing this query's `bind` accumulator.
  if (flt.where) parts.push(`(${compileNodeWhere(flt.where, bind)})`);
  const approval = approvalStateSql(flt.approvalState); // #1591
  if (approval) parts.push(approval);
  const mint = mintedSql(flt.minted);
  if (mint) parts.push(mint);
  // #1607 (cor:dmo:110:06) — approval and mint status sets never contain comments.
  if (approval || flt.minted != null) parts.push("node_type <> 'comment'");
  // #1608 (cor:dmo:110:08) — content, comments or both; CONTENT by default.
  const scope = contentScopeSql(effectiveContentScope(flt));
  if (scope) parts.push(scope);
  return parts.length ? ' AND ' + parts.join(' AND ') : '';
}

/**
 * ORDER BY for the no-query browse (relevance is meaningless without a query).
 * A #719 property-path sort overrides the enum ordering when present.
 */
function browseOrderByClause(sort: BrowseSort | undefined, propertySort?: NodePropertySort): string {
  if (propertySort) return compileNodePropertySort(propertySort);
  switch (sort) {
    case 'seq': return 'seq ASC NULLS LAST, loc ASC';
    case 'updatedAt': return 'updated_at DESC, loc ASC';
    default: return 'loc ASC';
  }
}

/**
 * ORDER BY for a lexical query. relevance → score; the rest suppress scoring.
 * A #719 property-path sort overrides the enum ordering when present.
 */
function orderByClause(sort: LexicalSort | undefined, propertySort?: NodePropertySort): string {
  if (propertySort) return compileNodePropertySort(propertySort);
  switch (sort) {
    case 'loc': return 'loc ASC';
    case 'seq': return 'seq ASC NULLS LAST, loc ASC';
    case 'updatedAt': return 'updated_at DESC';
    default: return 'score DESC, loc ASC';
  }
}

// Weight-class defaults, ts_rank_cd order {D, C, B, A} (Postgres convention).
const CLASS_D = 0.1, CLASS_C = 0.2, CLASS_B = 0.4, CLASS_A = 1.0;

// Which weight class each lexical field lives in (must match the tsvector in post-push.sql).
const FIELD_CLASS: Record<string, 'A' | 'B' | 'C' | 'D'> = {
  name: 'A', alias: 'A',
  loc: 'B', tags: 'B',
  description: 'C', abstract: 'C',
  content: 'D', properties: 'D', data: 'D',
};

/**
 * Build the ts_rank_cd weights array {D,C,B,A}. Fields select which classes
 * contribute to the SCORE (a weight-mask, not a hard match filter — matching
 * still spans the whole tsvector; cor:api:090:03). Omitting fields = all classes.
 */
function weightMask(fields?: string[]): [number, number, number, number] {
  if (!fields || fields.length === 0) return [CLASS_D, CLASS_C, CLASS_B, CLASS_A];
  const active = new Set<string>();
  for (const f of fields) {
    const cls = FIELD_CLASS[f];
    if (cls) active.add(cls);
  }
  return [
    active.has('D') ? CLASS_D : 0,
    active.has('C') ? CLASS_C : 0,
    active.has('B') ? CLASS_B : 0,
    active.has('A') ? CLASS_A : 0,
  ];
}

// SQL snippet a field maps to for regex matching (text-cast where needed).
const REGEX_FIELD_SQL: Record<string, string> = {
  name: 'name', alias: 'alias', loc: 'loc',
  description: 'description', abstract: 'abstract', content: 'content',
  tags: "array_to_string(tags, ' ')",
  properties: 'properties::text', data: 'data::text',
};
const REGEX_DEFAULT_FIELDS = ['name', 'alias', 'loc', 'tags', 'description', 'abstract', 'content'];

export const postgresRetrievalProvider: NodeRetrievalProvider = {
  async lexicalSearch(opts: LexicalSearchOpts): Promise<LexicalHit[]> {
    if (opts.memoryIds.length === 0) return [];
    const weights = weightMask(opts.fields);
    // Params, in append order: $1..$T leaf terms (compiled first so the tsquery
    // expression's placeholders are stable), then the filter/memory/limit/offset
    // params via the builder. Weights are server-controlled floats → inlined as
    // a literal ($queryRawUnsafe can't bind a float4[] param).
    const tsq = compileBooleanQuery(opts.query, 1);
    const { params, bind } = paramBuilder([...tsq.params]);
    const weightsLit = `ARRAY[${weights.join(', ')}]::float4[]`;
    const memPh = opts.memoryIds.map((m) => bind(m)).join(', ');
    const deletedClause = opts.includeDeleted ? '' : 'AND deleted_at IS NULL';
    const filterSql = filterClause(opts.filter, bind);
    const orderBy = orderByClause(opts.sort, opts.propertySort);
    const limitPh = bind(opts.limit);
    const offsetPh = bind(opts.offset ?? 0);
    const sql = `
      SELECT id, ts_rank_cd(${weightsLit}, tsv, ${tsq.sql}) AS score
      FROM nodes
      WHERE tsv @@ ${tsq.sql}
        AND memory_id IN (${memPh})
        ${deletedClause}${filterSql}
      ORDER BY ${orderBy}
      LIMIT ${limitPh} OFFSET ${offsetPh}
    `;
    const rows = await opts.db.$queryRawUnsafe<{ id: string; score: number }[]>(sql, ...params);
    return rows.map((r) => ({ nodeId: r.id, score: Number(r.score) }));
  },

  async regexSearch(opts: RegexSearchOpts): Promise<LexicalHit[]> {
    if (opts.memoryIds.length === 0) return [];
    // Matching spans ALL text fields (weight-mask semantics — fields is not a
    // hard filter; cor:api:090:03); `fields` only masks the SCORE, so a match in
    // a non-selected field is still returned, just scored 0.
    const scoreFields = (opts.fields && opts.fields.length > 0 ? opts.fields : REGEX_DEFAULT_FIELDS)
      .filter((f) => REGEX_FIELD_SQL[f]);
    const classWeight = { A: CLASS_A, B: CLASS_B, C: CLASS_C, D: CLASS_D } as const;
    const { params, bind } = paramBuilder();
    const patPh = bind(opts.pattern);
    const matchExpr = REGEX_DEFAULT_FIELDS.map((f) => `${REGEX_FIELD_SQL[f]} ~* ${patPh}`).join(' OR ');
    const scoreExpr = scoreFields
      .map((f) => `CASE WHEN ${REGEX_FIELD_SQL[f]} ~* ${patPh} THEN ${classWeight[FIELD_CLASS[f]]} ELSE 0 END`)
      .join(', ');
    const memPh = opts.memoryIds.map((m) => bind(m)).join(', ');
    const deletedClause = opts.includeDeleted ? '' : 'AND deleted_at IS NULL';
    const filterSql = filterClause(opts.filter, bind);
    const orderBy = orderByClause(opts.sort, opts.propertySort);
    const limitPh = bind(opts.limit);
    const offsetPh = bind(opts.offset ?? 0);
    const sql = `
      SELECT id, GREATEST(${scoreExpr}) AS score
      FROM nodes
      WHERE memory_id IN (${memPh})
        ${deletedClause}${filterSql}
        AND (${matchExpr})
      ORDER BY ${orderBy}
      LIMIT ${limitPh} OFFSET ${offsetPh}
    `;
    // #415: the caller picks the pattern, so the caller picks the cost. Bound
    // the DATABASE work with a transaction-local statement_timeout on the
    // search's own connection: Postgres cancels the statement itself, and the
    // setting dies with the transaction on commit, rollback or cancellation,
    // so it never reaches the pooled connection's session. The budget is a
    // validated positive integer, so inlining it is safe (SET takes no binds).
    const [, rows] = await opts.db.$transaction([
      opts.db.$executeRawUnsafe(`SET LOCAL statement_timeout = ${regexSearchTimeoutMs()}`),
      opts.db.$queryRawUnsafe<{ id: string; score: number }[]>(sql, ...params),
    ]);
    return rows.map((r) => ({ nodeId: r.id, score: Number(r.score) }));
  },

  async filterSearch(opts: FilterSearchOpts): Promise<string[]> {
    if (opts.memoryIds.length === 0) return [];
    const { params, bind } = paramBuilder();
    const memPh = opts.memoryIds.map((m) => bind(m)).join(', ');
    const deletedClause = opts.includeDeleted ? '' : 'AND deleted_at IS NULL';
    const filterSql = filterClause(opts.filter, bind);
    const orderBy = browseOrderByClause(opts.sort, opts.propertySort);
    const limitPh = bind(opts.limit);
    const offsetPh = bind(opts.offset ?? 0);
    const sql = `
      SELECT id
      FROM nodes
      WHERE memory_id IN (${memPh})
        ${deletedClause}${filterSql}
      ORDER BY ${orderBy}
      LIMIT ${limitPh} OFFSET ${offsetPh}
    `;
    const rows = await opts.db.$queryRawUnsafe<{ id: string }[]>(sql, ...params);
    return rows.map((r) => r.id);
  },

  async filterWhere(opts: FilterWhereOpts): Promise<string[]> {
    if (opts.ids.length === 0 || opts.memoryIds.length === 0) return [];
    const { params, bind } = paramBuilder();
    // Node ids are internal cuids, but bind them anyway (never interpolate).
    const idPh = opts.ids.map((id) => bind(id)).join(', ');
    const memPh = opts.memoryIds.map((m) => bind(m)).join(', ');
    const deletedClause = opts.includeDeleted ? '' : 'AND deleted_at IS NULL';
    const whereSql = compileNodeWhere(opts.where, bind);
    const sql = `
      SELECT id
      FROM nodes
      WHERE id IN (${idPh})
        AND memory_id IN (${memPh})
        ${deletedClause}
        AND (${whereSql})
    `;
    const rows = await opts.db.$queryRawUnsafe<{ id: string }[]>(sql, ...params);
    return rows.map((r) => r.id);
  },

  vectorSearch(opts: VectorSearchOpts): Promise<VectorHit[]> {
    return vectorSearchNodes(opts.db, {
      memoryIds: opts.memoryIds,
      queryEmbedding: opts.queryEmbedding,
      limit: opts.limit,
      onWindow: opts.onWindow,
      scope: opts.contentScope ?? 'CONTENT', // #1608: content by default for every caller
    });
  },

  vectorSearchChunks(opts: VectorSearchOpts): Promise<ChunkHit[]> {
    return vectorSearchChunks(opts.db, {
      memoryIds: opts.memoryIds,
      queryEmbedding: opts.queryEmbedding,
      limit: opts.limit,
      onWindow: opts.onWindow,
      scope: opts.contentScope ?? 'CONTENT', // #1608: content by default for every caller
    });
  },
};

/** The active provider (D14 seam — swap here to change backend). */
export function getRetrievalProvider(): NodeRetrievalProvider {
  return postgresRetrievalProvider;
}
