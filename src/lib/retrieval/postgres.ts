/**
 * Postgres implementation of the node retrieval seam (cor:rag:010:02).
 *
 * Lexical search rides the weighted `nodes.tsv` generated column
 * (see prisma/post-push.sql) + GIN index, ranked by `ts_rank_cd`
 * (field-weighted + length-normalized). Boolean operators are compiled to a
 * tsquery expression (tsquery.ts). Vector search delegates to the existing
 * pgvector helpers.
 */
import type {
  NodeRetrievalProvider,
  LexicalHit,
  LexicalSearchOpts,
  RegexSearchOpts,
  VectorSearchOpts,
} from './provider.js';
import type { VectorHit, ChunkHit } from '../../services/embedding/vectors.js';
import { vectorSearchNodes, vectorSearchChunks } from '../../services/embedding/vectors.js';
import { compileBooleanQuery } from './tsquery.js';

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
    // Prisma's $queryRawUnsafe doesn't bind JS arrays to float4[]/text[] params,
    // so inline the server-controlled weight floats as a literal and expand
    // memoryIds into scalar placeholders. Params: $1..$T leaf terms, then the
    // memoryIds, then the limit.
    const tsq = compileBooleanQuery(opts.query, 1);
    const t = tsq.params.length;
    const memPh = opts.memoryIds.map((_, i) => `$${t + 1 + i}`).join(', ');
    const limitPh = `$${t + 1 + opts.memoryIds.length}`;
    const weightsLit = `ARRAY[${weights.join(', ')}]::float4[]`;
    const deletedClause = opts.includeDeleted ? '' : 'AND deleted_at IS NULL';
    const sql = `
      SELECT id, ts_rank_cd(${weightsLit}, tsv, ${tsq.sql}) AS score
      FROM nodes
      WHERE tsv @@ ${tsq.sql}
        AND memory_id IN (${memPh})
        ${deletedClause}
      ORDER BY score DESC, loc ASC
      LIMIT ${limitPh}
    `;
    const rows = await opts.db.$queryRawUnsafe<{ id: string; score: number }[]>(
      sql, ...tsq.params, ...opts.memoryIds, opts.limit,
    );
    return rows.map((r) => ({ nodeId: r.id, score: Number(r.score) }));
  },

  async regexSearch(opts: RegexSearchOpts): Promise<LexicalHit[]> {
    if (opts.memoryIds.length === 0) return [];
    const fields = (opts.fields && opts.fields.length > 0 ? opts.fields : REGEX_DEFAULT_FIELDS)
      .filter((f) => REGEX_FIELD_SQL[f]);
    if (fields.length === 0) return [];
    // $1 memoryIds, $2 pattern, $3 limit. Match if any selected field matches;
    // score = highest matched field's weight class (a coarse relevance signal).
    // Params: $1 pattern, $2 limit, then $3.. memoryIds (see lexicalSearch note
    // on why memoryIds are scalar placeholders, not an array param).
    const classWeight = { A: CLASS_A, B: CLASS_B, C: CLASS_C, D: CLASS_D } as const;
    const matchExpr = fields.map((f) => `${REGEX_FIELD_SQL[f]} ~* $1`).join(' OR ');
    const scoreExpr = fields
      .map((f) => `CASE WHEN ${REGEX_FIELD_SQL[f]} ~* $1 THEN ${classWeight[FIELD_CLASS[f]]} ELSE 0 END`)
      .join(', ');
    const memPh = opts.memoryIds.map((_, i) => `$${3 + i}`).join(', ');
    const deletedClause = opts.includeDeleted ? '' : 'AND deleted_at IS NULL';
    const sql = `
      SELECT id, GREATEST(${scoreExpr}) AS score
      FROM nodes
      WHERE memory_id IN (${memPh})
        ${deletedClause}
        AND (${matchExpr})
      ORDER BY score DESC, loc ASC
      LIMIT $2
    `;
    const rows = await opts.db.$queryRawUnsafe<{ id: string; score: number }[]>(
      sql, opts.pattern, opts.limit, ...opts.memoryIds,
    );
    return rows.map((r) => ({ nodeId: r.id, score: Number(r.score) }));
  },

  vectorSearch(opts: VectorSearchOpts): Promise<VectorHit[]> {
    return vectorSearchNodes(opts.db, {
      memoryIds: opts.memoryIds,
      queryEmbedding: opts.queryEmbedding,
      limit: opts.limit,
    });
  },

  vectorSearchChunks(opts: VectorSearchOpts): Promise<ChunkHit[]> {
    return vectorSearchChunks(opts.db, {
      memoryIds: opts.memoryIds,
      queryEmbedding: opts.queryEmbedding,
      limit: opts.limit,
    });
  },
};

/** The active provider (D14 seam — swap here to change backend). */
export function getRetrievalProvider(): NodeRetrievalProvider {
  return postgresRetrievalProvider;
}
